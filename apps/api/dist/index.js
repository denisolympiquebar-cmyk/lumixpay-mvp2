"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const config_1 = require("./config");
const auth_1 = __importDefault(require("./routes/auth"));
const accounts_1 = __importDefault(require("./routes/accounts"));
const topup_1 = __importDefault(require("./routes/topup"));
const transfers_1 = __importDefault(require("./routes/transfers"));
const withdrawals_1 = __importDefault(require("./routes/withdrawals"));
const notifications_1 = __importDefault(require("./routes/notifications"));
const me_1 = __importDefault(require("./routes/me"));
const contacts_1 = __importDefault(require("./routes/contacts"));
const payment_links_1 = __importDefault(require("./routes/payment-links"));
const vouchers_1 = __importDefault(require("./routes/vouchers"));
const recurring_1 = __importDefault(require("./routes/recurring"));
const api_keys_1 = __importDefault(require("./routes/api-keys"));
const webhooks_route_1 = __importDefault(require("./routes/webhooks-route"));
const admin_users_1 = __importDefault(require("./routes/admin-users"));
const admin_ledger_1 = __importDefault(require("./routes/admin-ledger"));
const admin_alerts_1 = __importDefault(require("./routes/admin-alerts"));
const admin_user_actions_1 = __importDefault(require("./routes/admin-user-actions"));
const admin_treasury_1 = __importDefault(require("./routes/admin-treasury"));
const admin_developers_1 = __importDefault(require("./routes/admin-developers"));
const voucher_products_1 = __importDefault(require("./routes/voucher-products"));
const fx_1 = __importDefault(require("./routes/fx"));
const push_1 = __importDefault(require("./routes/push"));
const stream_1 = __importDefault(require("./routes/stream"));
const AdminSeedService_1 = require("./services/AdminSeedService");
const RecurringService_1 = require("./services/RecurringService");
const rate_limit_1 = require("./middleware/rate-limit");
const usage_logger_1 = require("./middleware/usage-logger");
const correlation_1 = require("./middleware/correlation");
const pool_1 = require("./db/pool");
const app = (0, express_1.default)();
// Required when running behind Fly.io / any reverse proxy so that
// express-rate-limit and req.ip see the real client IP, not the proxy IP.
app.set("trust proxy", 1);
app.use((0, helmet_1.default)());
// Harden CORS: explicit allow-list only (comma-separated).
// Use "*" only if explicitly set to "*" (backward compatible for dev).
const corsOrigin = process.env["CORS_ORIGIN"] ?? "*";
const corsAllowList = corsOrigin
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
app.use((0, cors_1.default)({
    origin: (origin, cb) => {
        if (!origin)
            return cb(null, true); // non-browser clients
        if (corsAllowList.includes("*"))
            return cb(null, true);
        if (corsAllowList.includes(origin))
            return cb(null, true);
        return cb(new Error("CORS not allowed"), false);
    },
    credentials: true,
}));
app.use(correlation_1.correlationId);
app.use(express_1.default.json());
// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", async (_req, res) => {
    const start = Date.now();
    try {
        await pool_1.pool.query("SELECT 1");
        const dbLatencyMs = Date.now() - start;
        return res.json({ status: "ok", db: { ok: true, latency_ms: dbLatencyMs }, queue: { ok: true } });
    }
    catch (err) {
        console.error("health db check failed:", err);
        const dbLatencyMs = Date.now() - start;
        return res.status(503).json({ status: "degraded", db: { ok: false, latency_ms: dbLatencyMs }, queue: { ok: true } });
    }
});
// ── Metrics (minimal Prometheus-compatible) ───────────────────────────────────
app.get("/metrics", async (_req, res) => {
    try {
        const [usage, alerts] = await Promise.all([
            pool_1.pool.query("SELECT COUNT(*)::text AS c FROM api_usage_logs"),
            pool_1.pool.query("SELECT COUNT(*)::text AS c FROM admin_alerts WHERE is_resolved = false"),
        ]);
        const lines = [
            "# HELP lumixpay_api_usage_logs_total Total api_usage_logs rows",
            "# TYPE lumixpay_api_usage_logs_total counter",
            `lumixpay_api_usage_logs_total ${Number(usage.rows[0]?.c ?? "0")}`,
            "# HELP lumixpay_admin_alerts_open_total Open admin alerts",
            "# TYPE lumixpay_admin_alerts_open_total gauge",
            `lumixpay_admin_alerts_open_total ${Number(alerts.rows[0]?.c ?? "0")}`,
        ];
        res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
        return res.send(lines.join("\n") + "\n");
    }
    catch (err) {
        console.error("/metrics error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// ── Version ───────────────────────────────────────────────────────────────────
app.get("/version", (_req, res) => res.json({ name: "lumixpay-api", version: "1.0.0", env: config_1.config.nodeEnv }));
// ── Auth (strict rate limit) ──────────────────────────────────────────────────
app.use("/auth", rate_limit_1.authLimiter, auth_1.default);
// ── Account & balance reads ───────────────────────────────────────────────────
// GET /me/accounts, GET /me/accounts/:id/history
app.use("/", accounts_1.default);
// ── Profile & username ────────────────────────────────────────────────────────
// GET /me/profile, POST /me/username, POST/PATCH/DELETE /me/profile/wallet*
app.use("/me", me_1.default);
// ── Core money flows (moderate rate limit + usage logging) ───────────────────
app.use("/topup", rate_limit_1.mutationLimiter, usage_logger_1.usageLogger, topup_1.default);
app.use("/transfers", rate_limit_1.mutationLimiter, usage_logger_1.usageLogger, transfers_1.default);
app.use("/withdrawals", rate_limit_1.mutationLimiter, usage_logger_1.usageLogger, withdrawals_1.default);
// ── Notifications ─────────────────────────────────────────────────────────────
app.use("/notifications", notifications_1.default);
// ── Contacts ──────────────────────────────────────────────────────────────────
// GET/POST/DELETE /contacts
app.use("/contacts", contacts_1.default);
// ── Payment links (usage logging) ────────────────────────────────────────────
// POST   /payment-links
// GET    /payment-links
// PATCH  /payment-links/:id/disable
// GET    /payment-links/pay/:id       (public — no auth)
// POST   /payment-links/pay/:id/claim (authenticated payer)
app.use("/payment-links", usage_logger_1.usageLogger, payment_links_1.default);
// ── Vouchers (usage logging) ──────────────────────────────────────────────────
// POST /vouchers/redeem
// POST /vouchers/admin, GET /vouchers/admin, POST /vouchers/admin/:id/disable
app.use("/vouchers", usage_logger_1.usageLogger, vouchers_1.default);
// ── Recurring payments (usage logging) ───────────────────────────────────────
// POST   /recurring/plans
// GET    /recurring/plans
// GET    /recurring/plans/public/:id
// POST   /recurring/plans/:id/subscribe
// GET    /recurring/subscriptions
// DELETE /recurring/subscriptions/:id
// PATCH  /recurring/plans/:id/pause
app.use("/recurring", usage_logger_1.usageLogger, recurring_1.default);
// ── Developer: API keys (dev rate limit + usage logging) ─────────────────────
app.use("/me/api-keys", rate_limit_1.devLimiter, usage_logger_1.usageLogger, api_keys_1.default);
// ── Developer: Webhooks (dev rate limit + usage logging) ─────────────────────
app.use("/me/webhooks", rate_limit_1.devLimiter, usage_logger_1.usageLogger, webhooks_route_1.default);
// ── Voucher products + purchase (moderate rate limit on mutations) ────────────
// GET  /voucher-products           — public list of products
// POST /vouchers/purchase          — user buys a voucher using balance
// GET  /vouchers/mine              — user's purchased vouchers
app.use("/voucher-products", voucher_products_1.default);
// purchase + mine sub-routes live on the same /vouchers prefix as the existing router
app.use("/vouchers", rate_limit_1.mutationLimiter, voucher_products_1.default);
// ── FX rates & conversion ─────────────────────────────────────────────────────
// GET  /fx-rate?base=&quote=        — single rate lookup
// GET  /fx-rates/all                — all pairs
// POST /convert                     — execute conversion
app.use("/fx-rate", fx_1.default);
app.use("/fx-rates", fx_1.default);
app.use("/convert", usage_logger_1.usageLogger, fx_1.default);
// ── Admin ─────────────────────────────────────────────────────────────────────
app.use("/admin/users", admin_users_1.default);
app.use("/admin/users", admin_user_actions_1.default); // promote/demote/freeze/unfreeze
app.use("/admin/ledger", admin_ledger_1.default);
app.use("/admin/alerts", admin_alerts_1.default);
app.use("/admin/treasury", admin_treasury_1.default);
app.use("/admin/developers", admin_developers_1.default);
// Revoke / disable shortcuts that are nested under /admin/api-keys and /admin/webhooks
app.use("/admin/api-keys", admin_developers_1.default);
app.use("/admin/webhooks", admin_developers_1.default);
// ── Push notifications ────────────────────────────────────────────────────────
// GET  /push/vapid-public-key   — expose VAPID public key
// POST /push/subscribe          — register device
// POST /push/unsubscribe        — deregister device
app.use("/push", push_1.default);
// ── Server-Sent Events ────────────────────────────────────────────────────────
// GET  /stream        — user real-time updates (auth via ?token=...)
// GET  /stream/admin  — admin real-time updates
app.use("/stream", stream_1.default);
// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "Not found" }));
// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
    console.error("Unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
});
// ── Startup ───────────────────────────────────────────────────────────────────
// Seeding runs BEFORE listen so first-request admin login always works.
async function start() {
    await (0, AdminSeedService_1.seedAdminIfEnabled)().catch((e) => console.error("[AdminSeed] Startup seed failed (non-fatal):", e));
    app.listen(config_1.config.port, () => {
        console.log(`LumixPay API running on http://localhost:${config_1.config.port}`);
        console.log(`Environment: ${config_1.config.nodeEnv}`);
    });
    (0, RecurringService_1.startRecurringJob)();
}
void start();
exports.default = app;
//# sourceMappingURL=index.js.map