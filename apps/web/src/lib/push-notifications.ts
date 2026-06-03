/**
 * Push notification helpers for the frontend.
 *
 * Flow:
 *   1. User clicks "Enable Push" button.
 *   2. Browser prompts for Notification permission.
 *   3. Fetch VAPID public key from /api/push/vapid-public-key.
 *   4. Clear any stale existing subscription.
 *   5. Subscribe via PushManager (requires activated SW).
 *   6. POST /api/push/subscribe with the subscription object.
 */

import { apiFetch } from "./api";

// ── Diagnostic logger ─────────────────────────────────────────────────────────
const LOG  = (...a: unknown[]) => console.log( "[Push]", ...a);
const WARN = (...a: unknown[]) => console.warn( "[Push]", ...a);
const ERR  = (...a: unknown[]) => console.error("[Push]", ...a);

// ── Browser detection (best-effort) ──────────────────────────────────────────
function detectBrowser(): string {
  const ua = navigator.userAgent;
  if ((navigator as any).brave) return "Brave";
  if (ua.includes("Edg/"))    return "Edge";
  if (ua.includes("Firefox/")) return "Firefox";
  if (ua.includes("Chrome/"))  return "Chrome";
  if (ua.includes("Safari/") && !ua.includes("Chrome/")) return "Safari";
  return "Unknown";
}

// ── VAPID key conversion ──────────────────────────────────────────────────────

/** Convert a base64url string to a Uint8Array (required by PushManager.subscribe). */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64  = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from(rawData, (c) => c.charCodeAt(0));
}

/**
 * Validate and convert VAPID public key string → Uint8Array.
 * An uncompressed P-256 public key must be exactly 65 bytes.
 * Throws with a clear message if the key is absent or malformed.
 */
function vapidKeyToBytes(key: string): Uint8Array {
  if (!key || typeof key !== "string" || key.trim().length < 10) {
    throw new Error(
      `VAPID public key is missing or too short (got: ${JSON.stringify(key)}). ` +
      "Ensure VITE_API_BASE is set and the backend VAPID_PUBLIC_KEY env var is configured."
    );
  }
  const trimmed = key.trim();
  LOG(`VAPID key: ${trimmed.length} chars, prefix="${trimmed.substring(0, 8)}…"`);

  const bytes = urlBase64ToUint8Array(trimmed);
  LOG(`VAPID key decoded: ${bytes.length} bytes (expect 65 for P-256 uncompressed)`);

  if (bytes.length !== 65) {
    WARN(
      `VAPID key decoded to ${bytes.length} bytes — expected 65. ` +
      "The key is likely truncated or malformed in the environment variable."
    );
  }
  return bytes;
}

// ── Service worker readiness ──────────────────────────────────────────────────

/**
 * Returns a *fully activated* service worker registration.
 *
 * IMPORTANT: navigator.serviceWorker.getRegistration() can return a SW
 * that is still "installing" or "waiting", which causes pushManager.subscribe()
 * to throw AbortError. navigator.serviceWorker.ready only resolves once a SW
 * has reached "activated" state — this is the correct gate for push.
 *
 * If there is already a waiting or installing SW we kick it with SKIP_WAITING
 * so it activates immediately instead of blocking indefinitely.
 */
