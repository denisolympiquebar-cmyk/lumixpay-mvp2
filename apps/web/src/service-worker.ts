/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope;

// Workbox injects the precache manifest here at build time
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

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
