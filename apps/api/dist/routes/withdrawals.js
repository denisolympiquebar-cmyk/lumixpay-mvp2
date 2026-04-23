"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../middleware/auth");
const frozen_1 = require("../middleware/frozen");
const idempotency_1 = require("../middleware/idempotency");
const require_idempotency_1 = require("../middleware/require-idempotency");
const withdrawal_risk_1 = require("../middleware/withdrawal-risk");
const LedgerService_1 = require("../services/LedgerService");
const pool_1 = require("../db/pool");
const AuditLogService_1 = require("../services/AuditLogService");
const router = (0, express_1.Router)();
const WithdrawalRequestSchema = zod_1.z.object({
    asset_id: zod_1.z.string().uuid(),
    gross_amount: zod_1.z.number().positive(),
    xrpl_destination_address: zod_1.z
        .string()
        .regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/, "Invalid XRPL address"),
    xrpl_destination_tag: zod_1.z.number().int().nonnegative().optional(),
});
const ReviewSchema = zod_1.z.object({
    decision: zod_1.z.enum(["approve", "reject"]),
    note: zod_1.z.string().max(1000).optional(),
});
// POST /withdrawals — user requests a withdrawal
router.post("/", auth_1.authenticate, frozen_1.requireNotFrozen, require_idempotency_1.requireIdempotencyKey, idempotency_1.idempotent, withdrawal_risk_1.withdrawalRiskGuard, async (req, res) => {
    const parsed = WithdrawalRequestSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    }
    const { asset_id, gross_amount, xrpl_destination_address, xrpl_destination_tag } = parsed.data;
    const userId = req.user.sub;
    const { rows } = await pool_1.pool.query("SELECT * FROM accounts WHERE user_id = $1 AND asset_id = $2 AND label = 'main'", [userId, asset_id]);
    if (!rows[0]) {
        return res.status(404).json({ error: "Account not found for requested asset" });
    }
    try {
        const withdrawal = await LedgerService_1.ledgerService.requestWithdrawal({
            userId,
            accountId: rows[0].id,
            assetId: asset_id,
            grossAmount: gross_amount,
            xrplDestinationAddress: xrpl_destination_address,
            xrplDestinationTag: xrpl_destination_tag,
        });
        return res.status(201).json({ withdrawal });
    }
    catch (err) {
        console.error("withdrawal request error:", err);
        const status = err.message?.includes("Insufficient") ? 422 : 400;
        return res.status(status).json({ error: err.message ?? "Withdrawal request failed" });
    }
});
// GET /withdrawals — user's own withdrawal history
router.get("/", auth_1.authenticate, async (req, res) => {
    const userId = req.user.sub;
    const limit = Math.min(parseInt(String(req.query["limit"] ?? "50"), 10), 200);
    const offset = parseInt(String(req.query["offset"] ?? "0"), 10);
    const { rows } = await pool_1.pool.query(`SELECT wr.*, a.currency_code AS currency
       FROM withdrawal_requests wr
       JOIN assets a ON a.id = wr.asset_id
      WHERE wr.user_id = $1
      ORDER BY wr.created_at DESC
      LIMIT $2 OFFSET $3`, [userId, limit, offset]);
    return res.json({ withdrawals: rows });
});
// GET /admin/withdrawals — admin: list pending withdrawals
router.get("/admin", auth_1.authenticate, (0, auth_1.requireRole)("admin"), async (req, res) => {
    const status = String(req.query["status"] ?? "pending");
    const limit = Math.min(parseInt(String(req.query["limit"] ?? "50"), 10), 200);
    const offset = parseInt(String(req.query["offset"] ?? "0"), 10);
    const { rows } = await pool_1.pool.query(`SELECT wr.*, u.email AS user_email, a.currency_code AS currency
         FROM withdrawal_requests wr
         JOIN users  u ON u.id = wr.user_id
         JOIN assets a ON a.id = wr.asset_id
        WHERE wr.status = $1
        ORDER BY wr.created_at ASC
        LIMIT $2 OFFSET $3`, [status, limit, offset]);
    return res.json({ withdrawals: rows });
});
// POST /admin/withdrawals/:id/review — admin: approve or reject
router.post("/admin/:id/review", auth_1.authenticate, (0, auth_1.requireRole)("admin"), async (req, res) => {
    const parsed = ReviewSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    }
    try {
        const withdrawal = await LedgerService_1.ledgerService.reviewWithdrawal({
            withdrawalId: req.params["id"],
            adminId: req.user.sub,
            decision: parsed.data.decision,
            note: parsed.data.note,
        });
        void AuditLogService_1.auditLogService.log({
            actorUserId: req.user?.sub ?? null,
            actionType: "admin.withdrawal.review",
            entityType: "withdrawal_requests",
            entityId: withdrawal.id,
            correlationId: req.correlationId ?? null,
            metadata: { decision: parsed.data.decision, note: parsed.data.note ?? null },
        });
        return res.json({ withdrawal });
    }
    catch (err) {
        console.error("review withdrawal error:", err);
        const status = err.message?.includes("not found") ? 404 : 400;
        return res.status(status).json({ error: err.message ?? "Review failed" });
    }
});
// POST /admin/withdrawals/:id/settle — admin: execute settlement for an approved withdrawal
//
// Preconditions:
//   - Withdrawal must be in status 'approved' (call /review first)
//   - Withdrawal must not already be in-flight (xrpl_submitted_at set, xrpl_confirmed_at null)
//
// Idempotency:
//   - If already status='settled', returns the existing row (200) without re-executing.
//   - If SETTLEMENT_PROVIDER=xrpl (Phase 2), a real XRPL TX is submitted and awaited.
//   - If SETTLEMENT_PROVIDER=mock (default, Phase 1), returns a simulated confirmed result.
//
// ── XRPL INTEGRATION POINT ───────────────────────────────────────────────────
// Phase 2: set env var SETTLEMENT_PROVIDER=xrpl and implement XrplSettlementService.
// This route and LedgerService.settleWithdrawal() need no further changes.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/admin/:id/settle", auth_1.authenticate, (0, auth_1.requireRole)("admin"), async (req, res) => {
    try {
        const withdrawal = await LedgerService_1.ledgerService.settleWithdrawal({
            withdrawalId: req.params["id"],
            adminId: req.user.sub,
        });
        void AuditLogService_1.auditLogService.log({
            actorUserId: req.user?.sub ?? null,
            actionType: "admin.withdrawal.settle",
            entityType: "withdrawal_requests",
            entityId: withdrawal.id,
            correlationId: req.correlationId ?? null,
            metadata: { status: withdrawal.status, tx_hash: withdrawal.xrpl_tx_hash ?? null },
        });
        return res.json({ withdrawal });
    }
    catch (err) {
        const httpStatus = typeof err.status === "number"
            ? err.status
            : err.message?.includes("not found")
                ? 404
                : 400;
        return res.status(httpStatus).json({
            error: err.message ?? "Settlement failed",
            code: err.code ?? undefined,
        });
    }
});
exports.default = router;
//# sourceMappingURL=withdrawals.js.map