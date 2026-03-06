import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { config } from "./config";

import authRouter          from "./routes/auth";
import accountsRouter      from "./routes/accounts";
import topupRouter         from "./routes/topup";
import transfersRouter     from "./routes/transfers";
import withdrawalsRouter   from "./routes/withdrawals";
import notificationsRouter from "./routes/notifications";
import meRouter            from "./routes/me";
import contactsRouter      from "./routes/contacts";
import paymentLinksRouter  from "./routes/payment-links";
import vouchersRouter      from "./routes/vouchers";
import recurringRouter     from "./routes/recurring";
import apiKeysRouter       from "./routes/api-keys";
import webhooksRouter      from "./routes/webhooks-route";
import adminUsersRouter      from "./routes/admin-users";
import adminLedgerRouter     from "./routes/admin-ledger";
import adminAlertsRouter     from "./routes/admin-alerts";
import adminUserActionsRouter from "./routes/admin-user-actions";
import adminTreasuryRouter    from "./routes/admin-treasury";
import adminDevelopersRouter  from "./routes/admin-developers";
import voucherProductsRouter  from "./routes/voucher-products";
import fxRouter               from "./routes/fx";
import pushRouter             from "./routes/push";
import streamRouter           from "./routes/stream";

import { seedAdminIfEnabled } from "./services/AdminSeedService";
import { startRecurringJob }  from "./services/RecurringService";
import { authLimiter, mutationLimiter, devLimiter } from "./middleware/rate-limit";
import { usageLogger } from "./middleware/usage-logger";

const app = express();

app.use(helmet());
app.use(cors({ origin: process.env["CORS_ORIGIN"] ?? "*" }));
app.use(express.json());

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ── Auth (strict rate limit) ──────────────────────────────────────────────────
app.use("/auth", authLimiter, authRouter);

// ── Account & balance reads ───────────────────────────────────────────────────
// GET /me/accounts, GET /me/accounts/:id/history
app.use("/", accountsRouter);

// ── Profile & username ────────────────────────────────────────────────────────
// GET /me/profile, POST /me/username
app.use("/me", meRouter);

// ── Core money flows (moderate rate limit + usage logging) ───────────────────
app.use("/topup",       mutationLimiter, usageLogger, topupRouter);
app.use("/transfers",   mutationLimiter, usageLogger, transfersRouter);
app.use("/withdrawals", mutationLimiter, usageLogger, withdrawalsRouter);

// ── Notifications ─────────────────────────────────────────────────────────────
app.use("/notifications", notificationsRouter);

// ── Contacts ──────────────────────────────────────────────────────────────────
// GET/POST/DELETE /contacts
app.use("/contacts", contactsRouter);

// ── Payment links (usage logging) ────────────────────────────────────────────
// POST   /payment-links
// GET    /payment-links
// PATCH  /payment-links/:id/disable
// GET    /payment-links/pay/:id       (public — no auth)
// POST   /payment-links/pay/:id/claim (authenticated payer)
app.use("/payment-links", usageLogger, paymentLinksRouter);

// ── Vouchers (usage logging) ──────────────────────────────────────────────────
// POST /vouchers/redeem
// POST /vouchers/admin, GET /vouchers/admin, POST /vouchers/admin/:id/disable
app.use("/vouchers", usageLogger, vouchersRouter);

// ── Recurring payments (usage logging) ───────────────────────────────────────
// POST   /recurring/plans
// GET    /recurring/plans
// GET    /recurring/plans/public/:id
// POST   /recurring/plans/:id/subscribe
// GET    /recurring/subscriptions
// DELETE /recurring/subscriptions/:id
// PATCH  /recurring/plans/:id/pause
app.use("/recurring", usageLogger, recurringRouter);

// ── Developer: API keys (dev rate limit + usage logging) ─────────────────────
app.use("/me/api-keys", devLimiter, usageLogger, apiKeysRouter);

// ── Developer: Webhooks (dev rate limit + usage logging) ─────────────────────
app.use("/me/webhooks", devLimiter, usageLogger, webhooksRouter);

// ── Voucher products + purchase (moderate rate limit on mutations) ────────────
// GET  /voucher-products           — public list of products
// POST /vouchers/purchase          — user buys a voucher using balance
// GET  /vouchers/mine              — user's purchased vouchers
app.use("/voucher-products", voucherProductsRouter);
// purchase + mine sub-routes live on the same /vouchers prefix as the existing router
app.use("/vouchers", mutationLimiter, voucherProductsRouter);

// ── FX rates & conversion ─────────────────────────────────────────────────────
// GET  /fx-rate?base=&quote=        — single rate lookup
// GET  /fx-rates/all                — all pairs
// POST /convert                     — execute conversion
app.use("/fx-rate",  fxRouter);
app.use("/fx-rates", fxRouter);
app.use("/convert",  usageLogger, fxRouter);

// ── Admin ─────────────────────────────────────────────────────────────────────
app.use("/admin/users",    adminUsersRouter);
app.use("/admin/users",    adminUserActionsRouter);   // promote/demote/freeze/unfreeze
app.use("/admin/ledger",   adminLedgerRouter);
app.use("/admin/alerts",   adminAlertsRouter);
app.use("/admin/treasury",    adminTreasuryRouter);
app.use("/admin/developers",  adminDevelopersRouter);
// Revoke / disable shortcuts that are nested under /admin/api-keys and /admin/webhooks
app.use("/admin/api-keys",    adminDevelopersRouter);
app.use("/admin/webhooks",    adminDevelopersRouter);

// ── Push notifications ────────────────────────────────────────────────────────
// GET  /push/vapid-public-key   — expose VAPID public key
// POST /push/subscribe          — register device
// POST /push/unsubscribe        — deregister device
app.use("/push", pushRouter);

// ── Server-Sent Events ────────────────────────────────────────────────────────
// GET  /stream        — user real-time updates (auth via ?token=...)
// GET  /stream/admin  — admin real-time updates
app.use("/stream", streamRouter);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ── Startup ───────────────────────────────────────────────────────────────────
// Seeding runs BEFORE listen so first-request admin login always works.
async function start(): Promise<void> {
  await seedAdminIfEnabled().catch((e) =>
    console.error("[AdminSeed] Startup seed failed (non-fatal):", e)
  );

  app.listen(config.port, () => {
    console.log(`LumixPay API running on http://localhost:${config.port}`);
    console.log(`Environment: ${config.nodeEnv}`);
  });

  startRecurringJob();
}

void start();

export default app;
