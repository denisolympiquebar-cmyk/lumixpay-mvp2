/**
 * Push event handler — injected into the service worker via VitePWA's
 * `injectManifest` strategy. In `generateSW` mode (current), we instead
 * use importScripts or rely on VitePWA's additionalManifestEntries.
 *
 * For the `generateSW` strategy, push event handling is done by registering
 * a listener directly in the SW through VitePWA's `workbox.additionalManifestEntries`
 * is not possible. We instead use a separate `public/sw-push.js` that gets
 * merged via VitePWA's `strategies: 'injectManifest'` approach.
 *
 * Since we're using `generateSW`, add self.addEventListener('push') in the
 * custom service worker snippets. VitePWA exposes `workbox` config for this.
 *
 * This file documents the intent — actual SW push code lives in public/sw-push.js.
 */

export {};
