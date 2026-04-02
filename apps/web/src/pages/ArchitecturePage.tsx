import React from "react";
import { Link } from "react-router-dom";
import PublicLayout, { useReveal } from "../components/PublicLayout";

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: "0.72rem", fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase",
      color: "var(--accent-h)", marginBottom: 10,
    }}>{children}</div>
  );
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: "var(--surface)",
      border: "1px solid var(--border)",
      borderRadius: 14,
      padding: "24px 28px",
      ...style,
    }}>
      {children}
    </div>
  );
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontWeight: 700, fontSize: "1rem", marginBottom: 8 }}>{children}</div>;
}

function CardDesc({ children }: { children: React.ReactNode }) {
  return <div style={{ color: "var(--muted)", fontSize: "0.87rem", lineHeight: 1.65 }}>{children}</div>;
}

// ─────────────────────────────────────────────────────────────────────────────
// ArchitecturePage
// ─────────────────────────────────────────────────────────────────────────────
export default function ArchitecturePage() {
  const hero  = useReveal();
  const flow  = useReveal();
  const s1    = useReveal();
  const s2    = useReveal();
  const s3    = useReveal();
  const s4    = useReveal();
  const s5    = useReveal();

  const stackItems = [
    {
      layer: "Frontend",
      tech:  "React · Vite · Vercel",
      icon:  "🌐",
      desc:  "A React SPA served as a static PWA on Vercel. Installable on Android and iOS. Real-time updates via Server-Sent Events. Offline-capable service worker with push notification support.",
    },
    {
      layer: "API",
      tech:  "Node.js · Express · Fly.io",
      icon:  "⚙️",
      desc:  "A stateless REST API built with Express and TypeScript. Deployed on Fly.io. All business logic lives here: ledger writes, treasury checks, fee collection, idempotency enforcement and rate limiting.",
    },
    {
      layer: "Database",
      tech:  "PostgreSQL · Supabase / Neon",
      icon:  "🗄️",
      desc:  "All persistent state lives in PostgreSQL. Tables are versioned via sequential SQL migrations. Connection pooling is handled by the pg driver. No ORM — raw parameterised queries only.",
    },
    {
      layer: "Auth",
      tech:  "JWT · bcrypt",
      icon:  "🔐",
      desc:  "Stateless JWT authentication. Passwords hashed with bcrypt (12 rounds). Tokens carry user ID and role. Middleware validates and injects auth on every protected route.",
    },
    {
      layer: "XRPL Settlement",
      tech:  "Phase 2 — roadmap",
      icon:  "🔗",
      desc:  "On-chain XRPL settlement is planned for Phase 2. The ledger model, withdrawal escrow flow and XRPL destination address fields are already designed to support it. Phase 1 uses an internal mock settlement layer.",
    },
  ];

  const ledgerRows = [
    { type: "topup",              debit: "FLOAT",       credit: "User account", note: "Mock card provider → user balance" },
    { type: "transfer",           debit: "Sender",      credit: "Recipient",    note: "P2P — no new supply created"       },
    { type: "fee",                debit: "Sender",      credit: "feeCollector", note: "1% platform fee on all flows"      },
    { type: "withdrawal_lock",    debit: "User account",credit: "escrow",       note: "Funds locked on withdrawal request" },
    { type: "withdrawal_settle",  debit: "escrow",      credit: "FLOAT",        note: "Admin approves → on-chain Phase 2" },
    { type: "fx_conversion",      debit: "From account",credit: "To account",   note: "Rate sourced from fx_rates table"  },
  ];

  return (
    <PublicLayout>
      {/* Hero */}
      <section className="lp-page-hero lp-section-sm">
        <div className="lp-container">
          <div ref={hero.ref} className={hero.cls}>
            <span className="lp-badge">Architecture</span>
            <h1 className="lp-h2-hero">How LumixPay is built</h1>
            <p style={{ color: "var(--muted)", fontSize: "1.05rem", maxWidth: 600, lineHeight: 1.7, marginTop: 4 }}>
              LumixPay is programmable stablecoin infrastructure — an API-first platform
              built on a double-entry ledger with treasury controls, real-time updates,
              and a clean path to on-chain XRPL settlement.
            </p>
          </div>
        </div>
      </section>

      <section className="lp-section" style={{ paddingTop: 48, paddingBottom: 80 }}>
        <div className="lp-container" style={{ maxWidth: 900 }}>

          {/* ── Flow diagram ── */}
          <div ref={flow.ref} className={flow.cls} style={{ marginBottom: 64 }}>
            <SectionLabel>System flow</SectionLabel>
            <div style={{
              background: "rgba(0,0,0,.3)",
              border: "1px solid var(--border)",
              borderRadius: 16,
              padding: "36px 24px",
              textAlign: "center",
              fontFamily: "monospace",
              fontSize: "0.9rem",
              lineHeight: 2.2,
              color: "var(--muted)",
            }}>
              {[
                { label: "User / External App",         color: "var(--text)",     bold: true },
                { label: "↓",                           color: "var(--muted)"             },
                { label: "LumixPay Web  ·  PWA",        color: "#60a5fa"                  },
                { label: "↓",                           color: "var(--muted)"             },
                { label: "LumixPay REST API  (Fly.io)", color: "#a78bfa",         bold: true },
                { label: "↓",                           color: "var(--muted)"             },
                { label: "Ledger  ·  Treasury  ·  Notifications  ·  SSE", color: "#34d399" },
                { label: "↓",                           color: "var(--muted)"             },
                { label: "PostgreSQL  (Supabase / Neon)", color: "#fbbf24",       bold: true },
                { label: "↓",                           color: "var(--muted)"             },
                { label: "XRPL settlement layer  (Phase 2)", color: "#f87171"             },
              ].map((row, i) => (
                <div key={i} style={{ color: row.color, fontWeight: row.bold ? 700 : 400 }}>
                  {row.label}
                </div>
              ))}
            </div>
          </div>

          {/* ── Off-chain ledger + on-chain settlement model ── */}
          <div style={{ marginBottom: 60 }}>
            <SectionLabel>Execution model</SectionLabel>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <Card>
                <CardTitle>Off-chain ledger (Phase 1 execution)</CardTitle>
                <CardDesc>
                  LumixPay executes payouts and transfers using a double-entry ledger in PostgreSQL. This provides deterministic accounting,
                  atomicity, and easy reconciliation for institutional reporting. Balances are a derived read model kept in sync inside the
                  same transaction as every ledger write.
                </CardDesc>
              </Card>
              <Card>
                <CardTitle>On-chain settlement (Phase 2 settlement)</CardTitle>
                <CardDesc>
                  XRPL settlement is designed as a modular provider that executes approved withdrawals and stamps settlement metadata
                  (submitted/confirmed timestamps, transaction hash). This separation makes “approval = intent” and “settlement = execution”
                  explicit and audit-friendly.
                </CardDesc>
              </Card>
            </div>
            <div style={{ marginTop: 16 }}>
              <Card>
                <CardTitle>Trust &amp; auditability</CardTitle>
                <CardDesc>
                  LumixPay is built so a reviewer can audit money flows end-to-end:
                  immutable ledger entries, strict idempotency on mutation endpoints, and operator controls for treasury and withdrawal review.
                  This is the foundation for compliance readiness (clear boundaries, operational logs, and reconciliation primitives).
                </CardDesc>
              </Card>
            </div>
          </div>

          {/* ── Stack layers ── */}
          <div ref={s1.ref} className={s1.cls} style={{ marginBottom: 60 }}>
            <SectionLabel>Technology stack</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {stackItems.map((item) => (
                <Card key={item.layer} style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 20, alignItems: "start" }}>
                  <div style={{ fontSize: "2rem", lineHeight: 1 }}>{item.icon}</div>
                  <div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 800, fontSize: "0.95rem" }}>{item.layer}</span>
                      <span style={{ fontSize: "0.78rem", color: "var(--muted)", fontFamily: "monospace" }}>{item.tech}</span>
                    </div>
                    <CardDesc>{item.desc}</CardDesc>
                  </div>
                </Card>
              ))}
            </div>
          </div>

          {/* ── Ledger model ── */}
          <div ref={s2.ref} className={s2.cls} style={{ marginBottom: 60 }}>
            <SectionLabel>Ledger model</SectionLabel>
            <h2 style={{ fontWeight: 800, fontSize: "1.2rem", marginBottom: 10 }}>Double-entry accounting</h2>
            <p style={{ color: "var(--muted)", fontSize: "0.9rem", lineHeight: 1.7, marginBottom: 24 }}>
              Every money movement creates an immutable <code style={{ color: "var(--accent-h)" }}>ledger_entries</code> row
              with a debit account and a credit account. Balances are a denormalized view kept in sync within
              the same database transaction. The ledger is never modified — only appended.
            </p>
            <div style={{ border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 2fr", background: "rgba(255,255,255,.04)", padding: "10px 16px", fontSize: "0.75rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em" }}>
                <span>Entry type</span><span>Debit</span><span>Credit</span><span>Description</span>
              </div>
              {ledgerRows.map((r, i) => (
                <div key={r.type} style={{
                  display: "grid", gridTemplateColumns: "1fr 1fr 1fr 2fr",
                  padding: "10px 16px", fontSize: "0.83rem",
                  borderTop: i === 0 ? "1px solid var(--border)" : "1px solid rgba(255,255,255,.04)",
                  alignItems: "center",
                }}>
                  <code style={{ color: "var(--accent-h)", fontSize: "0.78rem" }}>{r.type}</code>
                  <span style={{ color: "var(--muted)" }}>{r.debit}</span>
                  <span style={{ color: "var(--muted)" }}>{r.credit}</span>
                  <span style={{ color: "var(--muted)", fontSize: "0.8rem" }}>{r.note}</span>
                </div>
              ))}
            </div>
          </div>

          {/* ── Treasury + Safety ── */}
          <div ref={s3.ref} className={s3.cls} style={{ marginBottom: 60 }}>
            <SectionLabel>Treasury controls</SectionLabel>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              {[
                { title: "Inventory model", desc: "Treasury limits track max_supply and current_supply per asset. Top-ups and voucher redemptions check and decrement current_supply inside the same DB transaction using SELECT FOR UPDATE." },
                { title: "Idempotency keys", desc: "All mutation endpoints accept an Idempotency-Key header. Duplicate requests replay the original response. Conflicting keys (same key, different payload) return HTTP 409." },
                { title: "Rate limiting", desc: "Auth endpoints are strictly rate-limited. Mutation endpoints have a moderate limit. All limits return { error: 'RATE_LIMITED' } with HTTP 429." },
                { title: "Frozen accounts", desc: "Admins can freeze user accounts. Frozen users cannot perform topups, transfers, withdrawals, voucher purchases or FX conversions. The frozen check runs as Express middleware." },
              ].map((item) => (
                <Card key={item.title}>
                  <CardTitle>{item.title}</CardTitle>
                  <CardDesc>{item.desc}</CardDesc>
                </Card>
              ))}
            </div>
          </div>

          {/* ── Real-time + Push ── */}
          <div ref={s4.ref} className={s4.cls} style={{ marginBottom: 60 }}>
            <SectionLabel>Real-time &amp; push</SectionLabel>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              {[
                { title: "Server-Sent Events", desc: "GET /stream provides a persistent SSE connection per authenticated user. Events: balances.updated, notifications.unread, activity.new. Admin stream at /stream/admin." },
                { title: "Push notifications", desc: "Web Push via VAPID. Users subscribe from the dashboard. The backend stores PushSubscription objects and delivers notifications via the web-push library on every NotificationService.create() call." },
                { title: "Webhooks", desc: "Developers register HTTPS endpoints. Events are delivered as HMAC-SHA256 signed POST requests. Delivery history and last status are tracked per webhook." },
                { title: "Recurring billing", desc: "A background job runs on startup and at intervals. It processes active recurring plans, executes scheduled charges, and fires notifications on success or failure." },
              ].map((item) => (
                <Card key={item.title}>
                  <CardTitle>{item.title}</CardTitle>
                  <CardDesc>{item.desc}</CardDesc>
                </Card>
              ))}
            </div>
          </div>

          {/* ── API-first design ── */}
          <div ref={s5.ref} className={s5.cls}>
            <SectionLabel>API-first design</SectionLabel>
            <Card style={{ marginBottom: 32 }}>
              <CardTitle>Embed LumixPay into any app</CardTitle>
              <CardDesc>
                Every feature available in the LumixPay web UI is also available via the REST API.
                Developers can create API keys from the developer dashboard, register webhook endpoints,
                and programmatically trigger topups, transfers, voucher distributions, recurring plans
                and payment links — all with idempotency guarantees.
              </CardDesc>
            </Card>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <Link to="/docs"       className="lp-btn lp-btn-primary">API Reference →</Link>
              <Link to="/developers" className="lp-btn lp-btn-ghost">Developers overview</Link>
              <Link to="/demo"       className="lp-btn lp-btn-ghost">Try demo</Link>
            </div>
          </div>

        </div>
      </section>
    </PublicLayout>
  );
}
