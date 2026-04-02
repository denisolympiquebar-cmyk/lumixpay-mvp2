import React from "react";
import { Link, useLocation } from "react-router-dom";
import "../landing.css";

// ─────────────────────────────────────────────────────────────────────────────
// useReveal — IntersectionObserver-based scroll-reveal hook
// Usage:
//   const r = useReveal();
//   <div ref={r.ref} className={r.cls("d2")}>…</div>
// ─────────────────────────────────────────────────────────────────────────────
export function useReveal(threshold = 0.1) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry?.isIntersecting) { setVisible(true); obs.disconnect(); } },
      { threshold }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);

  // cls — backward-compatible string (no delay) used by Pricing/Docs/Developers pages
  const cls = `reveal${visible ? " visible" : ""}`;
  // clsD — delay variant used by the new landing sections
  const clsD = (delay?: string) =>
    ["reveal", delay ?? "", visible ? "visible" : ""].filter(Boolean).join(" ");

  return { ref, cls, clsD, visible };
}

// ─────────────────────────────────────────────────────────────────────────────
// PublicNavbar
// ─────────────────────────────────────────────────────────────────────────────
function PublicNavbar() {
  const { pathname } = useLocation();
  const [open, setOpen]       = React.useState(false);
  const [scrolled, setScrolled] = React.useState(false);

  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Close mobile menu on route change
  React.useEffect(() => setOpen(false), [pathname]);

  const links: [string, string][] = [
    ["/",           "Home"],
    ["/pricing",    "Pricing"],
    ["/developers", "Developers"],
    ["/docs",       "Docs"],
  ];

  return (
    <>
      <nav className={`lp-nav${scrolled ? " lp-scrolled" : ""}`}>
        <Link to="/" className="lp-logo" aria-label="LumixPay home">
          <img src="/logo.png" alt="LumixPay" className="lp-logo-img" />
        </Link>

        <ul className="lp-links">
          {links.map(([to, label]) => (
            <li key={to}>
              <Link
                to={to}
                style={{ color: pathname === to ? "var(--lp-text)" : undefined }}
              >
                {label}
              </Link>
            </li>
          ))}
        </ul>

        <div className="lp-nav-actions">
          <Link to="/login" className="lp-nav-login">Login</Link>
          <Link to="/register" className="lp-btn-grad">Get Started</Link>
          <button
            className={`lp-burger${open ? " open" : ""}`}
            aria-label="Toggle menu"
            onClick={() => setOpen((o) => !o)}
          >
            <span /><span /><span />
          </button>
        </div>
      </nav>

      <div className={`lp-mobile-menu${open ? " open" : ""}`}>
        {links.map(([to, label]) => (
          <Link key={to} to={to} onClick={() => setOpen(false)}>{label}</Link>
        ))}
        <Link to="/login" onClick={() => setOpen(false)} style={{ marginTop: 4 }}>Login</Link>
        <Link to="/register" className="lp-btn-grad" onClick={() => setOpen(false)}>
          Get Started →
        </Link>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PublicFooter
// ─────────────────────────────────────────────────────────────────────────────
function PublicFooter() {
  return (
    <footer className="lp-footer">
      <div className="footer-top">
        <div>
          <Link to="/" className="lp-logo" aria-label="LumixPay home" style={{ textDecoration: "none" }}>
            <img src="/logo.png" alt="LumixPay" className="lp-logo-img" />
          </Link>
          <p className="footer-brand-desc">
            Programmable stablecoin infrastructure for payments, payouts and
            automated money flows on XRPL.
          </p>
          <div className="footer-status">
            <span className="status-dot" />
            Status: MVP — local mock provider
          </div>
        </div>

        <div className="footer-col">
          <h4>Product</h4>
          <ul>
            <li><Link to="/pricing">Pricing</Link></li>
            <li><Link to="/developers">Developers</Link></li>
            <li><Link to="/docs">Docs</Link></li>
            <li><Link to="/register">Get Started</Link></li>
          </ul>
        </div>

        <div className="footer-col">
          <h4>Developers</h4>
          <ul>
            <li><Link to="/docs">API Reference</Link></li>
            <li><Link to="/developers">Overview</Link></li>
            <li><Link to="/architecture">Architecture</Link></li>
            <li><Link to="/docs#webhooks">Webhooks</Link></li>
          </ul>
        </div>

        <div className="footer-col">
          <h4>Company</h4>
          <ul>
            <li><Link to="/demo">Live Demo</Link></li>
            <li><a href="#">About</a></li>
            <li><a href="#">GitHub</a></li>
            <li><a href="#">Privacy</a></li>
          </ul>
        </div>
      </div>

      <div className="footer-bottom">
        <p>© {new Date().getFullYear()} LumixPay. Built on XRPL stablecoins.</p>
        <p>RLUSD · EURQ · Programmable money</p>
      </div>
    </footer>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PublicLayout
// ─────────────────────────────────────────────────────────────────────────────
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="lp-root" style={{ minHeight: "100dvh", display: "flex", flexDirection: "column" }}>
      <PublicNavbar />
      <main style={{ flex: 1 }}>{children}</main>
      <PublicFooter />
    </div>
  );
}
