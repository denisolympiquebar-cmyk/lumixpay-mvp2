"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../middleware/auth");
const auth_2 = require("../middleware/auth");
const config_1 = require("../config");
const pool_1 = require("../db/pool");
const PushService_1 = require("../services/PushService");
const router = (0, express_1.Router)();
// ── GET /push/vapid-public-key  — expose public key to frontend ───────────────
router.get("/vapid-public-key", (_req, res) => {
    const key = process.env["VAPID_PUBLIC_KEY"] ?? "";
    if (!key)
        return res.status(503).json({ error: "Push notifications not configured" });
    return res.json({ vapidPublicKey: key });
});
// ── POST /push/subscribe  — store / refresh a push subscription ───────────────
const SubscribeSchema = zod_1.z.object({
    endpoint: zod_1.z.string().url(),
    keys: zod_1.z.object({
        p256dh: zod_1.z.string().min(1),
        auth: zod_1.z.string().min(1),
    }),
    userAgent: zod_1.z.string().optional(),
});
router.post("/subscribe", auth_1.authenticate, async (req, res) => {
    const parsed = SubscribeSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    }
    const { endpoint, keys, userAgent } = parsed.data;
    const userId = req.user.sub;
    try {
        // Upsert: update user_id / user_agent if the endpoint already exists
        await pool_1.pool.query(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint)
       DO UPDATE SET user_id = EXCLUDED.user_id,
                     p256dh  = EXCLUDED.p256dh,
                     auth    = EXCLUDED.auth,
                     user_agent = EXCLUDED.user_agent`, [userId, endpoint, keys.p256dh, keys.auth, userAgent ?? null]);
        return res.status(201).json({ ok: true });
    }
    catch (err) {
        console.error("POST /push/subscribe error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// ── POST /push/unsubscribe  — remove a push subscription ─────────────────────
const UnsubscribeSchema = zod_1.z.object({ endpoint: zod_1.z.string().url() });
router.post("/unsubscribe", auth_1.authenticate, async (req, res) => {
    const parsed = UnsubscribeSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    }
    const { endpoint } = parsed.data;
    const userId = req.user.sub;
    try {
        await pool_1.pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2", [endpoint, userId]);
        return res.json({ ok: true });
    }
    catch (err) {
        console.error("POST /push/unsubscribe error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// ── POST /push/test  — authenticated push test helper ─────────────────────────
// Safe-by-default:
//  - In production: admin only.
//  - In non-production: any authenticated user can test a push to their own devices.
const PushTestSchema = zod_1.z.object({
    title: zod_1.z.string().min(1).max(120).optional(),
    body: zod_1.z.string().max(500).optional(),
    url: zod_1.z.string().max(200).optional(),
    user_id: zod_1.z.string().uuid().optional(), // admin only
});
router.post("/test", auth_1.authenticate, (req, res, next) => {
    if (config_1.config.nodeEnv === "production")
        return (0, auth_2.requireRole)("admin")(req, res, next);
    return next();
}, async (req, res) => {
    const parsed = PushTestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    }
    const targetUserId = parsed.data.user_id ?? req.user.sub;
    if (parsed.data.user_id && req.user?.role !== "admin") {
        return res.status(403).json({ error: "Forbidden" });
    }
    await PushService_1.pushService.sendToUser(targetUserId, {
        title: parsed.data.title ?? "LumixPay (test)",
        body: parsed.data.body ?? "Test push notification",
        url: parsed.data.url ?? "/notifications",
        type: "push.test",
    });
    return res.json({ ok: true });
});
exports.default = router;
//# sourceMappingURL=push.js.map