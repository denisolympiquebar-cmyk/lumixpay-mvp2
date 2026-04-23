"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../middleware/auth");
const frozen_1 = require("../middleware/frozen");
const idempotency_1 = require("../middleware/idempotency");
const require_idempotency_1 = require("../middleware/require-idempotency");
const LedgerService_1 = require("../services/LedgerService");
const pool_1 = require("../db/pool");
const router = (0, express_1.Router)();
// UUID v4 pattern — used to decide whether to look up by id or username
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TransferSchema = zod_1.z.object({
    /**
     * `recipient` accepts either:
     *   - a user UUID (looked up against users.id)
     *   - a username (looked up against users.username, case-insensitive)
     */
    recipient: zod_1.z.string().min(1, "Recipient is required"),
    asset_id: zod_1.z.string().uuid(),
    gross_amount: zod_1.z.number().positive(),
});
/**
 * Resolves a recipient string to a user_id.
 * Returns null if no matching non-system user is found.
 */
async function resolveRecipientUserId(recipient) {
    if (UUID_RE.test(recipient)) {
        const { rows } = await pool_1.pool.query("SELECT id FROM users WHERE id = $1 AND role != 'system'", [recipient]);
        return rows[0]?.id ?? null;
    }
    // Username lookup — case-insensitive (all stored usernames are lowercase,
    // but LOWER() guards against any bypass of the application-layer constraint)
    const { rows } = await pool_1.pool.query("SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND role != 'system'", [recipient]);
    return rows[0]?.id ?? null;
}
// POST /transfers
router.post("/", auth_1.authenticate, frozen_1.requireNotFrozen, require_idempotency_1.requireIdempotencyKey, idempotency_1.idempotent, async (req, res) => {
    const parsed = TransferSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    }
    const { recipient, asset_id, gross_amount } = parsed.data;
    const fromUserId = req.user.sub;
    // Resolve recipient string → user_id
    const toUserId = await resolveRecipientUserId(recipient.trim());
    if (!toUserId) {
        return res.status(404).json({
            error: "Recipient not found. Check the user ID or username and try again.",
            code: "RECIPIENT_NOT_FOUND",
        });
    }
    if (fromUserId === toUserId) {
        return res.status(400).json({ error: "Cannot transfer to yourself" });
    }
    // Resolve sender account
    const { rows: fromRows } = await pool_1.pool.query("SELECT * FROM accounts WHERE user_id = $1 AND asset_id = $2 AND label = 'main'", [fromUserId, asset_id]);
    if (!fromRows[0]) {
        return res.status(404).json({ error: "Sender account not found for requested asset" });
    }
    // Resolve recipient account
    const { rows: toRows } = await pool_1.pool.query("SELECT * FROM accounts WHERE user_id = $1 AND asset_id = $2 AND label = 'main'", [toUserId, asset_id]);
    if (!toRows[0]) {
        return res.status(404).json({ error: "Recipient account not found" });
    }
    try {
        const result = await LedgerService_1.ledgerService.transfer({
            fromAccountId: fromRows[0].id,
            toAccountId: toRows[0].id,
            assetId: asset_id,
            grossAmount: gross_amount,
        });
        return res.status(201).json({
            transfer: result.transfer,
            ledger_entries: result.entries,
        });
    }
    catch (err) {
        console.error("transfer error:", err);
        const status = err.message?.includes("Insufficient") ? 422 : 400;
        return res.status(status).json({ error: err.message ?? "Transfer failed" });
    }
});
exports.default = router;
//# sourceMappingURL=transfers.js.map