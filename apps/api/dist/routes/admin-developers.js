"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const pool_1 = require("../db/pool");
const router = (0, express_1.Router)();
const guard = [auth_1.authenticate, (0, auth_1.requireRole)("admin")];
// ── GET /admin/developers  — all users who have API keys ─────────────────────
router.get("/", ...guard, async (_req, res) => {
    try {
        const { rows } = await pool_1.pool.query(`
      SELECT
        u.id, u.email, u.full_name, u.username, u.role, u.created_at,
        COUNT(DISTINCT ak.id) FILTER (WHERE ak.revoked_at IS NULL) AS active_keys,
        COUNT(DISTINCT ak.id)                                       AS total_keys,
        COUNT(DISTINCT wh.id) FILTER (WHERE wh.status = 'active') AS active_webhooks,
        COUNT(DISTINCT wh.id)                                        AS total_webhooks
      FROM users u
      LEFT JOIN api_keys ak ON ak.user_id = u.id
      LEFT JOIN webhooks  wh ON wh.user_id = u.id
      WHERE ak.id IS NOT NULL OR wh.id IS NOT NULL
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);
        return res.json({ developers: rows });
    }
    catch (err) {
        console.error("GET /admin/developers error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// ── GET /admin/developers/:user_id  — detail for one developer ───────────────
router.get("/:user_id", ...guard, async (req, res) => {
    const { user_id } = req.params;
    try {
        const [userRes, keysRes, webhooksRes, usageRes] = await Promise.all([
            pool_1.pool.query("SELECT id, email, full_name, username, role, created_at FROM users WHERE id = $1", [user_id]),
            pool_1.pool.query(`SELECT id, name, last4, created_at, revoked_at
           FROM api_keys
          WHERE user_id = $1
          ORDER BY created_at DESC`, [user_id]),
            pool_1.pool.query(`SELECT id, url, events, status, created_at,
                (SELECT COUNT(*) FROM webhook_deliveries wd WHERE wd.webhook_id = webhooks.id) AS delivery_count,
                (SELECT wd2.status FROM webhook_deliveries wd2 WHERE wd2.webhook_id = webhooks.id ORDER BY wd2.created_at DESC LIMIT 1) AS last_delivery_status
           FROM webhooks
          WHERE user_id = $1
          ORDER BY created_at DESC`, [user_id]),
            pool_1.pool.query(`SELECT route, method, COUNT(*) AS requests,
                ROUND(AVG(response_time_ms)) AS avg_ms,
                MAX(created_at) AS last_seen
           FROM api_usage_logs
          WHERE user_id = $1
          GROUP BY route, method
          ORDER BY requests DESC
          LIMIT 20`, [user_id]),
        ]);
        if (!userRes.rows[0])
            return res.status(404).json({ error: "User not found" });
        return res.json({
            user: userRes.rows[0],
            apiKeys: keysRes.rows,
            webhooks: webhooksRes.rows,
            usage: usageRes.rows,
        });
    }
    catch (err) {
        console.error(`GET /admin/developers/${user_id} error:`, err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// ── POST /admin/api-keys/:id/revoke ──────────────────────────────────────────
router.post("/api-keys/:id/revoke", ...guard, async (req, res) => {
    try {
        const { rowCount } = await pool_1.pool.query("UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL", [req.params["id"]]);
        if (!rowCount)
            return res.status(404).json({ error: "API key not found or already revoked" });
        return res.json({ ok: true });
    }
    catch (err) {
        console.error("POST /admin/api-keys/:id/revoke error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// ── POST /admin/webhooks/:id/disable ─────────────────────────────────────────
router.post("/webhooks/:id/disable", ...guard, async (req, res) => {
    try {
        const { rowCount } = await pool_1.pool.query("UPDATE webhooks SET status = 'disabled' WHERE id = $1 AND status = 'active'", [req.params["id"]]);
        if (!rowCount)
            return res.status(404).json({ error: "Webhook not found or already disabled" });
        return res.json({ ok: true });
    }
    catch (err) {
        console.error("POST /admin/webhooks/:id/disable error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
exports.default = router;
//# sourceMappingURL=admin-developers.js.map