import React from "react";
import { Link } from "react-router-dom";
import PublicLayout, { useReveal } from "../components/PublicLayout";

// ─────────────────────────────────────────────────────────────────────────────
// Data
// ─────────────────────────────────────────────────────────────────────────────

const endpoints = [
  { method: "POST", path: "/auth/register",          auth: false, desc: "Create user account" },
  { method: "POST", path: "/auth/login",             auth: false, desc: "Get JWT token" },
  { method: "GET",  path: "/me/accounts",            auth: true,  desc: "List accounts with balances" },
  { method: "GET",  path: "/me/accounts/:id/history",auth: true,  desc: "Ledger entries for an account" },
  { method: "POST", path: "/topup",                  auth: true,  desc: "Simulate a card top-up" },
  { method: "POST", path: "/transfers",              auth: true,  desc: "Send a P2P transfer" },
  { method: "POST", path: "/withdrawals",            auth: true,  desc: "Request an XRPL withdrawal" },
  { method: "GET",  path: "/withdrawals",            auth: true,  desc: "Your withdrawal history" },
  { method: "GET",  path: "/notifications",          auth: true,  desc: "Notification inbox (paginated)" },
  { method: "GET",  path: "/notifications/unread-count", auth: true, desc: "Badge count" },
  { method: "POST", path: "/notifications/mark-all-read", auth: true, desc: "Mark all read" },
  { method: "GET",  path: "/withdrawals/admin",      auth: "admin", desc: "Admin: list withdrawals by status" },
  { method: "POST", path: "/withdrawals/admin/:id/review", auth: "admin", desc: "Admin: approve or reject" },
];

const webhookEvents = [
  "topup.completed",
  "transfer.sent",
  "transfer.received",
  "withdrawal.requested",
  "withdrawal.approved",
  "withdrawal.rejected",
  "withdrawal.settled",
  "voucher.redeemed",
  "payment_link.paid",
  "recurring.executed",
];

// ─────────────────────────────────────────────────────────────────────────────
// DevelopersPage
// ─────────────────────────────────────────────────────────────────────────────

