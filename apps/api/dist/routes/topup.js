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
const MockPaymentProvider_1 = require("../services/MockPaymentProvider");
const router = (0, express_1.Router)();
const TopUpSchema = zod_1.z.object({
    asset_id: zod_1.z.string().uuid(),
    gross_amount: zod_1.z.union([
        zod_1.z.literal(10),
        zod_1.z.literal(20),
        zod_1.z.literal(50),
        zod_1.z.literal(100),
    ]),
    simulated_card_last4: zod_1.z.string().regex(/^\d{4}$/, "Must be exactly 4 digits"),
});
// POST /topup
router.post("/", auth_1.authenticate, frozen_1.requireNotFrozen, require_idempotency_1.requireIdempotencyKey, idempotency_1.idempotent, async (req, res) => {
    const parsed = TopUpSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({
            error: "Validation failed",
            details: parsed.error.flatten(),
            allowed_amounts: MockPaymentProvider_1.ALLOWED_TOPUP_AMOUNTS,
        });
    }
    const { asset_id, gross_amount, simulated_card_last4 } = parsed.data;
    const userId = req.user.sub;
    // Resolve user's 'main' account for the requested asset
    const { rows } = await pool_1.pool.query("SELECT * FROM accounts WHERE user_id = $1 AND asset_id = $2 AND label = 'main'", [userId, asset_id]);
    if (!rows[0]) {
        return res.status(404).json({ error: "Account not found for requested asset" });
    }
    const account = rows[0];
    try {
        const result = await LedgerService_1.ledgerService.topUp({
            userId,
            accountId: account.id,
            assetId: asset_id,
            grossAmount: gross_amount,
            simulatedCardLast4: simulated_card_last4,
        });
        return res.status(201).json({
            topup: result.topupTransaction,
            ledger_entries: result.entries,
        });
    }
    catch (err) {
        console.error("topup error:", err);
        const statusCode = err.status ?? 400;
        return res.status(statusCode).json({
            error: err.message ?? "Top-up failed",
            ...(err.code ? { code: err.code, details: err.details } : {}),
        });
    }
});
exports.default = router;
//# sourceMappingURL=topup.js.map