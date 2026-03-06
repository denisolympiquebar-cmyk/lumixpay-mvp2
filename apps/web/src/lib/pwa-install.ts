/**
 * PWA install helper.
 *
 * Usage:
 *   import { canInstall, promptInstall, isIos, isInStandaloneMode } from "./pwa-install";
 *
 * The `beforeinstallprompt` event is captured as soon as this module is imported.
 */

let _deferredPrompt: BeforeInstallPromptEvent | null = null;

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

// Capture the install prompt immediately when the module loads
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    _deferredPrompt = e as BeforeInstallPromptEvent;
    // Dispatch a custom event so components that mount later can react
    window.dispatchEvent(new Event("pwa-install-available"));
  });

  window.addEventListener("appinstalled", () => {
    _deferredPrompt = null;
    window.dispatchEvent(new Event("pwa-installed"));
  });
}

/** True if the browser has captured a deferred install prompt (Chrome/Edge/Android). */
export function canInstall(): boolean {
  return _deferredPrompt !== null;
}

/**
 * Show the native install dialog.
 * Returns `"accepted"` | `"dismissed"` | `"unavailable"`.
 */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  if (!_deferredPrompt) return "unavailable";
  await _deferredPrompt.prompt();
  const { outcome } = await _deferredPrompt.userChoice;
  _deferredPrompt = null;
  return outcome;
}

/** Detects iOS Safari (no beforeinstallprompt support). */
export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

/** True when running as an installed PWA (standalone or fullscreen). */
export function isInStandaloneMode(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as any).standalone === true
  );
}
