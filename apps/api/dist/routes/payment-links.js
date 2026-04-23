"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../middleware/auth");
const idempotency_1 = require("../middleware/idempotency");
const pool_1 = require("../db/pool");
const LedgerService_1 = require("../services/LedgerService");
const NotificationService_1 = require("../services/NotificationService");
const router = (0, express_1.Router)();
const CreateLinkSchema = zod_1.z.object({
    asset_id: zod_1.z.string().uuid(),
    amount: zod_1.z.number().positive().optional(),
    description: zod_1.z.string().max(255).optional(),
    max_uses: zod_1.z.number().int().positive().optional(),
    expires_at: zod_1.z.string().datetime().optional(),
});
const ClaimSchema = zod_1.z.object({
    amount: zod_1.z.number().positive().optional(), // required if link has no fixed amount
});
// POST /payment-links
router.post("/", auth_1.authenticate, idempotency_1.idempotent, async (req, res) => {
    const parsed = CreateLinkSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    }
    const { asset_id, amount, description, max_uses, expires_at } = parsed.data;
    try {
        const { rows } = await pool_1.pool.query(`INSERT INTO payment_links (creator_user_id, asset_id, amount, description, max_uses, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`, [req.user.sub, asset_id, amount ?? null, description ?? null, max_uses ?? null, expires_at ?? null]);
        return res.status(201).json({ payment_link: rows[0] });
    }
    catch (err) {
        console.error("POST /payment-links error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// GET /payment-links — list mine
router.get("/", auth_1.authenticate, async (req, res) => {
    try {
        const { rows } = await pool_1.pool.query(`SELECT pl.*, a.currency_code, a.display_symbol
         FROM payment_links pl
         JOIN assets a ON a.id = pl.asset_id
        WHERE pl.creator_user_id = $1
        ORDER BY pl.created_at DESC`, [req.user.sub]);
        return res.json({ payment_links: rows });
    }
    catch (err) {
        console.error("GET /payment-links error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// PATCH /payment-links/:id/disable
router.patch("/:id/disable", auth_1.authenticate, async (req, res) => {
    try {
        const { rowCount } = await pool_1.pool.query("UPDATE payment_links SET status = 'disabled' WHERE id = $1 AND creator_user_id = $2", [req.params["id"], req.user.sub]);
        if (!rowCount)
            return res.status(404).json({ error: "Payment link not found" });
        return res.json({ ok: true });
    }
    catch (err) {
        console.error("PATCH /payment-links/:id/disable error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// GET /pay/:id — public, no auth required
router.get("/pay/:id", async (req, res) => {
    try {
        const { rows } = await pool_1.pool.query(`SELECT pl.*, a.currency_code, a.display_symbol, a.display_name,
              u.email AS creator_email, u.full_name AS creator_name, u.username AS creator_username
         FROM payment_links pl
         JOIN assets a ON a.id = pl.asset_id
         JOIN users u ON u.id = pl.creator_user_id
        WHERE pl.id = $1`, [req.params["id"]]);
        if (!rows[0])
            return res.status(404).json({ error: "Payment link not found" });
        const link = rows[0];
        if (link.status !== "active")
            return res.status(410).json({ error: "Payment link is no longer active" });
        if (link.expires_at && new Date(link.expires_at) < new Date()) {
            return res.status(410).json({ error: "Payment link has expired" });
        }
        if (link.max_uses !== null && link.uses_count >= link.max_uses) {
            return res.status(410).json({ error: "Payment link has reached its maximum uses" });
        }
        // Strip sensitive creator info
        const { creator_email: _ce, ...safeLink } = link;
        return res.json({ payment_link: safeLink });
    }
    catch (err) {
        console.error("GET /pay/:id error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// POST /pay/:id/claim — authenticated payer
router.post("/pay/:id/claim", auth_1.authenticate, idempotency_1.idempotent, async (req, res) => {
    const claimParsed = ClaimSchema.safeParse(req.body);
    if (!claimParsed.success) {
        return res.status(400).json({ error: "Validation failed", details: claimParsed.error.flatten() });
    }
    try {
        const { rows: linkRows } = await pool_1.pool.query("SELECT * FROM payment_links WHERE id = $1 FOR UPDATE", [req.params["id"]]);
        const link = linkRows[0];
        if (!link)
            return res.status(404).json({ error: "Payment link not found" });
        if (link.status !== "active")
            return res.status(410).json({ error: "Payment link is no longer active" });
        if (link.expires_at && new Date(link.expires_at) < new Date()) {
            return res.status(410).json({ error: "Payment link has expired" });
        }
        if (link.max_uses !== null && link.uses_count >= link.max_uses) {
            return res.status(410).json({ error: "Payment link reached maximum uses" });
        }
        if (link.creator_user_id === req.user.sub) {
            return res.status(400).json({ error: "Cannot pay your own payment link" });
        }
        const grossAmount = link.amount !== null ? parseFloat(link.amount) : claimParsed.data.amount;
        if (!grossAmount) {
            return res.status(400).json({ error: "This link requires you to provide an amount" });
        }
        // Resolve payer and creator accounts
        const { rows: payerRows } = await pool_1.pool.query("SELECT * FROM accounts WHERE user_id = $1 AND asset_id = $2 AND label = 'main'", [req.user.sub, link.asset_id]);
        const { rows: creatorRows } = await pool_1.pool.query("SELECT * FROM accounts WHERE user_id = $1 AND asset_id = $2 AND label = 'main'", [link.creator_user_id, link.asset_id]);
        if (!payerRows[0])
            return res.status(404).json({ error: "Payer account not found for this asset" });
        if (!creatorRows[0])
            return res.status(404).json({ error: "Creator account not found for this asset" });
        const result = await LedgerService_1.ledgerService.transfer({
            fromAccountId: payerRows[0].id,
            toAccountId: creatorRows[0].id,
            assetId: link.asset_id,
            grossAmount,
        });
        // Increment uses_count
        await pool_1.pool.query("UPDATE payment_links SET uses_count = uses_count + 1 WHERE id = $1", [link.id]);
        // Notify both parties
        void NotificationService_1.notificationService.create({
            userId: req.user.sub,
            type: "payment_link.paid",
            title: "Payment sent via link",
            body: `You paid ${grossAmount} via payment link`,
            metadata: { payment_link_id: link.id, amount: grossAmount },
        }).catch(() => { });
        void NotificationService_1.notificationService.create({
            userId: link.creator_user_id,
            type: "payment_link.paid",
            title: "Payment link used",
            body: `Your payment link received ${result.transfer.net_amount}`,
            metadata: { payment_link_id: link.id, amount: result.transfer.net_amount },
        }).catch(() => { });
        return res.status(201).json({ transfer: result.transfer });
    }
    catch (err) {
        console.error("POST /pay/:id/claim error:", err);
        const status = err.message?.includes("Insufficient") ? 422 : 500;
        return res.status(status).json({ error: err.message ?? "Payment failed" });
    }
});
exports.default = router;
//# sourceMappingURL=payment-links.js.map