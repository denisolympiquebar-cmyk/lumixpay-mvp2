import React from "react";
import { Link } from "react-router-dom";
import PublicLayout, { useReveal } from "../components/PublicLayout";

const feeRows = [
  { action: "Top-up (card / mock)", fee: "1%", when: "Deducted from credited amount", example: "Top up $100 → $99 credited" },
  { action: "Transfer (send)",       fee: "1%", when: "Deducted from sender at send time", example: "Send $50 → recipient gets $49.50" },
  { action: "Receive a transfer",    fee: "Free", when: "—", example: "You receive $49.50 as sent" },
  { action: "Withdrawal (lock)",     fee: "1%", when: "Deducted at escrow lock; non-refundable on rejection", example: "Withdraw $100 → $99 locked" },
  { action: "Voucher redeem",        fee: "Free", when: "Full face value credited", example: "Redeem $50 voucher → $50 credited" },
  { action: "Payment link payment",  fee: "1%", when: "Deducted from payer at payment time", example: "$10 payment → recipient gets $9.90" },
  { action: "Recurring payment",     fee: "1%", when: "Deducted per execution", example: "Same as transfer" },
  { action: "API access",            fee: "Free", when: "During MVP phase", example: "—" },
  { action: "Webhooks",              fee: "Free", when: "During MVP phase", example: "—" },
];

const faqItems = [
  {
    q: "Is the 1% fee the only fee?",
    a: "Yes. There are no monthly fees, setup fees, or per-request charges. Every money movement costs exactly 1% of the gross amount, collected by the platform's fee_collector account.",
  },
  {
    q: "What happens to the fee on a rejected withdrawal?",
    a: "The 1% fee is charged at escrow lock time and is not refunded if an admin rejects the withdrawal. The net amount (gross − fee) is returned to your available balance.",
  },
  {
    q: "Are fees charged on receiving a transfer?",
    a: "No. Only the sender pays the fee. If someone sends you $50 with a $0.50 fee, you receive $49.50.",
  },
  {
    q: "When will pricing change?",
    a: "This is MVP pricing. We'll announce any changes in advance. API access and webhooks are free during the MVP phase.",
  },
];

export default function PricingPage() {
  const hero = useReveal();
  const table = useReveal();
  const faq = useReveal();

  return (
    <PublicLayout>
      {/* ── Hero ────────────────────────────────────────────────────────── */}
      <section className="lp-page-hero lp-section-sm">
        <div className="lp-container">
          <div ref={hero.ref} className={hero.cls}>
            <span className="lp-badge">Pricing</span>
            <h1 className="lp-h2-hero">Simple, honest fees.</h1>
            <p style={{ color: "var(--muted)", fontSize: "1.05rem", maxWidth: 520, lineHeight: 1.7, marginTop: 4 }}>
              One flat rate on every money movement. No subscriptions, no hidden costs, no per-seat pricing.
            </p>
          </div>
        </div>
      </section>

      <hr className="lp-divider" />

      {/* ── Fee table ───────────────────────────────────────────────────── */}
      <section className="lp-section">
        <div className="lp-container">
          <div ref={table.ref} className={table.cls}>
            <div
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 16,
                overflow: "hidden",
              }}
            >
              <div style={{ padding: "28px 28px 20px", borderBottom: "1px solid var(--border)" }}>
                <h2 style={{ fontWeight: 800, fontSize: "1.3rem", letterSpacing: "-0.03em" }}>
                  Fee schedule
                </h2>
                <p className="muted" style={{ marginTop: 6 }}>
                  All fees are charged in the asset being moved (RLUSD or EURQ). Fee rate: 1%.
                </p>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table className="lp-table">
                  <thead>
                    <tr>
                      <th>Action</th>
                      <th>Fee</th>
                      <th>When charged</th>
                      <th>Example</th>
                    </tr>
                  </thead>
                  <tbody>
                    {feeRows.map((r) => (
                      <tr key={r.action}>
                        <td style={{ fontWeight: 600 }}>{r.action}</td>
                        <td>
                          <span
                            style={{
                              fontWeight: 700,
                              color: r.fee === "Free" ? "var(--success)" : "var(--text)",
                            }}
                          >
                            {r.fee}
                          </span>
                        </td>
                        <td style={{ color: "var(--muted)", fontSize: "0.87rem" }}>{r.when}</td>
                        <td style={{ color: "var(--muted)", fontSize: "0.87rem", fontFamily: "ui-monospace, monospace" }}>
                          {r.example}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Fee callout */}
            <div
              style={{
                marginTop: 24,
                background: "rgba(99,102,241,0.08)",
                border: "1px solid rgba(99,102,241,0.25)",
                borderRadius: 12,
                padding: "20px 24px",
                display: "flex",
                gap: 16,
                alignItems: "flex-start",
              }}
            >
              <span style={{ fontSize: "1.3rem", flexShrink: 0 }}>ℹ️</span>
              <div>
                <p style={{ fontWeight: 700, marginBottom: 4 }}>Fee formula</p>
                <p className="muted" style={{ fontSize: "0.88rem", lineHeight: 1.6 }}>
                  <code style={{ color: "var(--accent-h)" }}>fee = gross × 0.01</code> &nbsp;·&nbsp;
                  <code style={{ color: "var(--accent-h)" }}>net = gross − fee</code>
                  &nbsp; — calculated server-side in
                  <code style={{ color: "var(--accent-h)" }}> FeeService.ts</code> using Decimal.js
                  for precision. The web app previews the fee before you confirm.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <hr className="lp-divider" />

      {/* ── FAQ ─────────────────────────────────────────────────────────── */}
      <section className="lp-section">
        <div className="lp-container" style={{ maxWidth: 740 }}>
          <div ref={faq.ref} className={faq.cls}>
            <h2 style={{ fontWeight: 800, fontSize: "1.6rem", letterSpacing: "-0.03em", marginBottom: 32 }}>
              Frequently asked
            </h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {faqItems.map((item) => (
                <div
                  key={item.q}
                  className="card"
                  style={{ padding: "22px 24px" }}
                >
                  <p style={{ fontWeight: 700, marginBottom: 8 }}>{item.q}</p>
                  <p className="muted" style={{ lineHeight: 1.65, fontSize: "0.9rem" }}>{item.a}</p>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 40, textAlign: "center" }}>
              <p className="muted" style={{ marginBottom: 16 }}>
                Questions about pricing or integration?
              </p>
              <Link to="/docs" className="lp-btn lp-btn-primary">
                Read the docs →
              </Link>
            </div>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
