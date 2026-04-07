import React from "react";
import { Link } from "react-router-dom";
import PublicLayout, { useReveal } from "../components/PublicLayout";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function Anchor({ id }: { id: string }) {
  return <span id={id} style={{ position: "relative", top: -88 }} />;
}

const SECTION: React.CSSProperties = {
  borderBottom: "1px solid var(--border)",
  paddingBottom: 52,
  marginBottom: 52,
};

const BASE = "https://lumixpay-api.fly.dev";

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint block
// ─────────────────────────────────────────────────────────────────────────────
function Endpoint({
  method, path, auth, desc, request, response,
}: {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  auth?: boolean;
  desc?: string;
  request?: string;
  response?: string;
}) {
  const methodColor: Record<string, string> = {
    GET:    "#34d399",
    POST:   "#60a5fa",
    PUT:    "#fbbf24",
    DELETE: "#f87171",
  };
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
        <span style={{
          fontFamily: "monospace", fontWeight: 700, fontSize: "0.78rem",
          color: methodColor[method] ?? "var(--muted)",
          background: "rgba(255,255,255,.05)", padding: "3px 8px", borderRadius: 6,
        }}>{method}</span>
        <code style={{ fontSize: "0.9rem", color: "var(--text)" }}>{path}</code>
        {auth && (
          <span style={{
            fontSize: "0.72rem", color: "#a78bfa",
            background: "rgba(124,58,237,.1)", border: "1px solid rgba(124,58,237,.2)",
            padding: "2px 7px", borderRadius: 5,
          }}>🔒 Bearer token required</span>
        )}
      </div>
      {desc && (
        <p style={{ color: "var(--muted)", fontSize: "0.87rem", lineHeight: 1.6, marginBottom: 10 }}>{desc}</p>
      )}
      {request && (
        <>
          <p style={{ fontSize: "0.75rem", color: "var(--muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: ".05em" }}>Request body</p>
          <pre className="lp-code" style={{ marginBottom: 10 }}>{request}</pre>
        </>
      )}
      {response && (
        <>
          <p style={{ fontSize: "0.75rem", color: "var(--muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: ".05em" }}>Response</p>
          <pre className="lp-code">{response}</pre>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DocsPage
// ─────────────────────────────────────────────────────────────────────────────
export default function DocsPage() {
  const hero = useReveal();
  const s0   = useReveal();
  const s1   = useReveal();
  const s2   = useReveal();
  const s3   = useReveal();
  const s4   = useReveal();
  const s5   = useReveal();
  const s6   = useReveal();
  const s7   = useReveal();
  const s8   = useReveal();
  const s9   = useReveal();

  const tocLinks: [string, string][] = [
    ["#overview",       "Overview"],
    ["#auth",           "Auth"],
    ["#accounts",       "Accounts"],
    ["#topup",          "Top-up"],
    ["#transfers",      "Transfers"],
    ["#withdrawals",    "Withdrawals"],
    ["#payment-links",  "Payment Links"],
    ["#convert",        "FX Conversion"],
    ["#notifications",  "Notifications"],
    ["#webhooks",       "Webhooks"],
  ];

  return (
    <PublicLayout>
      {/* Hero */}
      <section className="lp-page-hero lp-section-sm">
        <div className="lp-container">
          <div ref={hero.ref} className={hero.cls}>
            <span className="lp-badge">API Reference</span>
            <h1 className="lp-h2-hero">LumixPay API Docs</h1>
            <p style={{ color: "var(--muted)", fontSize: "1.05rem", maxWidth: 600, lineHeight: 1.7, marginTop: 4 }}>
              Complete reference for the LumixPay REST API.
              No SDK required — all endpoints are plain HTTP + JSON.
              Authentication uses JWT Bearer tokens.
            </p>
          </div>
        </div>
      </section>

      {/* Main layout */}
      <section className="lp-section" style={{ paddingTop: 40, paddingBottom: 80 }}>
        <div
          className="lp-container lp-docs-layout"
          data-page="docs"
          style={{ display: "grid", gridTemplateColumns: "clamp(160px,18%,210px) 1fr", gap: 48, alignItems: "start" }}
        >
          {/* Sticky TOC */}
          <nav className="lp-docs-toc" style={{ position: "sticky", top: 88, display: "flex", flexDirection: "column", gap: 5, borderRight: "1px solid var(--border)", paddingRight: 20 }}>
            {tocLinks.map(([href, label]) => (
              <a
                key={href}
                href={href}
                style={{ fontSize: "0.83rem", color: "var(--muted)", textDecoration: "none", transition: "color 0.15s", padding: "2px 0" }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--muted)")}
              >
                {label}
              </a>
            ))}
          </nav>

          {/* Content */}
          <div>

            {/* ── Overview ── */}
            <div ref={s0.ref} className={s0.cls} style={SECTION}>
              <Anchor id="overview" />
              <h2 style={{ fontWeight: 800, fontSize: "1.35rem", letterSpacing: "-0.03em", marginBottom: 14 }}>Overview</h2>
              <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "20px 24px", marginBottom: 20 }}>
                <div className="lp-mobile-grid-2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                  {[
                    ["Base URL", BASE],
                    ["Auth", "Bearer JWT — include in Authorization header"],
                    ["Content-Type", "application/json for all POST / PUT"],
                    ["Idempotency", "Idempotency-Key is required for top-ups, withdrawals and voucher redemption. Recommended for all mutations."],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <div style={{ fontSize: "0.75rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 3 }}>{k}</div>
                      <code style={{ fontSize: "0.85rem", color: "var(--text)", wordBreak: "break-all" }}>{v}</code>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ background: "rgba(251,191,36,.07)", border: "1px solid rgba(251,191,36,.2)", borderRadius: 10, padding: "14px 18px" }}>
                <p style={{ fontSize: "0.87rem", color: "#fbbf24", lineHeight: 1.6 }}>
                  <strong>Phase 1 note</strong> — Top-ups use a mock payment provider.
                  XRPL on-chain settlement is planned for Phase 2.
                  All balances, transfers and ledger entries are real and persistent.
                </p>
              </div>

              <div style={{ marginTop: 22, background: "rgba(124,58,237,.07)", border: "1px solid rgba(124,58,237,.18)", borderRadius: 12, padding: "18px 20px" }}>
                <div style={{ fontWeight: 800, marginBottom: 8 }}>Quick start (5 minutes)</div>
                <pre className="lp-code" style={{ margin: 0 }}>{`# 1) Register
curl -s ${BASE}/auth/register \\
  -H 'Content-Type: application/json' \\
  -d '{\"email\":\"dev@example.com\",\"password\":\"secret1234\",\"full_name\":\"Dev User\"}' | jq

# 2) Save your token
TOKEN='...'

# 3) Read balances
curl -s ${BASE}/me/accounts -H \"Authorization: Bearer $TOKEN\" | jq

# 4) Top up (Idempotency-Key required)
curl -s ${BASE}/topup \\
  -H \"Authorization: Bearer $TOKEN\" \\
  -H 'Content-Type: application/json' \\
  -H 'Idempotency-Key: topup-001' \\
  -d '{\"asset_id\":\"<rlusd-asset-id>\",\"gross_amount\":20,\"simulated_card_last4\":\"4242\"}' | jq`}</pre>
              </div>

              <div style={{ marginTop: 22, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "18px 20px" }}>
                <div style={{ fontWeight: 800, marginBottom: 10 }}>Real-world integration scenarios</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  {[
                    ["Embedded payouts (platforms)", "Use LumixPay accounts as internal payout balances, then trigger transfers and withdrawals from your backend."],
                    ["Grants & NGOs", "Issue vouchers for offline distribution, track redemptions, and reconcile disbursements via immutable ledger history."],
                    ["Gig economy", "Automate recurring or milestone-based payouts. Use idempotency keys to make retries safe under unstable connectivity."],
                    ["Payment links", "Generate invoice-like links for one-off collection and use webhooks to update your app once paid."],
                  ].map(([title, desc]) => (
                    <div key={title} style={{ padding: "12px 12px", border: "1px solid rgba(255,255,255,.06)", borderRadius: 10 }}>
                      <div style={{ fontWeight: 700, marginBottom: 6 }}>{title}</div>
                      <div style={{ color: "var(--muted)", fontSize: "0.88rem", lineHeight: 1.6 }}>{desc}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* ── Auth ── */}
            <div ref={s1.ref} className={s1.cls} style={SECTION}>
              <Anchor id="auth" />
              <h2 style={{ fontWeight: 800, fontSize: "1.35rem", letterSpacing: "-0.03em", marginBottom: 14 }}>Auth</h2>
              <p style={{ color: "var(--muted)", fontSize: "0.9rem", lineHeight: 1.7, marginBottom: 20 }}>
                Register to receive a JWT token. Pass the token as{" "}
                <code style={{ color: "var(--accent-h)" }}>Authorization: Bearer &lt;token&gt;</code> on all
                protected endpoints. Tokens expire after 24h by default.
              </p>

              <Endpoint
                method="POST" path="/auth/register"
                desc="Create a new user account. Returns a JWT token and user object."
                request={`{
  "email":     "dev@example.com",
  "password":  "secret1234",
  "full_name": "Dev User"
}`}
                response={`{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user":  { "id": "uuid", "email": "dev@example.com", "role": "user" }
}`}
              />

              <Endpoint
                method="POST" path="/auth/login"
                desc="Authenticate an existing user. Returns a fresh JWT token."
                request={`{
  "email":    "dev@example.com",
  "password": "secret1234"
}`}
                response={`{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user":  { "id": "uuid", "email": "dev@example.com", "role": "user" }
}`}
              />
            </div>

            {/* ── Accounts ── */}
            <div ref={s2.ref} className={s2.cls} style={SECTION}>
              <Anchor id="accounts" />
              <h2 style={{ fontWeight: 800, fontSize: "1.35rem", letterSpacing: "-0.03em", marginBottom: 14 }}>Accounts &amp; Balances</h2>
              <p style={{ color: "var(--muted)", fontSize: "0.9rem", lineHeight: 1.7, marginBottom: 20 }}>
                Every registered user automatically has one account per active asset (RLUSD, EURQ).
                The <code style={{ color: "var(--accent-h)" }}>available</code> balance is spendable;{" "}
                <code style={{ color: "var(--accent-h)" }}>locked</code> is reserved for pending withdrawals.
              </p>

              <Endpoint
                method="GET" path="/me/accounts" auth
                desc="List all accounts with live balances."
                response={`{
  "accounts": [
    {
      "id":       "account-uuid",
      "asset_id": "00000000-0000-0000-0000-000000000001",
      "label":    "Main RLUSD",
      "asset":    { "currency_code": "RLUSD", "display_symbol": "RLUSD" },
      "balance":  { "available": "99.000000", "locked": "0.000000" }
    }
  ]
}`}
              />

              <Endpoint
                method="GET" path="/me/accounts/:id/history" auth
                desc="Paginated ledger history for a single account. Query params: limit (default 50), offset."
                response={`{
  "entries": [
    {
      "id":            "entry-uuid",
      "entry_type":    "topup",
      "amount":        "99.000000",
      "reference_type":"topup_transactions",
      "created_at":    "2025-01-15T10:00:00.000Z"
    }
  ]
}`}
              />
            </div>

            {/* ── Top-up ── */}
            <div ref={s3.ref} className={s3.cls} style={SECTION}>
              <Anchor id="topup" />
              <h2 style={{ fontWeight: 800, fontSize: "1.35rem", letterSpacing: "-0.03em", marginBottom: 14 }}>Top-up</h2>
              <p style={{ color: "var(--muted)", fontSize: "0.9rem", lineHeight: 1.7, marginBottom: 20 }}>
                Fund an account using the simulated card provider.
                Allowed gross amounts: <code style={{ color: "var(--accent-h)" }}>10, 20, 50, 100</code>.
                A 1% platform fee is deducted; the net amount is credited to the user's account.
                Supports <code style={{ color: "var(--accent-h)" }}>Idempotency-Key</code> header.
              </p>

              <Endpoint
                method="POST" path="/topup" auth
                request={`{
  "asset_id":             "00000000-0000-0000-0000-000000000001",
  "gross_amount":         20,
  "simulated_card_last4": "4242"
}`}
                response={`{
  "topup": {
    "id":          "tx-uuid",
    "gross_amount":"20.000000",
    "fee_amount":  "0.200000",
    "net_amount":  "19.800000",
    "asset_id":    "00000000-0000-0000-0000-000000000001",
    "created_at":  "2025-01-15T10:00:00.000Z"
  }
}`}
              />
            </div>

            {/* ── Transfers ── */}
            <div ref={s4.ref} className={s4.cls} style={SECTION}>
              <Anchor id="transfers" />
              <h2 style={{ fontWeight: 800, fontSize: "1.35rem", letterSpacing: "-0.03em", marginBottom: 14 }}>Transfers</h2>
              <p style={{ color: "var(--muted)", fontSize: "0.9rem", lineHeight: 1.7, marginBottom: 20 }}>
                Send stablecoins to another user. The sender pays a 1% fee on the gross amount;
                the recipient receives the net amount. Supply <code style={{ color: "var(--accent-h)" }}>to_user_id</code> (UUID
                from their profile) or{" "}
                <code style={{ color: "var(--accent-h)" }}>to_username</code>.
                Supports <code style={{ color: "var(--accent-h)" }}>Idempotency-Key</code>.
              </p>

              <Endpoint
                method="POST" path="/transfers" auth
                request={`{
  "to_user_id":   "recipient-uuid",
  "asset_id":     "00000000-0000-0000-0000-000000000001",
  "gross_amount": 10
}`}
                response={`{
  "transfer": {
    "id":          "tx-uuid",
    "gross_amount":"10.000000",
    "fee_amount":  "0.100000",
    "net_amount":  "9.900000",
    "created_at":  "2025-01-15T10:01:00.000Z"
  }
}`}
              />
            </div>

            {/* ── Withdrawals ── */}
            <div ref={s5.ref} className={s5.cls} style={SECTION}>
              <Anchor id="withdrawals" />
              <h2 style={{ fontWeight: 800, fontSize: "1.35rem", letterSpacing: "-0.03em", marginBottom: 14 }}>Withdrawals</h2>
              <p style={{ color: "var(--muted)", fontSize: "0.9rem", lineHeight: 1.7, marginBottom: 20 }}>
                Request an on-chain withdrawal to an XRPL address.
                Funds move from <code style={{ color: "var(--accent-h)" }}>available → locked</code> immediately.
                An admin must approve the request before settlement (Phase 2).
                Supports <code style={{ color: "var(--accent-h)" }}>Idempotency-Key</code>.
              </p>

              <Endpoint
                method="POST" path="/withdrawals" auth
                request={`{
  "asset_id":                 "00000000-0000-0000-0000-000000000001",
  "gross_amount":             50,
  "xrpl_destination_address": "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
  "xrpl_destination_tag":     12345
}`}
                response={`{
  "withdrawal": {
    "id":         "tx-uuid",
    "status":     "pending",
    "net_amount": "49.500000",
    "created_at": "2025-01-15T10:02:00.000Z"
  }
}`}
              />

              <Endpoint
                method="GET" path="/withdrawals" auth
                desc="List all withdrawal requests for the authenticated user."
                response={`{ "withdrawals": [ /* see above shape */ ] }`}
              />
            </div>

            {/* ── Payment Links ── */}
            <div ref={s6.ref} className={s6.cls} style={SECTION}>
              <Anchor id="payment-links" />
              <h2 style={{ fontWeight: 800, fontSize: "1.35rem", letterSpacing: "-0.03em", marginBottom: 14 }}>Payment Links</h2>
              <p style={{ color: "var(--muted)", fontSize: "0.9rem", lineHeight: 1.7, marginBottom: 20 }}>
                Create a reusable or single-use payment link. The link can be shared publicly;
                any LumixPay user can pay it. Fixed or flexible amount.
                Supports <code style={{ color: "var(--accent-h)" }}>Idempotency-Key</code>.
              </p>

              <Endpoint
                method="POST" path="/payment-links" auth
                desc="Create a new payment link."
                request={`{
  "asset_id":   "00000000-0000-0000-0000-000000000001",
  "amount":     25,
  "note":       "Invoice #1234",
  "max_uses":   1
}`}
                response={`{
  "link": {
    "id":       "link-uuid",
    "slug":     "abc123",
    "url":      "https://lumixpay.com/pay/link-uuid",
    "amount":   "25.000000",
    "status":   "active",
    "uses":     0,
    "max_uses": 1,
    "created_at": "2025-01-15T10:03:00.000Z"
  }
}`}
              />

              <Endpoint
                method="GET" path="/payment-links" auth
                desc="List all payment links created by the authenticated user."
              />

              <Endpoint
                method="POST" path="/payment-links/pay/:id/claim" auth
                desc="Pay a payment link (authenticated payer). The gross_amount is deducted from the payer and credited to the link creator minus fees."
                request={`{ "gross_amount": 25 }`}
              />
            </div>

            {/* ── FX Conversion ── */}
            <div ref={s7.ref} className={s7.cls} style={SECTION}>
              <Anchor id="convert" />
              <h2 style={{ fontWeight: 800, fontSize: "1.35rem", letterSpacing: "-0.03em", marginBottom: 14 }}>FX Conversion</h2>
              <p style={{ color: "var(--muted)", fontSize: "0.9rem", lineHeight: 1.7, marginBottom: 20 }}>
                Convert between RLUSD and EURQ at the platform FX rate.
                The source asset is debited and the destination asset is credited atomically.
                Supports <code style={{ color: "var(--accent-h)" }}>Idempotency-Key</code>.
              </p>

              <Endpoint
                method="GET" path="/fx-rates"
                desc="Get all available FX rates. No authentication required."
                response={`{
  "rates": [
    {
      "base_asset":  "RLUSD",
      "quote_asset": "EURQ",
      "rate":        "0.920000",
      "updated_at":  "2025-01-15T09:00:00.000Z"
    }
  ]
}`}
              />

              <Endpoint
                method="POST" path="/convert" auth
                desc="Execute a currency conversion."
                request={`{
  "from_asset_id": "00000000-0000-0000-0000-000000000001",
  "to_asset_id":   "00000000-0000-0000-0000-000000000002",
  "from_amount":   100
}`}
                response={`{
  "conversion": {
    "from_amount": "100.000000",
    "to_amount":   "92.000000",
    "rate":        "0.920000"
  }
}`}
              />
            </div>

            {/* ── Notifications ── */}
            <div ref={s8.ref} className={s8.cls} style={SECTION}>
              <Anchor id="notifications" />
              <h2 style={{ fontWeight: 800, fontSize: "1.35rem", letterSpacing: "-0.03em", marginBottom: 14 }}>Notifications</h2>
              <p style={{ color: "var(--muted)", fontSize: "0.9rem", lineHeight: 1.7, marginBottom: 20 }}>
                In-app notifications for money events. Push delivery is also supported via VAPID/Web Push.
                Real-time unread counts are available via the SSE stream (<code style={{ color: "var(--accent-h)" }}>GET /stream</code>).
              </p>

              <Endpoint
                method="GET" path="/notifications" auth
                desc="List all notifications for the authenticated user."
                response={`{
  "notifications": [
    {
      "id":         "notif-uuid",
      "type":       "transfer.received",
      "title":      "Payment received",
      "body":       "You received 9.90 RLUSD",
      "is_read":    false,
      "created_at": "2025-01-15T10:01:00.000Z"
    }
  ],
  "unread_count": 1
}`}
              />

              <Endpoint
                method="POST" path="/notifications/mark-all-read" auth
                desc="Mark all notifications as read. Returns the updated unread count (0)."
              />
            </div>

            {/* ── Webhooks ── */}
            <div ref={s9.ref} className={s9.cls}>
              <Anchor id="webhooks" />
              <h2 style={{ fontWeight: 800, fontSize: "1.35rem", letterSpacing: "-0.03em", marginBottom: 14 }}>
                Webhooks &amp; Real-time
              </h2>

              <p style={{ color: "var(--muted)", fontSize: "0.9rem", lineHeight: 1.7, marginBottom: 20 }}>
                Register webhook endpoints via the developer dashboard or API. Each event fires a signed{" "}
                <code style={{ color: "var(--accent-h)" }}>POST</code> to your URL.
                Payloads are HMAC-SHA256 signed with your webhook secret.
              </p>

              <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "20px 24px", marginBottom: 24 }}>
                <div style={{ fontWeight: 700, marginBottom: 12 }}>Available webhook events</div>
                {[
                  ["transfer.completed",    "A transfer was sent or received"],
                  ["topup.completed",       "A top-up was processed"],
                  ["withdrawal.created",    "A withdrawal was requested"],
                  ["withdrawal.approved",   "A withdrawal was approved"],
                  ["withdrawal.rejected",   "A withdrawal was rejected"],
                  ["voucher.redeemed",      "A voucher was redeemed"],
                  ["payment_link.paid",     "A payment link was claimed"],
                  ["recurring.charged",     "A recurring charge executed"],
                ].map(([event, desc]) => (
                  <div key={event} style={{ display: "flex", gap: 16, padding: "8px 0", borderTop: "1px solid var(--border)", alignItems: "center" }}>
                    <code style={{ fontSize: "0.82rem", color: "var(--accent-h)", minWidth: 220 }}>{event}</code>
                    <span style={{ fontSize: "0.85rem", color: "var(--muted)" }}>{desc}</span>
                  </div>
                ))}
              </div>

              <div style={{ background: "rgba(34,197,94,.06)", border: "1px solid rgba(34,197,94,.18)", borderRadius: 12, padding: "18px 20px", marginBottom: 24 }}>
                <div style={{ fontWeight: 800, marginBottom: 8 }}>Webhook lifecycle (recommended)</div>
                <ol style={{ margin: 0, paddingLeft: 18, color: "var(--muted)", lineHeight: 1.7, fontSize: "0.9rem" }}>
                  <li><strong>Register</strong> your HTTPS endpoint and secret (store the secret securely).</li>
                  <li><strong>Verify signature</strong> on every request (HMAC-SHA256) before processing.</li>
                  <li><strong>Acknowledge fast</strong> with HTTP 2xx; enqueue any heavy work asynchronously.</li>
                  <li><strong>Deduplicate</strong> events by event ID (idempotent webhook handler).</li>
                  <li><strong>Handle retries</strong>: failures are retried; make processing safe under at-least-once delivery.</li>
                  <li><strong>Rotate secrets</strong> periodically and re-register endpoints if compromised.</li>
                </ol>
              </div>

              <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "20px 24px", marginBottom: 28 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>SSE real-time stream</div>
                <p style={{ color: "var(--muted)", fontSize: "0.87rem", lineHeight: 1.6, marginBottom: 10 }}>
                  Connect to <code style={{ color: "var(--accent-h)" }}>GET /stream?token=JWT</code> for a persistent
                  Server-Sent Events stream. Events: <code style={{ color: "var(--accent-h)" }}>balances.updated</code>,{" "}
                  <code style={{ color: "var(--accent-h)" }}>notifications.unread</code>,{" "}
                  <code style={{ color: "var(--accent-h)" }}>activity.new</code>.
                  Reconnect with exponential backoff on disconnect.
                </p>
              </div>

              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <Link to="/register"     className="lp-btn lp-btn-primary">Create account →</Link>
                <Link to="/developers"   className="lp-btn lp-btn-ghost">Developers overview</Link>
                <Link to="/architecture" className="lp-btn lp-btn-ghost">Architecture</Link>
              </div>
            </div>

          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
