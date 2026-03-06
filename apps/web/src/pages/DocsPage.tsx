import React from "react";
import { Link } from "react-router-dom";
import PublicLayout, { useReveal } from "../components/PublicLayout";

// ─────────────────────────────────────────────────────────────────────────────
// Tiny anchor-link helper
// ─────────────────────────────────────────────────────────────────────────────
function Anchor({ id }: { id: string }) {
  return <span id={id} style={{ position: "relative", top: -80 }} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// DocsPage
// ─────────────────────────────────────────────────────────────────────────────

export default function DocsPage() {
  const hero     = useReveal();
  const s1       = useReveal();
  const s2       = useReveal();
  const s3       = useReveal();
  const s4       = useReveal();
  const s5       = useReveal();

  const sectionStyle: React.CSSProperties = {
    borderBottom: "1px solid var(--border)",
    paddingBottom: 56,
    marginBottom: 56,
  };

  return (
    <PublicLayout>
      {/* ── Hero ────────────────────────────────────────────────────────── */}
      <section className="lp-page-hero lp-section-sm">
        <div className="lp-container">
          <div ref={hero.ref} className={hero.cls}>
            <span className="lp-badge">Documentation</span>
            <h1 className="lp-h2-hero">Quickstart</h1>
            <p style={{ color: "var(--muted)", fontSize: "1.05rem", maxWidth: 580, lineHeight: 1.7, marginTop: 4 }}>
              Get up and running with LumixPay in under 10 minutes. No SDK required — just HTTP.
            </p>
          </div>
        </div>
      </section>

      {/* ── Main content ────────────────────────────────────────────────── */}
      <section className="lp-section" style={{ paddingTop: 48 }}>
        <div
          className="lp-container"
          style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 48, alignItems: "start" }}
        >
          {/* Sidebar TOC */}
          <nav
            style={{
              position: "sticky",
              top: 84,
              display: "flex",
              flexDirection: "column",
              gap: 6,
              borderRight: "1px solid var(--border)",
              paddingRight: 24,
            }}
          >
            {[
              ["#prereqs",   "Prerequisites"],
              ["#register",  "1. Register"],
              ["#balances",  "2. Balances"],
              ["#topup",     "3. Top up"],
              ["#transfer",  "4. Transfer"],
              ["#withdraw",  "5. Withdraw"],
              ["#webhooks",  "Webhooks"],
            ].map(([href, label]) => (
              <a
                key={href}
                href={href}
                style={{ fontSize: "0.83rem", color: "var(--muted)", textDecoration: "none", transition: "color 0.15s" }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--muted)")}
              >
                {label}
              </a>
            ))}
          </nav>

          {/* Content */}
          <div>
            {/* Prerequisites */}
            <div ref={s1.ref} className={s1.cls} style={sectionStyle}>
              <Anchor id="prereqs" />
              <h2 style={{ fontWeight: 800, fontSize: "1.4rem", letterSpacing: "-0.03em", marginBottom: 16 }}>
                Prerequisites
              </h2>
              <ul style={{ color: "var(--muted)", fontSize: "0.9rem", lineHeight: 1.8, paddingLeft: 20 }}>
                <li>LumixPay API running on <code style={{ color: "var(--accent-h)" }}>http://localhost:4000</code></li>
                <li>PostgreSQL with migrations applied (<code style={{ color: "var(--accent-h)" }}>npm run migrate</code>)</li>
                <li>
                  Any HTTP client — examples use{" "}
                  <code style={{ color: "var(--accent-h)" }}>curl</code> and{" "}
                  <code style={{ color: "var(--accent-h)" }}>jq</code>
                </li>
              </ul>
              <div
                style={{ marginTop: 20, background: "rgba(251,191,36,0.08)", border: "1px solid rgba(251,191,36,0.2)", borderRadius: 10, padding: "14px 18px" }}
              >
                <p style={{ fontSize: "0.87rem", color: "#fbbf24" }}>
                  <strong>MVP note</strong> — The mock payment provider always succeeds.
                  XRPL settlement is not wired in Phase 1. Withdrawal approval triggers escrow lock only.
                </p>
              </div>
            </div>

            {/* 1. Register */}
            <div ref={s2.ref} className={s2.cls} style={sectionStyle}>
              <Anchor id="register" />
              <h2 style={{ fontWeight: 800, fontSize: "1.4rem", letterSpacing: "-0.03em", marginBottom: 12 }}>
                1. Register &amp; login
              </h2>
              <p className="muted" style={{ marginBottom: 20, lineHeight: 1.7, fontSize: "0.9rem" }}>
                Every user needs an account. On registration, LumixPay automatically creates one
                <em> main</em> account per active asset (RLUSD and EURQ).
              </p>
              <pre className="lp-code">{`<span class="cm"># Register</span>
TOKEN=$(curl -s -X POST http://localhost:4000/auth/register \\
  -H <span class="str">"Content-Type: application/json"</span> \\
  -d <span class="str">'{"email":"dev@example.com","password":"secret1234","full_name":"Dev"}'</span> \\
  | jq -r .token)

echo <span class="str">"Token: \$TOKEN"</span>`}</pre>
            </div>

            {/* 2. Balances */}
            <div ref={s3.ref} className={s3.cls} style={sectionStyle}>
              <Anchor id="balances" />
              <h2 style={{ fontWeight: 800, fontSize: "1.4rem", letterSpacing: "-0.03em", marginBottom: 12 }}>
                2. Fetch your accounts &amp; balances
              </h2>
              <p className="muted" style={{ marginBottom: 20, lineHeight: 1.7, fontSize: "0.9rem" }}>
                The <code style={{ color: "var(--accent-h)" }}>/me/accounts</code> endpoint returns all accounts
                with their <code style={{ color: "var(--accent-h)" }}>available</code> and{" "}
                <code style={{ color: "var(--accent-h)" }}>locked</code> balances.
              </p>
              <pre className="lp-code">{`curl -s http://localhost:4000/me/accounts \\
  -H <span class="str">"Authorization: Bearer \$TOKEN"</span> | jq .

<span class="cm"># Response</span>
{
  <span class="key">"accounts"</span>: [
    {
      <span class="key">"id"</span>: <span class="str">"uuid"</span>,
      <span class="key">"asset_id"</span>: <span class="str">"00000000-0000-0000-0000-000000000001"</span>,
      <span class="key">"asset"</span>: { <span class="key">"display_symbol"</span>: <span class="str">"RLUSD"</span> },
      <span class="key">"balance"</span>: { <span class="key">"available"</span>: <span class="str">"0.000000"</span>, <span class="key">"locked"</span>: <span class="str">"0.000000"</span> }
    }
  ]
}`}</pre>
              <div
                style={{ marginTop: 18, background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.22)", borderRadius: 10, padding: "14px 18px" }}
              >
                <p style={{ fontSize: "0.85rem", color: "var(--muted)", lineHeight: 1.6 }}>
                  <strong style={{ color: "var(--text)" }}>Ledger model</strong> — Balances are
                  a denormalized read model updated atomically with every{" "}
                  <code style={{ color: "var(--accent-h)" }}>ledger_entries</code> write.
                  The ledger is the source of truth; use{" "}
                  <code style={{ color: "var(--accent-h)" }}>/me/accounts/:id/history</code> to inspect raw entries.
                </p>
              </div>
            </div>

            {/* 3. Top up */}
            <div style={sectionStyle}>
              <Anchor id="topup" />
              <h2 style={{ fontWeight: 800, fontSize: "1.4rem", letterSpacing: "-0.03em", marginBottom: 12 }}>
                3. Top up
              </h2>
              <p className="muted" style={{ marginBottom: 20, lineHeight: 1.7, fontSize: "0.9rem" }}>
                Amounts must be one of: <code style={{ color: "var(--accent-h)" }}>10, 20, 50, 100</code>.
                A 1% fee is deducted; net is credited to your account. The mock provider always succeeds.
              </p>
              <pre className="lp-code">{`ASSET_ID=<span class="str">"00000000-0000-0000-0000-000000000001"</span> <span class="cm"># RLUSD</span>

curl -s -X POST http://localhost:4000/topup \\
  -H <span class="str">"Authorization: Bearer \$TOKEN"</span> \\
  -H <span class="str">"Content-Type: application/json"</span> \\
  -d <span class="str">'{
    "asset_id":              "'</span>$ASSET_ID<span class="str">'",
    "gross_amount":          <span class="num">20</span>,
    "simulated_card_last4":  <span class="str">"4242"</span>
  }'</span> | jq .topup.net_amount
<span class="cm"># "19.800000"</span>`}</pre>
            </div>

            {/* 4. Transfer */}
            <div style={sectionStyle}>
              <Anchor id="transfer" />
              <h2 style={{ fontWeight: 800, fontSize: "1.4rem", letterSpacing: "-0.03em", marginBottom: 12 }}>
                4. Send a transfer
              </h2>
              <p className="muted" style={{ marginBottom: 20, lineHeight: 1.7, fontSize: "0.9rem" }}>
                Supply the recipient's <code style={{ color: "var(--accent-h)" }}>user_id</code> (UUID from their profile),
                asset, and gross amount. Sender pays 1% fee; recipient receives net.
              </p>
              <pre className="lp-code">{`curl -s -X POST http://localhost:4000/transfers \\
  -H <span class="str">"Authorization: Bearer \$TOKEN"</span> \\
  -H <span class="str">"Content-Type: application/json"</span> \\
  -d <span class="str">'{
    "to_user_id":   <span class="str">"recipient-uuid"</span>,
    "asset_id":     <span class="str">"'</span>$ASSET_ID<span class="str">'"</span>,
    "gross_amount": <span class="num">10</span>
  }'</span> | jq .transfer`}</pre>
            </div>

            {/* 5. Withdraw */}
            <div ref={s4.ref} className={s4.cls} style={sectionStyle}>
              <Anchor id="withdraw" />
              <h2 style={{ fontWeight: 800, fontSize: "1.4rem", letterSpacing: "-0.03em", marginBottom: 12 }}>
                5. Request a withdrawal
              </h2>
              <p className="muted" style={{ marginBottom: 20, lineHeight: 1.7, fontSize: "0.9rem" }}>
                Funds move from <code style={{ color: "var(--accent-h)" }}>available → locked</code> immediately.
                An admin must approve before settlement. 1% fee is locked with the escrow (non-refundable on rejection).
              </p>
              <pre className="lp-code">{`curl -s -X POST http://localhost:4000/withdrawals \\
  -H <span class="str">"Authorization: Bearer \$TOKEN"</span> \\
  -H <span class="str">"Content-Type: application/json"</span> \\
  -d <span class="str">'{
    "asset_id":                <span class="str">"'</span>$ASSET_ID<span class="str">'"</span>,
    "gross_amount":            <span class="num">5</span>,
    "xrpl_destination_address":<span class="str">"rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe"</span>
  }'</span> | jq .withdrawal.status
<span class="cm"># "pending"</span>`}</pre>
            </div>

            {/* Webhooks */}
            <div ref={s5.ref} className={s5.cls}>
              <Anchor id="webhooks" />
              <h2 style={{ fontWeight: 800, fontSize: "1.4rem", letterSpacing: "-0.03em", marginBottom: 12 }}>
                Webhooks &amp; events
                <span className="lp-feature-tag" style={{ marginLeft: 10, verticalAlign: "middle" }}>Coming soon</span>
              </h2>
              <p className="muted" style={{ marginBottom: 20, lineHeight: 1.7, fontSize: "0.9rem" }}>
                Webhook subscriptions will be configurable via the developer dashboard.
                Every significant event (transfer, withdrawal, voucher, etc.) fires a
                signed <code style={{ color: "var(--accent-h)" }}>POST</code> to your endpoint.
                See the <Link to="/developers">Developers</Link> page for the full event list.
              </p>
              <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "20px 24px" }}>
                <p style={{ fontWeight: 700, marginBottom: 8 }}>SDK coming soon</p>
                <p className="muted" style={{ fontSize: "0.87rem", lineHeight: 1.6 }}>
                  A lightweight TypeScript SDK with typed helpers for all endpoints
                  and automatic webhook signature verification is planned for a future release.
                </p>
              </div>

              <div style={{ marginTop: 32 }}>
                <Link to="/register" className="lp-btn lp-btn-primary" style={{ marginRight: 12 }}>
                  Create account →
                </Link>
                <Link to="/developers" className="lp-btn lp-btn-ghost">
                  Full API reference
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