async function getActiveSWRegistration(): Promise<ServiceWorkerRegistration> {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service workers are not supported in this browser");
  }

  LOG("Waiting for navigator.serviceWorker.ready…");

  // Probe current registration state and unblock a stuck worker before
  // waiting on navigator.serviceWorker.ready.
  try {
    const current = await navigator.serviceWorker.getRegistration();
    if (current) {
      LOG(`SW registration found — installing: ${current.installing?.state ?? "none"} | waiting: ${current.waiting?.state ?? "none"} | active: ${current.active?.state ?? "none"}`);

      if (current.installing) {
        LOG("SW is still installing — navigator.serviceWorker.ready will resolve once installation completes.");
      }

      if (current.waiting) {
        // A new SW finished installing but is blocked behind the old active one.
        // Sending SKIP_WAITING triggers skipWaiting() inside the service worker,
        // which allows it to activate immediately.
        LOG("SW is in waiting state — sending SKIP_WAITING to unblock activation…");
        current.waiting.postMessage({ type: "SKIP_WAITING" });
        LOG("SKIP_WAITING sent.");
      }

      if (current.active) {
        LOG(`SW active: state=${current.active.state}`);
      }
    } else {
      WARN("No service worker registration found for this origin yet.");
    }
  } catch (probeErr) {
    WARN("Could not probe SW registration state (non-fatal):", probeErr);
  }

  const reg = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) =>
      setTimeout(async () => {
        // Emit detailed state before rejecting so the error is diagnosable.
        try {
          const r = await navigator.serviceWorker.getRegistration();
          ERR("SW ready timed out after 20 s. Registration state:", {
            installing: r?.installing?.state ?? "none",
            waiting:    r?.waiting?.state    ?? "none",
            active:     r?.active?.state     ?? "none",
            scope:      r?.scope             ?? "(no registration)",
          });
        } catch {
          ERR("SW ready timed out after 20 s. Could not inspect registration state.");
        }
        reject(new Error("Service worker ready timed out after 20 s"));
      }, 20_000)
    ),
  ]);

  const sw = reg.active;
  LOG(`SW ready resolved — state: ${sw?.state ?? "none"} | scope: ${reg.scope}`);
  LOG(`SW controller: ${navigator.serviceWorker.controller ? "active" : "NOT controlling page (first load?)"}`);

  if (!sw || sw.state !== "activated") {
    throw new Error(
      `Service worker is not yet activated (state: ${sw?.state ?? "none"}). ` +
      "Try refreshing the page and clicking Enable Push again."
    );
  }

  return reg;
}

// ── Public API ────────────────────────────────────────────────────────────────

export type PushUiStatus =
  | "UNSUPPORTED"
  | "PERMISSION_REQUIRED"
  | "BLOCKED"
  | "ENABLED"
  | "DISABLED";

export async function getPushStatus(): Promise<PushUiStatus> {
  if (typeof window === "undefined") return "UNSUPPORTED";
  if (
    !("Notification" in window) ||
    !("PushManager" in window) ||
    !("serviceWorker" in navigator)
  ) return "UNSUPPORTED";

  if (Notification.permission === "denied")   return "BLOCKED";
  if (Notification.permission !== "granted")  return "PERMISSION_REQUIRED";

  try {
    const reg = await getActiveSWRegistration();
    const sub = await reg.pushManager.getSubscription();
    return sub ? "ENABLED" : "DISABLED";
  } catch {
    return "DISABLED";
  }
}

/**
 * Request permission and subscribe to push notifications.
 * Returns `true` on success, `false` if the user denied permission.
 * Throws on hard errors (VAPID misconfiguration, SW not ready, etc.).
 */
