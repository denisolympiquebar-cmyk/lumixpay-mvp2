"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const crypto_1 = __importDefault(require("crypto"));
const auth_1 = require("../middleware/auth");
const pool_1 = require("../db/pool");
const WebhookService_1 = require("../services/WebhookService");
const router = (0, express_1.Router)();
const CreateWebhookSchema = zod_1.z.object({
    url: zod_1.z.string().url().max(500),
    events: zod_1.z.array(zod_1.z.string()).min(1),
});
// GET /me/webhooks
router.get("/", auth_1.authenticate, async (req, res) => {
    try {
        const { rows } = await pool_1.pool.query(`SELECT id, user_id, url, events, status, created_at
         FROM webhooks WHERE user_id = $1 ORDER BY created_at DESC`, [req.user.sub]);
        return res.json({ webhooks: rows, available_events: WebhookService_1.ALL_WEBHOOK_EVENTS });
    }
    catch (err) {
        console.error("GET /me/webhooks error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// POST /me/webhooks
router.post("/", auth_1.authenticate, async (req, res) => {
    const parsed = CreateWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    }
    const { url, events } = parsed.data;
    const secret = `whsec_${crypto_1.default.randomBytes(20).toString("hex")}`;
    try {
        const { rows } = await pool_1.pool.query(`INSERT INTO webhooks (user_id, url, secret, events)
       VALUES ($1,$2,$3,$4) RETURNING *`, [req.user.sub, url, secret, JSON.stringify(events)]);
        return res.status(201).json({
            webhook: rows[0],
            warning: "Store the secret securely — it is shown once for verification purposes.",
        });
    }
    catch (err) {
        console.error("POST /me/webhooks error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// DELETE /me/webhooks/:id
router.delete("/:id", auth_1.authenticate, async (req, res) => {
    try {
        const { rowCount } = await pool_1.pool.query("UPDATE webhooks SET status = 'disabled' WHERE id = $1 AND user_id = $2", [req.params["id"], req.user.sub]);
        if (!rowCount)
            return res.status(404).json({ error: "Webhook not found" });
        return res.json({ ok: true });
    }
    catch (err) {
        console.error("DELETE /me/webhooks/:id error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// GET /me/webhooks/:id/deliveries
router.get("/:id/deliveries", auth_1.authenticate, async (req, res) => {
    try {
        const limit = Math.min(parseInt(String(req.query["limit"] ?? "50"), 10), 200);
        const { rows } = await pool_1.pool.query(`SELECT wd.*
         FROM webhook_deliveries wd
         JOIN webhooks wh ON wh.id = wd.webhook_id
        WHERE wd.webhook_id = $1 AND wh.user_id = $2
        ORDER BY wd.created_at DESC LIMIT $3`, [req.params["id"], req.user.sub, limit]);
        return res.json({ deliveries: rows });
    }
    catch (err) {
        console.error("GET /me/webhooks/:id/deliveries error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
exports.default = router;
//# sourceMappingURL=webhooks-route.js.map