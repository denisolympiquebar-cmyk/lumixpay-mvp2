/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope;

// Workbox injects the precache manifest here at build time
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// ── Lifecycle: activate immediately ──────────────────────────────────────────
//
// Without skipWaiting() the new SW stays in "waiting" until every tab running
// the old SW is closed.  That makes navigator.serviceWorker.ready hang
// indefinitely, which breaks push-subscription setup.
//
// clients.claim() makes the freshly activated SW take control of this page
// immediately (without a reload) so pushManager.subscribe() sees an active SW.

self.addEventListener("install", (event) => {
  console.log("[SW] install — skipWaiting()");
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  console.log("[SW] activate — clients.claim()");
  event.waitUntil(self.clients.claim());
});

// ── Message: SKIP_WAITING (sent by Vite PWA autoUpdate injected code) ────────
// Vite PWA's registerType:"autoUpdate" + injectManifest sends this message to
// the waiting worker; handle it so the update lands without waiting for tabs.
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    console.log("[SW] SKIP_WAITING message received — skipWaiting()");
    void self.skipWaiting();
  }
});

// ── Push event handler ────────────────────────────────────────────────────────
self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload: { title?: string; body?: string; url?: string } = {};
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "LumixPay", body: event.data.text() };
  }

  const title   = payload.title ?? "LumixPay";
  const options: NotificationOptions = {
    body: payload.body ?? "",
    icon: "/pwa-192x192.png",
    badge: "/pwa-192x192.png",
    data: { url: payload.url ?? "/notifications" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ── Notification click — open or focus the app ────────────────────────────────
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl: string = (event.notification.data as any)?.url ?? "/notifications";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        const existing = clients.find((c) => c.url.includes(self.location.origin));
        if (existing) {
          return existing.focus().then((c) => c.navigate(targetUrl));
        }
        return self.clients.openWindow(targetUrl);
      })
  );
});
