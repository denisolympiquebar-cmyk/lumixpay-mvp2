import React from "react";
import "./LoadingOverlay.css";

interface Props {
  /** When false the overlay fades out and unmounts. */
  visible: boolean;
}

/**
 * Full-screen boot splash / loading overlay.
 * Shown while the app resolves the auth token and loads initial data.
 * Fades out smoothly then unmounts.
 */
export function LoadingOverlay({ visible }: Props) {
  const [mounted, setMounted] = React.useState(visible);

  React.useEffect(() => {
    if (visible) {
      setMounted(true);
    } else {
      // Keep rendered during the fade-out animation (300 ms)
      const t = setTimeout(() => setMounted(false), 350);
      return () => clearTimeout(t);
    }
  }, [visible]);

  if (!mounted) return null;

  return (
    <div className={`lp-overlay${visible ? "" : " lp-overlay--hidden"}`}>
      {/* Animated background orbs */}
      <div className="lp-overlay__orb lp-overlay__orb--1" />
      <div className="lp-overlay__orb lp-overlay__orb--2" />

      <div className="lp-overlay__center">
        {/* Logo */}
        <img
          src="/logo.png"
          alt="LumixPay"
          className="lp-overlay__logo-img"
        />

        {/* Spinner ring */}
        <div className="lp-overlay__spinner" aria-label="Loading…" />

        <p className="lp-overlay__hint">Loading…</p>
      </div>
    </div>
  );
}