export default function DevelopersPage() {
  const hero      = useReveal();
  const apiRef    = useReveal();
  const authRef   = useReveal();
  const hooksRef  = useReveal();
  const ctaRef    = useReveal();

  const methodColor = (m: string) =>
    m === "GET" ? "#4ade80" : m === "POST" ? "#818cf8" : "#fb923c";

  return (
    <PublicLayout>
      {/* ── Hero ────────────────────────────────────────────────────────── */}
      <section className="lp-page-hero lp-section-sm">
        <div className="lp-container">
          <div ref={hero.ref} className={hero.cls}>
            <span className="lp-badge">Developers</span>
            <h1 className="lp-h2-hero">
              Build on LumixPay<br />
              <span className="lp-gradient-text">in minutes.</span>
            </h1>
            <p style={{ color: "var(--muted)", fontSize: "1.05rem", maxWidth: 560, lineHeight: 1.7, marginTop: 4, marginBottom: 28 }}>
              A REST API with JWT auth, predictable JSON responses, and webhook delivery.
              No SDK required — any HTTP client works.
            </p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <Link to="/docs" className="lp-btn lp-btn-primary">Quickstart guide →</Link>
              <Link to="/pricing" className="lp-btn lp-btn-ghost">Pricing</Link>
            </div>
          </div>
        </div>
      </section>

      <hr className="lp-divider" />

      {/* ── Authentication ──────────────────────────────────────────────── */}
      <section className="lp-section">
        <div className="lp-container">
          <div ref={authRef.ref} className={authRef.cls}>
            <p className="lp-section-label">Authentication</p>
            <h2 style={{ fontWeight: 800, fontSize: "1.6rem", letterSpacing: "-0.03em", marginBottom: 16 }}>
              JWT Bearer tokens
            </h2>
            <p className="muted" style={{ marginBottom: 28, maxWidth: 580, lineHeight: 1.7 }}>
              Every protected endpoint requires an <code style={{ color: "var(--accent-h)" }}>Authorization: Bearer &lt;token&gt;</code> header.
              Tokens are issued on login and expire in 24 h. There are no refresh tokens in MVP — just re-login.
            </p>

            <div className="lp-grid lp-grid-2" style={{ gap: 16, maxWidth: 900 }}>
              <div>
                <p style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--muted)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                  Register
                </p>
                <pre className="lp-code">{`<span class="cm"># POST /auth/register</span>
curl -s -X POST http://localhost:4000/auth/register \\
  -H <span class="str">"Content-Type: application/json"</span> \\
  -d <span class="str">'{"email":"you@example.com",
     "password":"secret1234",
     "full_name":"Jane Dev"}'</span>

<span class="cm"># Response</span>
{
  <span class="key">"token"</span>: <span class="str">"eyJhbG..."</span>,
  <span class="key">"user"</span>: { <span class="key">"id"</span>: <span class="str">"uuid"</span>, <span class="key">"role"</span>: <span class="str">"user"</span> }
}`}</pre>
              </div>
              <div>
                <p style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--muted)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                  Login
                </p>
                <pre className="lp-code">{`<span class="cm"># POST /auth/login</span>
curl -s -X POST http://localhost:4000/auth/login \\
  -H <span class="str">"Content-Type: application/json"</span> \\
  -d <span class="str">'{"email":"you@example.com",
     "password":"secret1234"}'</span>

<span class="cm"># Save token</span>
TOKEN=<span class="str">"\$(jq -r .token)"</span>

<span class="cm"># Use on protected routes</span>
-H <span class="str">"Authorization: Bearer \$TOKEN"</span>`}</pre>
              </div>
            </div>
          </div>
        </div>
      </section>

      <hr className="lp-divider" />

      {/* ── API reference table ─────────────────────────────────────────── */}
      <section className="lp-section">
        <div className="lp-container">
          <div ref={apiRef.ref} className={apiRef.cls}>
            <p className="lp-section-label">API reference</p>
            <h2 style={{ fontWeight: 800, fontSize: "1.6rem", letterSpacing: "-0.03em", marginBottom: 8 }}>
              All endpoints — MVP v1
            </h2>
            <p className="muted" style={{ marginBottom: 28, fontSize: "0.9rem" }}>
              Base URL: <code style={{ color: "var(--accent-h)" }}>http://localhost:4000</code> in dev.
              All responses are JSON. Errors return <code style={{ color: "var(--accent-h)" }}>{`{ "error": "..." }`}</code>.
            </p>

            <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table className="lp-table">
                  <thead>
                    <tr>
                      <th style={{ width: 72 }}>Method</th>
                      <th>Path</th>
                      <th style={{ width: 80 }}>Auth</th>
                      <th>Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {endpoints.map((e) => (
                      <tr key={`${e.method}${e.path}`}>
                        <td>
                          <code style={{ color: methodColor(e.method), fontWeight: 700, fontSize: "0.8rem" }}>
                            {e.method}
                          </code>
                        </td>
                        <td>
                          <code style={{ fontSize: "0.82rem", color: "var(--text)" }}>{e.path}</code>
                        </td>
                        <td>
                          {e.auth === false ? (
                            <span style={{ color: "var(--muted)", fontSize: "0.8rem" }}>public</span>
                          ) : e.auth === "admin" ? (
                            <span style={{ color: "#fbbf24", fontSize: "0.8rem", fontWeight: 600 }}>admin</span>
                          ) : (
                            <span style={{ color: "#4ade80", fontSize: "0.8rem", fontWeight: 600 }}>JWT</span>
                          )}
                        </td>
                        <td style={{ color: "var(--muted)", fontSize: "0.88rem" }}>{e.desc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Quick transfer example */}
            <div style={{ marginTop: 32 }}>
              <p style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--muted)", marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                Example — send a transfer
              </p>
              <pre className="lp-code">{`<span class="cm"># Get asset_id from /me/accounts first</span>
curl -s -X POST <span class="url">http://localhost:4000/transfers</span> \\
  -H <span class="str">"Authorization: Bearer \$TOKEN"</span> \\
  -H <span class="str">"Content-Type: application/json"</span> \\
  -d <span class="str">'{
    "to_user_id": "<span class="key">recipient-uuid</span>",
    "asset_id":   "<span class="key">00000000-0000-0000-0000-000000000001</span>",
    "gross_amount": <span class="num">50</span>
  }'</span>

<span class="cm"># Response: transfer + ledger_entries</span>
{
  <span class="key">"transfer"</span>: {
    <span class="key">"id"</span>: <span class="str">"uuid"</span>, <span class="key">"gross_amount"</span>: <span class="str">"50.000000"</span>,
    <span class="key">"fee_amount"</span>: <span class="str">"0.500000"</span>, <span class="key">"net_amount"</span>: <span class="str">"49.500000"</span>,
    <span class="key">"status"</span>: <span class="str">"completed"</span>
  }
}`}</pre>
            </div>
          </div>
        </div>
      </section>

      <hr className="lp-divider" />

      {/* ── Webhooks ────────────────────────────────────────────────────── */}
      <section className="lp-section">
        <div className="lp-container">
          <div ref={hooksRef.ref} className={hooksRef.cls}>
            <p className="lp-section-label">Webhooks</p>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 12 }}>
              <h2 style={{ fontWeight: 800, fontSize: "1.6rem", letterSpacing: "-0.03em" }}>
                Real-time event delivery
              </h2>
              <span className="lp-feature-tag" style={{ marginTop: 8 }}>Coming soon</span>
            </div>
            <p className="muted" style={{ marginBottom: 32, maxWidth: 580, lineHeight: 1.7 }}>
              Register an HTTPS endpoint and a signing secret. LumixPay will POST signed
              JSON events for every significant action. Failed deliveries are retried with
              exponential back-off and logged.
            </p>

            <div className="lp-grid lp-grid-2" style={{ gap: 16, maxWidth: 900 }}>
              <div>
                <p style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--muted)", marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                  Event types
                </p>
                <div
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 12,
                    padding: "16px 20px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  {webhookEvents.map((e) => (
                    <code key={e} style={{ fontSize: "0.82rem", color: "var(--accent-h)" }}>
                      {e}
                    </code>
                  ))}
                </div>
              </div>
              <div>
                <p style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--muted)", marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                  Event payload shape
                </p>
                <pre className="lp-code">{`{
  <span class="key">"id"</span>:         <span class="str">"evt_uuid"</span>,
  <span class="key">"type"</span>:       <span class="str">"transfer.completed"</span>,
  <span class="key">"created_at"</span>: <span class="str">"2026-03-04T10:00:00Z"</span>,
  <span class="key">"data"</span>: {
    <span class="key">"transfer_id"</span>: <span class="str">"uuid"</span>,
    <span class="key">"amount"</span>:      <span class="str">"49.500000"</span>,
    <span class="key">"currency"</span>:    <span class="str">"RLUSD"</span>
  }
}

<span class="cm"># Signature header</span>
X-LumixPay-Signature: <span class="str">sha256=...</span>`}</pre>
              </div>
            </div>
          </div>
        </div>
      </section>

      <hr className="lp-divider" />

      {/* ── CTA ─────────────────────────────────────────────────────────── */}
      <section className="lp-cta-section">
        <div ref={ctaRef.ref} className={ctaRef.cls}>
          <h2 style={{ fontWeight: 800, letterSpacing: "-0.04em", marginBottom: 14 }}>
            Start building today
          </h2>
          <p>Register an account, hit the API, and ship your first payment integration.</p>
          <div className="lp-hero-cta" style={{ marginTop: 32 }}>
            <Link to="/register" className="lp-btn lp-btn-primary lp-btn-lg">
              Create account →
            </Link>
            <Link to="/docs" className="lp-btn lp-btn-ghost lp-btn-lg">
              Read the docs
            </Link>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
