/**
 * Push notification helpers for the frontend.
 *
 * Flow:
 *   1. User clicks "Enable Push" button.
 *   2. browser prompts for Notification permission.
 *   3. Fetch VAPID public key from /api/push/vapid-public-key.
 *   4. Subscribe via PushManager.
 *   5. POST /api/push/subscribe with the subscription object.
 */

import { apiFetch } from "./api";

/** Convert a base64url string to a Uint8Array (required by PushManager.subscribe). */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from(rawData, (c) => c.charCodeAt(0));
}

export type PushUiStatus =
  | "UNSUPPORTED"
  | "PERMISSION_REQUIRED"
  | "BLOCKED"
  | "ENABLED"
  | "DISABLED";

async function ensureServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  if (!("serviceWorker" in navigator)) throw new Error("Service worker not supported");

  // Prefer any existing registration first.
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing) return existing;

  // Fallback: register explicitly (helps local dev if auto-registration timing is off).
  // VitePWA injectManifest output uses /service-worker.js in production builds.
  try {
    return await navigator.serviceWorker.register("/service-worker.js");
  } catch (e: any) {
    throw new Error(`Service worker registration failed: ${e?.message ?? String(e)}`);
  }
}

export async function getPushStatus(): Promise<PushUiStatus> {
  if (typeof window === "undefined") return "UNSUPPORTED";
  if (!("Notification" in window) || !("PushManager" in window) || !("serviceWorker" in navigator)) return "UNSUPPORTED";

  if (Notification.permission === "denied") return "BLOCKED";
  if (Notification.permission !== "granted") return "PERMISSION_REQUIRED";

  const reg = await ensureServiceWorkerRegistration();
  const sub = await reg.pushManager.getSubscription();
  return sub ? "ENABLED" : "DISABLED";
}

/**
 * Request permission and subscribe to push notifications.
 * Returns `true` on success, `false` if the user denied, throws on error.
 */
export async function subscribeToPush(token: string): Promise<boolean> {
  if (!("Notification" in window)) throw new Error("Notifications not supported");
  if (!("serviceWorker" in navigator)) throw new Error("Service worker not supported");
  if (!("PushManager" in window)) throw new Error("Push API not supported");

  // 1. Ask for permission
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return false;

  // 2. Get VAPID public key from backend
  const { vapidPublicKey } = await apiFetch<{ vapidPublicKey: string }>(
    "/push/vapid-public-key",
    null
  );
  if (!vapidPublicKey) throw new Error("Push is not configured on the server (missing VAPID public key)");

  // 3. Get service worker registration (VitePWA registers automatically, but be robust in dev)
  const registration = await ensureServiceWorkerRegistration();

  // 4. Subscribe
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });

  // 5. Send to backend
  const sub = subscription.toJSON() as {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };

  await apiFetch("/push/subscribe", token, {
    method: "POST",
    body: JSON.stringify({
      endpoint:  sub.endpoint,
      keys:      sub.keys,
      userAgent: navigator.userAgent,
    }),
  });

  return true;
}

/**
 * Unsubscribe from push notifications.
 */
export async function unsubscribeFromPush(token: string): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const registration = await ensureServiceWorkerRegistration();
  const sub = await registration.pushManager.getSubscription();
  if (!sub) return;

  await sub.unsubscribe();
  await apiFetch("/push/unsubscribe", token, {
    method: "POST",
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => {});
}

/** True if the user has already granted notification permission. */
export function pushEnabled(): boolean {
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}
