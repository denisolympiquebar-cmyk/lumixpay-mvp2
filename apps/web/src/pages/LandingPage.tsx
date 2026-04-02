import React from "react";
import { Link, useNavigate } from "react-router-dom";
import PublicLayout, { useReveal } from "../components/PublicLayout";
import { NetworkCanvas } from "../components/NetworkCanvas";
import { LoadingOverlay } from "../components/LoadingOverlay";

// ─────────────────────────────────────────────────────────────────────────────
// HeroSection
// ─────────────────────────────────────────────────────────────────────────────
function HeroSection() {
  const navigate = useNavigate();
  const heroRef = React.useRef<HTMLElement | null>(null);
  const leftRef = React.useRef<HTMLAnchorElement | null>(null);
  const rightRef = React.useRef<HTMLAnchorElement | null>(null);

  const [loading, setLoading] = React.useState(false);
  const [active, setActive] = React.useState<null | "left" | "right">(null); // which balloon is armed/dragged
  const [phase, setPhase] = React.useState<"idle" | "armed" | "dragging" | "burst">("idle");
  const [pos, setPos] = React.useState<{ left: { x: number; y: number }; right: { x: number; y: number } }>(() => ({
    left: { x: 0, y: 0 },
    right: { x: 0, y: 0 },
  }));
  const [stretch, setStretch] = React.useState<{ left: number; right: number }>({ left: 0, right: 0 });
  const [pressure, setPressure] = React.useState<{ left: number; right: number }>({ left: 0, right: 0 }); // 0..1 grows as we approach center
  const [inflation, setInflation] = React.useState<{ left: number; right: number }>({ left: 0, right: 0 }); // aggressive near-center expansion
  const [heroBurst, setHeroBurst] = React.useState<null | { id: number; x: number; y: number }>(null);
  const heroBurstId = React.useRef(1);
  const dragRef = React.useRef<{
    side: "left" | "right";
    pointerId: number;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
    startDist: number; // distance from balloon center to activation center at drag start
  } | null>(null);
  const centerZoneRef = React.useRef<{ x: number; y: number; r: number }>({ x: 0, y: 0, r: 74 });
  const [ripples, setRipples] = React.useState<Array<{ id: number; x: number; y: number; strong: boolean }>>([]);
  const rippleId = React.useRef(1);

  const prefersReducedMotion = React.useMemo(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
  }, []);

  const addRippleFrom = React.useCallback((el: HTMLElement | null, strong: boolean) => {
    const hero = heroRef.current;
    if (!hero || !el) return;
    const hb = hero.getBoundingClientRect();
    const eb = el.getBoundingClientRect();
    const x = (eb.left + eb.width / 2) - hb.left;
    const y = (eb.top + eb.height / 2) - hb.top;
    const id = rippleId.current++;
    setRipples((rs) => [...rs.slice(-3), { id, x, y, strong }]); // keep small for perf
    window.setTimeout(() => {
      setRipples((rs) => rs.filter((r) => r.id !== id));
    }, strong ? 1300 : 1600);
  }, []);

  // Center activation zone (invisible): recalculated on resize for responsiveness.
  React.useEffect(() => {
    const hero = heroRef.current;
    if (!hero) return;
    const update = () => {
      const hb = hero.getBoundingClientRect();
      const mobile = hb.width < 768;
      centerZoneRef.current = { x: hb.width / 2, y: hb.height / 2, r: mobile ? 60 : 78 };
    };
    update();
    window.addEventListener("resize", update, { passive: true });
    return () => window.removeEventListener("resize", update);
  }, []);

  // Idle ripples (soft, occasional) + gentle breathing is CSS-driven.
  React.useEffect(() => {
    if (prefersReducedMotion) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const loop = () => {
      t = setTimeout(() => {
        addRippleFrom(leftRef.current, false);
        window.setTimeout(() => addRippleFrom(rightRef.current, false), 650);
        loop();
      }, 5200 + Math.floor(Math.random() * 4200));
    };
    loop();
    return () => { if (t) clearTimeout(t); };
  }, [addRippleFrom, prefersReducedMotion]);

  const resetInteraction = React.useCallback(() => {
    dragRef.current = null;
    setPhase("idle");
    setActive(null);
    setStretch({ left: 0, right: 0 });
    setPressure({ left: 0, right: 0 });
    setInflation({ left: 0, right: 0 });
    setPos({ left: { x: 0, y: 0 }, right: { x: 0, y: 0 } });
  }, []);

  const isInCenterZone = React.useCallback((side: "left" | "right") => {
    const hero = heroRef.current;
    const el = side === "left" ? leftRef.current : rightRef.current;
    if (!hero || !el) return false;
    const hb = hero.getBoundingClientRect();
    const eb = el.getBoundingClientRect();
    const cx = (eb.left + eb.width / 2) - hb.left;
    const cy = (eb.top + eb.height / 2) - hb.top;
    const z = centerZoneRef.current;
    const dx = cx - z.x;
    const dy = cy - z.y;
    return (dx * dx + dy * dy) <= (z.r * z.r);
  }, []);

  const commitBurstAndNavigate = React.useCallback((side: "left" | "right") => {
    setPhase("burst");
    // Let the giant-bubble burst complete before starting the loading overlay.
    window.setTimeout(() => setLoading(true), 900);
    window.setTimeout(() => {
      navigate(side === "left" ? "/register" : "/login");
    }, 1180);
  }, [navigate]);

  const onBalloonPointerDown = (side: "left" | "right", e: React.PointerEvent<HTMLAnchorElement>) => {
    // fallback: allow normal navigation when reduced motion requested
    if (prefersReducedMotion) return;
    if (loading) return;
    e.preventDefault();

    const el = side === "left" ? leftRef.current : rightRef.current;
    if (!el) return;

    setActive(side);
    setPhase("armed");
    setInflation((i) => ({ ...i, [side]: 0 }));
    addRippleFrom(el, true); // strong hero-wide ripple on press/tap

    try { el.setPointerCapture(e.pointerId); } catch {}

    // Compute initial distance to center zone for progressive growth mapping
    const hero = heroRef.current;
    const hb = hero?.getBoundingClientRect();
    const eb = el.getBoundingClientRect();
    const cx = hb ? (eb.left + eb.width / 2) - hb.left : 0;
    const cy = hb ? (eb.top + eb.height / 2) - hb.top : 0;
    const z = centerZoneRef.current;
    const dx0 = cx - z.x;
    const dy0 = cy - z.y;
    const startDist = Math.max(1, Math.sqrt(dx0 * dx0 + dy0 * dy0));

    dragRef.current = {
      side,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      baseX: pos[side].x,
      baseY: pos[side].y,
      startDist,
    };
  };

  const onBalloonPointerMove = (e: React.PointerEvent<HTMLAnchorElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (phase === "burst") return;
    setPhase("dragging");

    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    setPos((p) => ({ ...p, [d.side]: { x: d.baseX + dx, y: d.baseY + dy } }));

    const mag = Math.min(1, Math.sqrt(dx * dx + dy * dy) / 240);
    setStretch((s) => ({ ...s, [d.side]: mag }));

    // Pressure growth: increases as balloon approaches activation zone center
    const hero = heroRef.current;
    const el = d.side === "left" ? leftRef.current : rightRef.current;
    if (hero && el) {
      const hb = hero.getBoundingClientRect();
      const eb = el.getBoundingClientRect();
      const cx = (eb.left + eb.width / 2) - hb.left;
      const cy = (eb.top + eb.height / 2) - hb.top;
      const z = centerZoneRef.current;
      const dxC = cx - z.x;
      const dyC = cy - z.y;
      const dist = Math.sqrt(dxC * dxC + dyC * dyC);
      const progress = 1 - Math.min(1, dist / d.startDist); // 0 far → 1 near
      // Start visible growth immediately from first drag movement.
      const eased = Math.pow(progress, 0.88);
      setPressure((p) => ({ ...p, [d.side]: eased }));

      // Final inflation phase starts earlier, then ramps sharply near center.
      const near = Math.max(0, (progress - 0.48) / 0.52); // 0..1 from mid-drag onward
      const inflated = Math.pow(near, 2.25);
      setInflation((i) => ({ ...i, [d.side]: inflated }));
    }

    if (isInCenterZone(d.side)) {
      dragRef.current = null;
      setStretch((s) => ({ ...s, [d.side]: 0 }));
      setPressure((p) => ({ ...p, [d.side]: 1 }));
      setInflation((i) => ({ ...i, [d.side]: 1 }));

      // Fire a dedicated burst in the visual center of the hero (not at the balloon's last pixel)
      const z = centerZoneRef.current;
      const id = heroBurstId.current++;
      setHeroBurst({ id, x: z.x, y: z.y });
      window.setTimeout(() => {
        setHeroBurst((b) => (b?.id === id ? null : b));
      }, 900);

      commitBurstAndNavigate(d.side);
    }
  };

  const balloonVars = (side: "left" | "right") => {
    const p = side === "left" ? pressure.left : pressure.right;
    const st = side === "left" ? stretch.left : stretch.right;
    const inf = side === "left" ? inflation.left : inflation.right;
    const x = side === "left" ? pos.left.x : pos.right.x;
    const y = side === "left" ? pos.left.y : pos.right.y;

    const sx = (1 + st * 0.10 + p * 0.34) * (1 + inf * 10.8);
    const sy = (1 - st * 0.04 + p * 0.30) * (1 + inf * 10.4);

    return {
      ["--dx" as any]: `${x}px`,
      ["--dy" as any]: `${y}px`,
      ["--sx" as any]: String(sx),
      ["--sy" as any]: String(sy),
      ["--tsx" as any]: String(1 / sx), // inverse scales keep label visually constant
      ["--tsy" as any]: String(1 / sy),
      ["--inflate" as any]: String(inf),
    };
  };

  const onBalloonPointerUp = (e: React.PointerEvent<HTMLAnchorElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    const side = d.side;

    if (phase === "burst") return;
    setStretch((s) => ({ ...s, [side]: 0 }));
    setPressure((p) => ({ ...p, [side]: 0 }));

    if (isInCenterZone(side)) {
      commitBurstAndNavigate(side);
      return;
    }

    // Not activated: return to origin and reset (no loading, no navigation).
    // User can try again with a fresh tap+drag gesture.
    setPos((p) => ({ ...p, [side]: { x: 0, y: 0 } }));
    setInflation((i) => ({ ...i, [side]: 0 }));
    setActive(null);
    setPhase("idle");
  };

  return (
    <section className="lp-hero" ref={(n) => { heroRef.current = n; }}>
      {/* Network particle background */}
      <NetworkCanvas />
      <div className="hero-grid" />
      <div className="hero-orb hero-orb-1" />
      <div className="hero-orb hero-orb-2" />
      <div className="hero-orb hero-orb-3" />

      {/* Hero-wide ripple field (visual only; never blocks content) */}
      <div className="hero-ripple-field" aria-hidden="true">
        {ripples.map((r) => (
          <span
            key={r.id}
            className={`hero-ripple-field-wave${r.strong ? " strong" : ""}`}
            style={{ left: r.x, top: r.y }}
          />
        ))}
        {heroBurst ? (
          <span className="hero-burst" style={{ left: heroBurst.x, top: heroBurst.y }} />
        ) : null}
      </div>

      {/* Water balloon CTAs (overlay; does not alter hero layout/typography) */}
      <div className={`hero-water-ctas${loading ? " disabled" : ""}`} aria-hidden={loading ? "true" : "false"}>
        <Link
          to="/register"
          ref={leftRef}
          className={`water-balloon left${active === "left" ? " active" : ""} phase-${phase}${active === "left" && phase === "dragging" && pressure.left > 0.62 ? " pressurized" : ""}${active === "left" && phase === "dragging" && inflation.left > 0.15 ? " flooding" : ""}`}
          style={balloonVars("left")}
          // Critical: a click/tap alone must NEVER navigate.
          // Navigation is only triggered programmatically after drag-to-center burst.
          onClick={(e) => e.preventDefault()}
          onPointerDown={(e) => onBalloonPointerDown("left", e)}
          onPointerMove={onBalloonPointerMove}
          onPointerUp={onBalloonPointerUp}
          onPointerCancel={onBalloonPointerUp}
          aria-label="Ripple here to get started"
        >
          <span className="wb-shimmer" aria-hidden="true" />
          <span className="wb-highlight" aria-hidden="true" />
          <span className="wb-text">Ripple here to get started</span>
          <span className="wb-arrow" aria-hidden="true">→</span>
          <span className="wb-burst" aria-hidden="true" />
        </Link>

        <Link
          to="/login"
          ref={rightRef}
          className={`water-balloon right${active === "right" ? " active" : ""} phase-${phase}${active === "right" && phase === "dragging" && pressure.right > 0.62 ? " pressurized" : ""}${active === "right" && phase === "dragging" && inflation.right > 0.15 ? " flooding" : ""}`}
          style={balloonVars("right")}
          // Critical: a click/tap alone must NEVER navigate.
          // Navigation is only triggered programmatically after drag-to-center burst.
          onClick={(e) => e.preventDefault()}
          onPointerDown={(e) => onBalloonPointerDown("right", e)}
          onPointerMove={onBalloonPointerMove}
          onPointerUp={onBalloonPointerUp}
          onPointerCancel={onBalloonPointerUp}
          aria-label="Ripple here to login"
        >
          <span className="wb-shimmer" aria-hidden="true" />
          <span className="wb-highlight" aria-hidden="true" />
          <span className="wb-text">Ripple here to login</span>
          <span className="wb-arrow" aria-hidden="true">←</span>
          <span className="wb-burst" aria-hidden="true" />
        </Link>
      </div>

      <div className="hero-content">
        <div className="hero-badge">
          <span className="badge-dot" />
          Built on XRPL stablecoins · RLUSD &amp; EURQ
        </div>

        <h1 className="hero-h1">
          <span className="grad-text">Programmable</span>
          <br />
          Stablecoin Payout Infrastructure
        </h1>

        <p className="hero-sub">
          Payments, payouts and programmable money flows for apps,
          platforms and global projects — powered by XRPL stablecoins.
        </p>

        <div className="hero-ctas">
          <Link to="/register" className="btn-primary">
            Start Building →
          </Link>
          <Link to="/docs" className="btn-outline">
            Explore Docs
          </Link>
        </div>

        <p style={{ marginTop: 20, fontSize: ".85rem", color: "var(--lp-sub)", letterSpacing: ".02em" }}>
          Marketplaces • Communities • SaaS platforms • Global teams
        </p>
        <p style={{ marginTop: 8, fontSize: ".78rem", color: "var(--lp-sub)", opacity: 0.6, letterSpacing: ".04em", textTransform: "uppercase" }}>
          Infrastructure for XRPL stablecoin adoption
        </p>
      </div>

      <div className="hero-scroll">
        <div className="scroll-line" />
        scroll
      </div>

      {/* Existing loading overlay — used as the post-burst transition */}
      <LoadingOverlay visible={loading} />
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// StatsBar
// ─────────────────────────────────────────────────────────────────────────────
function StatsBar() {
  const stats = [
    { val: "< 1s", lbl: "Transaction Finality"         },
    { val: "1%",   lbl: "Flat Fee — No Hidden Costs"   },
    { val: "2",    lbl: "Stablecoins Supported"        },
    { val: "∞",    lbl: "Programmable Money Flows"     },
  ];
  return (
    <div>
      <div className="lp-stats">
        {stats.map((s) => (
          <div className="stat-item" key={s.lbl}>
            <div className="stat-val">{s.val}</div>
            <div className="stat-lbl">{s.lbl}</div>
          </div>
        ))}
      </div>
      <p style={{ textAlign: "center", marginTop: 16, fontSize: ".78rem", color: "var(--lp-sub)", opacity: 0.55, letterSpacing: ".03em" }}>
        Designed for programmable payments and stablecoin operations.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FeatureSection  (For Consumers)
// ─────────────────────────────────────────────────────────────────────────────
const consumerCards = [
  { icon: "⚡", title: "Instant Transfers",      desc: "Send RLUSD or EURQ to any user by ID, username, or QR code — settle in under a second.",            tag: "live" },
  { icon: "🔗", title: "Payment Links",          desc: "Create a shareable link with a fixed amount and note. Anyone can pay you in one tap.",              tag: "live" },
  { icon: "🔁", title: "Recurring Payments",     desc: "Set up subscriptions, rent, or allowances. Charges run automatically on a weekly or monthly schedule.", tag: "live" },
  { icon: "🎟", title: "Voucher Payments",        desc: "Buy, send or redeem voucher codes for instant stablecoin balance. Perfect for promotions, rewards, gift cards or offline distribution.", tag: "live" },
  { icon: "👥", title: "Contacts",               desc: "Save frequent recipients with nicknames for one-tap transfers. No more pasting long IDs.",           tag: "live" },
  { icon: "🔔", title: "Real-time Notifications",desc: "Instant push alerts whenever money moves — top-up, received, withdrawal approved.",                 tag: "live" },
];

function FeatureSection() {
  const header = useReveal();
  const grid   = useReveal();
  return (
    <section className="lp-section lp-section-alt">
      <div className="lp-container">
        <div ref={header.ref} className={header.cls}>
          <div className="section-eyebrow">For Consumers</div>
          <h2 className="section-h2">
            Send money like a <em>message</em>
          </h2>
          <p className="section-lead">
            Everything your users need to send, receive and manage stablecoins —
            from a simple balance top-up to fully automated recurring flows.
          </p>
        </div>

        <div ref={grid.ref}>
          <div className="feat-grid">
            {consumerCards.map((c, i) => (
              <div
                key={c.title}
                className={`feat-card reveal${grid.visible ? " visible" : ""}`}
                style={{ transitionDelay: `${i * 0.08}s` }}
              >
                <div className="feat-icon">{c.icon}</div>
                <div className="feat-title">{c.title}</div>
                <div className="feat-desc">{c.desc}</div>
                <span className={`feat-tag ${c.tag === "live" ? "tag-live" : "tag-soon"}`}>
                  {c.tag === "live" ? "● Live" : "Coming soon"}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Onboarding explanation block */}
        <div className="section-info-block" style={{ marginTop: 48, padding: "28px 32px", background: "rgba(124,58,237,.07)", border: "1px solid rgba(124,58,237,.18)", borderRadius: 16 }}>
          <div className="section-eyebrow" style={{ marginBottom: 10 }}>Simple onboarding — no crypto knowledge required</div>
          <p className="section-lead" style={{ maxWidth: 680, marginBottom: 0 }}>
            Users can fund their LumixPay balance using simple top-ups or voucher codes.
            Once funds are available, they can send payments, create payment links or automate recurring transfers — all without managing blockchain wallets.
          </p>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DeveloperSection
// ─────────────────────────────────────────────────────────────────────────────
const devItems = [
  { icon: "🔌", title: "RESTful API",       desc: "JWT-authenticated endpoints for every money operation. Consistent JSON responses, Zod-validated inputs." },
  { icon: "⚙",  title: "Webhooks",          desc: "Real-time event delivery to your endpoint. HMAC-SHA256 signed payloads, with retry and delivery logs." },
  { icon: "🔑", title: "API Keys",          desc: "Scoped API keys for programmatic access. Revoke at any time. Key shown once — stored as SHA-256 hash." },
  { icon: "📦", title: "Payment Links",     desc: "Create payment links programmatically. Fixed or flexible amounts, expiry, max-use limits." },
  { icon: "🔁", title: "Recurring Billing", desc: "Subscribe users to plans. Charge weekly or monthly with idempotent keys to prevent double-charges." },
  { icon: "🎟", title: "Voucher API",       desc: "Generate and distribute vouchers for promotions, rewards or gift cards." },
];

function DeveloperSection() {
  const header = useReveal();
  const left   = useReveal();
  const right  = useReveal();

  return (
    <section className="lp-section">
      <div className="lp-container">
        <div ref={header.ref} className={header.cls}>
          <div className="section-eyebrow">For Developers</div>
          <h2 className="section-h2">
            Embed stablecoin payments in <em>minutes</em>
          </h2>
          <p className="section-lead">
            A clean REST API, real-time webhooks, and API keys —
            everything you need to embed stablecoin payments into any app.
          </p>
          <div style={{ display: "flex", gap: 12, marginTop: 24, flexWrap: "wrap" }}>
            <Link to="/docs"         className="btn-outline" style={{ fontSize: ".85rem", padding: "8px 18px" }}>API Reference →</Link>
            <Link to="/architecture" className="btn-outline" style={{ fontSize: ".85rem", padding: "8px 18px" }}>Architecture</Link>
          </div>
        </div>

        <div className="dev-split">
          <div ref={left.ref} className={left.cls}>
            <div className="dev-items">
              {devItems.map((d) => (
                <div className="dev-item" key={d.title}>
                  <div className="dev-icon">{d.icon}</div>
                  <div>
                    <div className="dev-item-title">{d.title}</div>
                    <div className="dev-item-desc">{d.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div ref={right.ref} className={right.clsD("d2")}>
            <div className="code-win">
              <div className="code-bar">
                <span className="dot-r" /><span className="dot-y" /><span className="dot-g" />
                <span className="code-fname">transfer.ts</span>
              </div>
              <pre className="code-body"><code
>{`// Send stablecoins via LumixPay REST API
`}<span className="ck">const</span>{` response = `}<span className="ck">await</span>{` `}<span className="cf">fetch</span>{`(
  `}<span className="cs">"/api/transfers"</span>{`, {
    method: `}<span className="cs">"POST"</span>{`,
    headers: {
      `}<span className="cs">"Content-Type"</span>{`: `}<span className="cs">"application/json"</span>{`,
      `}<span className="cs">"Authorization"</span>{`: `}<span className="cs">{"`Bearer ${token}`"}</span>{`,
    },
    body: `}<span className="cf">JSON.stringify</span>{`({
      to_user_id:   `}<span className="cs">"&lt;uuid&gt;"</span>{`,
      asset_id:     `}<span className="cs">"&lt;rlusd-id&gt;"</span>{`,
      gross_amount: `}<span className="cn">25</span>{`,  `}<span className="cm">// $25.00 RLUSD</span>{`
    }),
  },
);

`}<span className="cm">// {"→ { transfer: { net_amount: '24.75' } }"}</span>{`
`}<span className="ck">const</span>{` { transfer } = `}<span className="ck">await</span>{` response.`}<span className="cf">json</span>{`();`}</code></pre>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// UseCasesSection
// ─────────────────────────────────────────────────────────────────────────────
const useCaseCards = [
  { icon: "🏗", title: "Platforms",           desc: "Embedded payouts for marketplaces and apps — orchestrate who gets paid, when, and why." },
  { icon: "🧰", title: "Gig economy",         desc: "Automate contractor payouts with programmable rules, audit trails and operational controls." },
  { icon: "🌍", title: "Grants & NGOs",       desc: "Distribute funds globally with transparent ledger accounting, reporting and voucher distribution." },
  { icon: "🎨", title: "Creator platforms",   desc: "Handle subscriptions, tips and revenue sharing with predictable fees and instant settlement." },
];

function UseCasesSection() {
  const header = useReveal();
  const grid   = useReveal();
  return (
    <section className="lp-section lp-section-alt">
      <div className="lp-container">
        <div ref={header.ref} className={header.cls}>
          <div className="section-eyebrow">Use cases</div>
          <h2 className="section-h2">
            Built for many <em>platforms</em>
          </h2>
          <p className="section-lead">
            LumixPay can power payments across many types of platforms.
          </p>
        </div>

        <div ref={grid.ref}>
          <div className="feat-grid">
            {useCaseCards.map((c, i) => (
              <div
                key={c.title}
                className={`feat-card reveal${grid.visible ? " visible" : ""}`}
                style={{ transitionDelay: `${i * 0.08}s` }}
              >
                <div className="feat-icon">{c.icon}</div>
                <div className="feat-title">{c.title}</div>
                <div className="feat-desc">{c.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BusinessSection
// ─────────────────────────────────────────────────────────────────────────────
function BusinessSection() {
  const header = useReveal();
  const bento  = useReveal();

  const escrowRows = [
    { label: "User → Escrow lock",  status: "completed", cls: "mp-green"  },
    { label: "Admin review",        status: "pending",   cls: "mp-yellow" },
    { label: "On-chain settlement", status: "queued",    cls: "mp-blue"   },
  ];

  return (
    <section className="lp-section lp-section-alt">
      <div className="lp-container">
        <div ref={header.ref} className={header.cls}>
          <div className="section-eyebrow">For Businesses</div>
          <h2 className="section-h2">
            Automate your <em>payment flows</em>
          </h2>
          <p className="section-lead">
            From e-commerce checkout to automated payouts — compose complex
            financial logic with simple API calls.
          </p>
        </div>

        <div ref={bento.ref} className={bento.cls}>
          <div className="bento">
            <div className="bento-card bc-wide">
              <div className="bc-eyebrow">Escrow &amp; Settlement</div>
              <div className="bc-title">Withdrawal review system</div>
              <div className="bc-desc">
                High-risk withdrawals can require manual approval before settlement, providing an additional layer of operational security.
                On-chain settlement via XRPL in Phase 2. Every step recorded in the immutable ledger.
                Roadmap: multi-party approvals for institutional payout programs.
              </div>
              <div className="mock-ui">
                <div className="mock-header"><span>Step</span><span>Status</span></div>
                {escrowRows.map((r) => (
                  <div className="mock-row" key={r.label}>
                    <span>{r.label}</span>
                    <span className={`mock-pill ${r.cls}`}>{r.status}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="bento-card bc-slim">
              <div className="bc-eyebrow">Accounting</div>
              <div className="bc-title">Double-entry ledger</div>
              <div className="bc-desc">
                Every debit has a matching credit. Immutable journal. Balances always reconcile.
              </div>
              <div className="bc-metric">∞</div>
              <div style={{ fontSize: ".78rem", color: "var(--lp-sub)" }}>
                ledger entries — never modified
              </div>
            </div>

            <div className="bento-card bc-third">
              <div className="bc-eyebrow">Multi-asset</div>
              <div className="bc-title">RLUSD &amp; EURQ</div>
              <div className="bc-desc">
                Every account, balance and ledger row is asset-aware.
                New stablecoins added without schema changes.
              </div>
            </div>
            <div className="bento-card bc-third">
              <div className="bc-eyebrow">Fee Engine</div>
              <div className="bc-title">1% flat fee</div>
              <div className="bc-desc">
                Charged at ledger level on topup, transfer and voucher redemption.
                Fee collector account visible in the ledger at all times.
              </div>
            </div>
            <div className="bento-card bc-third">
              <div className="bc-eyebrow">Idempotency</div>
              <div className="bc-title">Safe retries</div>
              <div className="bc-desc">
                Every ledger write carries a unique idempotency key.
                Retrying an operation never produces duplicate entries.
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AdminSection
// ─────────────────────────────────────────────────────────────────────────────
function AdminSection() {
  const header = useReveal();
  const bento  = useReveal();

  const txRows = [
    { type: "Transfer",   amount: "+24.75 RLUSD", cls: "mp-green"  },
    { type: "Topup",      amount: "+99.00 RLUSD", cls: "mp-green"  },
    { type: "Withdrawal", amount: "−50.00 RLUSD", cls: "mp-yellow" },
    { type: "Voucher",    amount: "+20.00 EURQ",  cls: "mp-blue"   },
  ];
  const userRows = [
    { email: "alice@acme.io",   role: "user",  cls: "mp-green" },
    { email: "dev@startup.io",  role: "admin", cls: "mp-blue"  },
    { email: "bob@example.com", role: "user",  cls: "mp-green" },
  ];

  return (
    <section className="lp-section">
      <div className="lp-container">
        <div ref={header.ref} className={header.cls}>
          <div className="section-eyebrow">Operational Infrastructure</div>
          <h2 className="section-h2">
            Full visibility &amp; <em>control</em>
          </h2>
          <p className="section-lead">
            LumixPay includes built-in operational controls for monitoring transactions,
            managing treasury inventory and reviewing withdrawals when required.
          </p>
        </div>

        <div ref={bento.ref} className={bento.cls}>
          <div className="bento">
            <div className="bento-card bc-half">
              <div className="bc-eyebrow">Real-time transaction monitoring</div>
              <div className="bc-title">Live ledger view</div>
              <div className="mock-ui">
                <div className="mock-header"><span>Type</span><span>Amount</span></div>
                {txRows.map((r) => (
                  <div className="mock-row" key={r.type}>
                    <span>{r.type}</span>
                    <span className={`mock-pill ${r.cls}`}
                          style={{ fontFamily: "monospace", fontSize: ".74rem" }}>
                      {r.amount}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="bento-card bc-half">
              <div className="bc-eyebrow">Account oversight</div>
              <div className="bc-title">Search &amp; inspect any account</div>
              <div className="mock-ui">
                <div className="mock-header"><span>Email</span><span>Role</span></div>
                {userRows.map((r) => (
                  <div className="mock-row" key={r.email}>
                    <span style={{ fontSize: ".76rem" }}>{r.email}</span>
                    <span className={`mock-pill ${r.cls}`}>{r.role}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="bento-card bc-third">
              <div className="bc-eyebrow">Voucher distribution management</div>
              <div className="bc-title">Create &amp; track codes</div>
              <div className="bc-desc">
                Generate secure random codes. Set asset, amount and expiry.
                Track redemptions in real time.
              </div>
            </div>
            <div className="bento-card bc-third">
              <div className="bc-eyebrow">Withdrawal review queue</div>
              <div className="bc-title">Approve or reject</div>
              <div className="bc-desc">
                Review pending withdrawals with full ledger context.
                Approve to advance to on-chain settlement.
              </div>
            </div>
            <div className="bento-card bc-third">
              <div className="bc-eyebrow">Developer API oversight</div>
              <div className="bc-title">API key management</div>
              <div className="bc-desc">
                Users create scoped API keys from the developer dashboard.
                Admin can audit usage and revoke any key.
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SecuritySection
// ─────────────────────────────────────────────────────────────────────────────
const securityCards = [
  { icon: "📒", title: "Immutable Ledger",       desc: "Every transaction is recorded in a double-entry ledger ensuring full auditability." },
  { icon: "🏦", title: "Treasury Controls",       desc: "Stablecoin issuance is strictly limited by treasury inventory controls." },
  { icon: "🔁", title: "Idempotent Operations",   desc: "Every write operation includes an idempotency key preventing duplicate transactions." },
  { icon: "📡", title: "Real-time Monitoring",    desc: "Operational alerts and monitoring tools help maintain platform integrity." },
];

function SecuritySection() {
  const header = useReveal();
  const grid   = useReveal();
  return (
    <section className="lp-section lp-section-alt">
      <div className="lp-container">
        <div ref={header.ref} className={header.cls}>
          <div className="section-eyebrow">Security &amp; Trust</div>
          <h2 className="section-h2">
            Secure and auditable <em>by design</em>
          </h2>
          <p className="section-lead" style={{ marginTop: 10, maxWidth: 720 }}>
            Designed for payout infrastructure: immutable ledger accounting, strict treasury inventory controls,
            operational review flows, and real-time monitoring. Compliance-ready by construction (audit trails,
            idempotent operations, and clear system boundaries).
          </p>
        </div>

        <div ref={grid.ref}>
          <div className="feat-grid">
            {securityCards.map((c, i) => (
              <div
                key={c.title}
                className={`feat-card reveal${grid.visible ? " visible" : ""}`}
                style={{ transitionDelay: `${i * 0.08}s` }}
              >
                <div className="feat-icon">{c.icon}</div>
                <div className="feat-title">{c.title}</div>
                <div className="feat-desc">{c.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// StepCard — isolated component so useReveal isn't called inside a loop
// ─────────────────────────────────────────────────────────────────────────────
function StepCard({ n, title, desc, delay }: { n: string; title: string; desc: string; delay: string }) {
  const r = useReveal();
  return (
    <div ref={r.ref} className={r.clsD(delay)}>
      <div className="feat-card" style={{ padding: "32px 28px" }}>
        <div style={{
          fontSize: "2.8rem", fontWeight: 700, letterSpacing: "-.03em",
          background: "linear-gradient(135deg, rgba(124,58,237,.35), rgba(59,130,246,.25))",
          WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
          backgroundClip: "text", marginBottom: 16,
        }}>{n}</div>
        <div className="feat-title" style={{ fontSize: "1.1rem", marginBottom: 10 }}>{title}</div>
        <div className="feat-desc">{desc}</div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HowItWorks
// ─────────────────────────────────────────────────────────────────────────────
const steps = [
  { n: "01", title: "Top up",          desc: "Add RLUSD or EURQ to your LumixPay balance using a simple top-up or voucher. Funds are available in milliseconds." },
  { n: "02", title: "Send or Request", desc: "Transfer instantly to any username, create a payment link, or set up a recurring subscription — all via API or UI." },
  { n: "03", title: "Withdraw or settle", desc: "Move funds to an external wallet when needed or keep them inside LumixPay for ongoing payments. On-chain XRPL settlement is planned for Phase 2 of LumixPay." },
];

function HowItWorks() {
  const header = useReveal();
  return (
    <section className="lp-section lp-section-alt">
      <div className="lp-container">
        <div style={{ textAlign: "center", marginBottom: 56 }} ref={header.ref} className={header.cls}>
          <div className="section-eyebrow" style={{ justifyContent: "center" }}>How it works</div>
          <h2 className="section-h2">Three steps to <em>programmable money</em></h2>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 20 }}>
          {steps.map((s, i) => (
            <StepCard key={s.n} {...s} delay={`d${i + 1}`} />
          ))}
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CTASection
// ─────────────────────────────────────────────────────────────────────────────
function CTASection() {
  const r = useReveal();
  return (
    <section className="lp-cta">
      <div className="cta-glow" />
      <div ref={r.ref} className={r.cls} style={{ position: "relative" }}>
        <h2 className="cta-h2">
          Build with{" "}
          <span className="grad-text">LumixPay</span>
        </h2>
        <p className="cta-sub">
          Add programmable stablecoin payments, vouchers and automated transfers to your app in minutes.
          Open API, transparent fees, full ledger auditability.
        </p>
        <div className="cta-btns">
          <Link to="/register" className="btn-primary">
            Create Free Account →
          </Link>
          <Link to="/demo" className="btn-outline">
            Try Demo
          </Link>
          <Link to="/docs" className="btn-outline">
            API Docs
          </Link>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LandingPage
// ─────────────────────────────────────────────────────────────────────────────
export default function LandingPage() {
  return (
    <PublicLayout>
      <HeroSection />
      <StatsBar />
      <FeatureSection />
      <DeveloperSection />
      <UseCasesSection />
      <BusinessSection />
      <AdminSection />
      <SecuritySection />
      <HowItWorks />
      <CTASection />
    </PublicLayout>
  );
}