export async function subscribeToPush(token: string): Promise<boolean> {
  LOG("=== subscribeToPush() start ===");
  LOG(`Browser    : ${detectBrowser()}`);
  LOG(`User-Agent : ${navigator.userAgent}`);

  const isIosPlatform = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone  =
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as any).standalone === true;

  LOG(`Platform   : ${isIosPlatform ? "iOS" : "non-iOS"}`);
  LOG(`Standalone : ${isStandalone}`);
  LOG(`Permission : ${typeof Notification !== "undefined" ? Notification.permission : "N/A"}`);

  // iOS Web Push only works when the app is installed to the home screen (standalone).
  // In Safari browser mode the PushManager.subscribe() call hits APNs and always returns
  // AbortError — bail early with a clear user-facing message instead of letting it fail.
  if (isIosPlatform && !isStandalone) {
    throw new Error(
      'Push notifications on iPhone/iPad require the app to be installed. ' +
      'Open this page in Safari, tap the Share icon, then tap "Add to Home Screen". ' +
      'After launching from your home screen you can enable push from the Notifications page.'
    );
  }

  if (!("Notification"   in window))    throw new Error("Notifications not supported in this browser");
  if (!("serviceWorker"  in navigator)) throw new Error("Service workers not supported in this browser");
  if (!("PushManager"    in window))    throw new Error("Push API not supported in this browser");

  // ── Step 1: Permission ──────────────────────────────────────────────────────
  LOG("Step 1 — Requesting notification permission…");
  const permission = await Notification.requestPermission();
  LOG(`Permission result: "${permission}"`);
  if (permission !== "granted") {
    LOG("Permission not granted — aborting push setup.");
    return false;
  }

  // ── Step 2: Fetch VAPID key from backend ───────────────────────────────────
  LOG("Step 2 — Fetching VAPID public key from /push/vapid-public-key…");
  let vapidPublicKey: string;
  try {
    const resp = await apiFetch<{ vapidPublicKey: string }>("/push/vapid-public-key", null);
    vapidPublicKey = resp?.vapidPublicKey ?? "";
    LOG(`VAPID key received: ${vapidPublicKey ? "yes" : "MISSING/EMPTY"}`);
  } catch (fetchErr) {
    ERR("Failed to fetch VAPID public key from backend:", fetchErr);
    throw new Error("Could not load push configuration from server. Is the API reachable?");
  }

  if (!vapidPublicKey) {
    ERR("Backend returned an empty VAPID key — VAPID_PUBLIC_KEY env var is likely unset on the server.");
    throw new Error("Push is not configured on the server (missing VAPID public key).");
  }

  // ── Step 3: Convert VAPID key ──────────────────────────────────────────────
  LOG("Step 3 — Converting VAPID key to Uint8Array…");
  let applicationServerKey: Uint8Array;
  try {
    applicationServerKey = vapidKeyToBytes(vapidPublicKey);
  } catch (convErr) {
    ERR("VAPID key conversion error:", convErr);
    throw convErr;
  }

  // ── Step 4: Get active service worker registration ─────────────────────────
  LOG("Step 4 — Getting active service worker registration…");
  let registration: ServiceWorkerRegistration;
  try {
    registration = await getActiveSWRegistration();
    LOG(`SW registration OK — scope: ${registration.scope}`);
  } catch (swErr) {
    ERR("Could not get active service worker:", swErr);
    throw swErr;
  }

  // ── Step 5: Clear any stale subscription ───────────────────────────────────
  LOG("Step 5 — Checking for stale existing push subscription…");
  try {
    const stale = await registration.pushManager.getSubscription();
    if (stale) {
      LOG(`Stale subscription found (${stale.endpoint.substring(0, 55)}…), unsubscribing first…`);
      await stale.unsubscribe();
      LOG("Stale subscription cleared.");
    } else {
      LOG("No existing subscription.");
    }
  } catch (clearErr) {
    WARN("Could not clear stale subscription (non-fatal, continuing):", clearErr);
  }

  // ── Step 6: Subscribe (with single AbortError retry) ──────────────────────
  // AbortError from FCM/APNs can happen even after step-5 cleanup because the
  // browser's push-service deregistration is async server-side; calling subscribe()
  // immediately can hit a stale FCM state.  On first AbortError we do one more
  // cleanup pass, wait 600 ms, then retry — no further retries.
  LOG("Step 6 — Calling pushManager.subscribe()…");
  const subOpts = { userVisibleOnly: true as const, applicationServerKey };

  // null until successfully subscribed; subscribeErr captures the last failure.
  let subscription: PushSubscription | null = null;
  let subscribeErr: any = null;

  try {
    subscription = await registration.pushManager.subscribe(subOpts);
    LOG("pushManager.subscribe() succeeded (attempt 1)!");
    LOG(`Endpoint: ${subscription.endpoint.substring(0, 65)}…`);
  } catch (firstErr: any) {
    ERR("pushManager.subscribe() FAILED (attempt 1)");
    ERR("  error.name    :", firstErr?.name);
    ERR("  error.message :", firstErr?.message);

    if (firstErr?.name === "AbortError") {
      WARN("AbortError on attempt 1 — clearing residual push state, waiting 600 ms, then retrying once…");
      try {
        const residual = await registration.pushManager.getSubscription();
        if (residual) {
          LOG(`Residual subscription found — unsubscribing (${residual.endpoint.substring(0, 55)}…)…`);
          await residual.unsubscribe();
          LOG("Residual subscription cleared.");
        } else {
          LOG("No residual subscription found during retry cleanup.");
        }
      } catch (cleanErr) {
        WARN("Could not clear residual subscription (non-fatal):", cleanErr);
      }
      await new Promise<void>((r) => setTimeout(r, 600));
      try {
        LOG("Retrying pushManager.subscribe()…");
        subscription = await registration.pushManager.subscribe(subOpts);
        LOG("Retry succeeded!");
        LOG(`Endpoint: ${subscription.endpoint.substring(0, 65)}…`);
      } catch (retryErr: any) {
        ERR("pushManager.subscribe() FAILED (retry / attempt 2)");
        ERR("  error.name    :", retryErr?.name);
        ERR("  error.message :", retryErr?.message);
        subscribeErr = retryErr;
      }
    } else {
      subscribeErr = firstErr;
    }
  }

  if (!subscription) {
    const subErr = subscribeErr;
    ERR("pushManager.subscribe() exhausted all attempts — giving up");
    ERR(`  isIosPlatform : ${isIosPlatform} | isStandalone : ${isStandalone}`);
    ERR(`  VAPID key byte length : ${applicationServerKey.length} (must be 65)`);
    ERR("  full error:", subErr);

    if (subErr?.name === "AbortError") {
      ERR(
        "AbortError diagnosis: browser push service (FCM/APNs) rejected registration.\n" +
        "  • Chrome/Android: ensure Google Play Services is current; try on a different network.\n" +
        "  • Brave: brave://settings/privacy → enable 'Use Google services for push messaging'.\n" +
        "  • VAPID key rotation invalidates all existing subscriptions — re-subscribe after rotation.\n" +
        `  • VAPID key byte length: ${applicationServerKey.length} (must be 65)\n` +
        `  • iOS: ${isIosPlatform} | standalone: ${isStandalone}`
      );
      const userMsg = isIosPlatform
        ? "Push subscription failed on iOS. Ensure you are running iOS 16.4+, using Safari, and that notifications are allowed in iOS Settings → Safari → [this site]."
        : "The browser's push service rejected the subscription. " +
          "In Brave, enable 'Use Google services for push messaging' in brave://settings/privacy. " +
          "On Android, ensure Google Play Services is up to date. " +
          "Try again on a stable connection.";
      throw new Error(userMsg);
    }

    if (subErr?.name === "NotSupportedError") {
      ERR("NotSupportedError: PushManager unavailable — is the page served over HTTPS?");
      throw new Error("Push is not supported here (requires HTTPS). Try Chrome or Firefox on a secure connection.");
    }
    if (subErr?.name === "InvalidStateError") {
      ERR("InvalidStateError: SW registered but not controlling the page — try a hard reload.");
      throw new Error("Service worker not ready. Close all tabs for this site, reopen, and try again.");
    }
    if (subErr?.name === "NotAllowedError") {
      ERR("NotAllowedError: browser denied push subscription.");
      throw new Error("Browser denied push access. Check that notifications are allowed in your browser and OS settings.");
    }
    throw new Error(
      `Push subscription failed [${subErr?.name ?? "Error"}]: ${subErr?.message ?? "unknown reason"}.`
    );
  }

  // ── Step 7: Register subscription with backend ────────────────────────────
  LOG("Step 7 — Sending subscription to backend /push/subscribe…");
  const sub = subscription.toJSON() as {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };

  try {
    await apiFetch("/push/subscribe", token, {
      method: "POST",
      body: JSON.stringify({
        endpoint:  sub.endpoint,
        keys:      sub.keys,
        userAgent: navigator.userAgent,
      }),
    });
    LOG("Backend subscription saved successfully.");
  } catch (backendErr) {
    ERR("Backend /push/subscribe failed:", backendErr);
    throw backendErr;
  }

  LOG("=== subscribeToPush() complete — SUCCESS ===");
  return true;
}

/**
 * Unsubscribe from push notifications.
 */
export async function unsubscribeFromPush(token: string): Promise<void> {
  LOG("unsubscribeFromPush() start");
  if (!("serviceWorker" in navigator)) return;

  try {
    const registration = await getActiveSWRegistration();
    const sub = await registration.pushManager.getSubscription();
    if (!sub) {
      LOG("No active subscription to remove.");
      return;
    }
    await sub.unsubscribe();
    LOG("Browser-side unsubscribe OK.");
    await apiFetch("/push/unsubscribe", token, {
      method: "POST",
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch((err) => WARN("Backend unsubscribe failed (non-fatal):", err));
    LOG("unsubscribeFromPush() complete.");
  } catch (err) {
    ERR("unsubscribeFromPush() error:", err);
  }
}

/** True if the user has already granted notification permission. */
export function pushEnabled(): boolean {
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}
