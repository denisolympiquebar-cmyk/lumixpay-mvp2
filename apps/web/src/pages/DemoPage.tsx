import React from "react";
import { Link } from "react-router-dom";
import PublicLayout, { useReveal } from "../components/PublicLayout";

export default function DemoPage() {
  const hero  = useReveal();
  const s1    = useReveal();
  const s2    = useReveal();
  const s3    = useReveal();

  const cardStyle: React.CSSProperties = {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 16,
    padding: "28px 32px",
    marginBottom: 20,
  };

  return (
    <PublicLayout>
      {/* Hero */}
      <section className="lp-page-hero lp-section-sm">
        <div className="lp-container">
          <div ref={hero.ref} className={hero.cls}>
            <span className="lp-badge">Live Demo</span>
            <h1 className="lp-h2-hero">Try LumixPay</h1>
            <p style={{ color: "var(--muted)", fontSize: "1.05rem", maxWidth: 580, lineHeight: 1.7, marginTop: 4 }}>
              Explore the full LumixPay interface — send payments, create payment links,
              manage vouchers and inspect the ledger in a live environment.
            </p>
            <div style={{ marginTop: 14, fontSize: "0.85rem", color: "#34d399", fontWeight: 700, letterSpacing: ".02em" }}>
              ● Live MVP running
            </div>
            <div style={{ display: "flex", gap: 12, marginTop: 28, flexWrap: "wrap" }}>
              <Link to="/register" className="lp-btn lp-btn-primary">Create free account →</Link>
              <Link to="/login"    className="lp-btn lp-btn-ghost">Sign in</Link>
            </div>
          </div>
        </div>
      </section>

      {/* What you can explore */}
      <section className="lp-section" style={{ paddingTop: 48 }}>
        <div className="lp-container" style={{ maxWidth: 820 }}>

          <div ref={s1.ref} className={s1.cls}>
            <h2 style={{ fontWeight: 800, fontSize: "1.5rem", letterSpacing: "-0.03em", marginBottom: 8 }}>
              What you can explore
            </h2>
            <p style={{ color: "var(--muted)", marginBottom: 32, lineHeight: 1.7, fontSize: "0.95rem" }}>
              LumixPay is live and functional. Register a free account to access the full platform.
            </p>

            <div style={{ ...cardStyle, background: "rgba(124,58,237,.07)", border: "1px solid rgba(124,58,237,.22)" }}>
              <div style={{ fontWeight: 800, marginBottom: 8 }}>What is simulated vs. real?</div>
              <div style={{ color: "var(--muted)", fontSize: "0.92rem", lineHeight: 1.7 }}>
                <strong>Real:</strong> the double-entry ledger, balances, fees, treasury inventory enforcement, idempotency, admin review flows, and persistent history in PostgreSQL.
                <br />
                <strong>Simulated (MVP):</strong> card top-ups use a mock provider, and XRPL on-chain settlement is planned for Phase 2 (withdrawals are reviewed and prepared for settlement).
              </div>
            </div>

            {[
              { icon: "⚡", title: "Balances & Top-ups",       desc: "Fund your account using the mock top-up flow. Try RLUSD and EURQ." },
              { icon: "🔁", title: "Transfers",                desc: "Send stablecoins between accounts by user ID or username." },
              { icon: "🔗", title: "Payment Links",            desc: "Generate a shareable payment link with a fixed amount and note." },
              { icon: "🎟", title: "Voucher System",           desc: "Buy, redeem and distribute voucher codes for instant balance." },
              { icon: "🔁", title: "Recurring Payments",       desc: "Create subscription plans and billing schedules." },
              { icon: "💱", title: "FX Conversion",            desc: "Convert between RLUSD and EURQ at the live platform rate." },
              { icon: "🔑", title: "Developer API Keys",       desc: "Generate API keys and register webhooks from the developer panel." },
              { icon: "📡", title: "Real-time Updates",        desc: "Balances, notifications and activity update live via SSE." },
            ].map((item) => (
              <div key={item.title} style={{ ...cardStyle, display: "flex", gap: 20, alignItems: "flex-start" }}>
                <div style={{ fontSize: "1.5rem", lineHeight: 1, flexShrink: 0 }}>{item.icon}</div>
                <div>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>{item.title}</div>
                  <div style={{ color: "var(--muted)", fontSize: "0.9rem", lineHeight: 1.6 }}>{item.desc}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Demo account */}
          <div ref={s2.ref} className={s2.cls} style={{ marginTop: 48 }}>
            <div style={{
              background: "rgba(124,58,237,.07)",
              border: "1px solid rgba(124,58,237,.22)",
              borderRadius: 16,
              padding: "32px 36px",
            }}>
              <div style={{ fontWeight: 800, fontSize: "1.15rem", marginBottom: 12 }}>
                Demo account
              </div>
              <p style={{ color: "var(--muted)", lineHeight: 1.7, fontSize: "0.93rem", marginBottom: 20 }}>
                A shared demo account is available on request for partners, grant evaluators and integration teams
                who want to explore the platform without creating their own account.
              </p>
              <div style={{
                background: "rgba(0,0,0,0.25)",
                borderRadius: 10,
                padding: "16px 20px",
                fontFamily: "monospace",
                fontSize: "0.88rem",
                color: "var(--muted)",
                marginBottom: 20,
              }}>
                Demo credentials: available on request
              </div>
              <a
                href="mailto:demo@lumixpay.com"
                className="lp-btn lp-btn-ghost"
                style={{ display: "inline-block" }}
              >
                Request demo access →
              </a>
            </div>
          </div>

          {/* Admin view */}
          <div ref={s3.ref} className={s3.cls} style={{ marginTop: 32 }}>
            <div style={cardStyle}>
              <div style={{ fontWeight: 800, fontSize: "1.05rem", marginBottom: 8 }}>
                Admin &amp; operator view
              </div>
              <p style={{ color: "var(--muted)", fontSize: "0.9rem", lineHeight: 1.6, marginBottom: 0 }}>
                Admin access includes user management, treasury controls, withdrawal review,
                developer API oversight and ledger inspection.
                Admin credentials are available to verified partners only.
              </p>
            </div>

            <div style={{ marginTop: 32, display: "flex", gap: 12, flexWrap: "wrap" }}>
              <Link to="/register" className="lp-btn lp-btn-primary">Create account →</Link>
              <Link to="/docs"     className="lp-btn lp-btn-ghost">API documentation</Link>
              <Link to="/architecture" className="lp-btn lp-btn-ghost">Architecture</Link>
            </div>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
