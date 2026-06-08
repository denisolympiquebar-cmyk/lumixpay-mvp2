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
const XrplDestinationDiagnosticsService_1 = require("../services/XrplDestinationDiagnosticsService");
const XrplDestinationResolverService_1 = require("../services/XrplDestinationResolverService");
const router = (0, express_1.Router)();
const XRPL_ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const WithdrawalRequestSchema = zod_1.z
    .object({
    asset_id: zod_1.z.string().uuid(),
    gross_amount: zod_1.z.number().positive(),
    xrpl_destination_address: zod_1.z.string().optional(),
    destination_username: zod_1.z.string().min(1).max(64).optional(),
    xrpl_destination_tag: zod_1.z.number().int().nonnegative().optional(),
})
    .superRefine((data, ctx) => {
    const hasAddr = !!data.xrpl_destination_address?.trim();
    const hasUser = !!data.destination_username?.trim();
    if (!hasAddr && !hasUser) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            message: "Provide either xrpl_destination_address or destination_username",
            path: ["xrpl_destination_address"],
        });
    }
    if (hasAddr && !XRPL_ADDRESS_RE.test(data.xrpl_destination_address.trim())) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            message: "Invalid XRPL address",
            path: ["xrpl_destination_address"],
        });
    }
});
const ReviewSchema = zod_1.z.object({
    decision: zod_1.z.enum(["approve", "reject"]),
    note: zod_1.z.string().max(1000).optional(),
});
const ResolveDestinationSchema = zod_1.z
    .object({
    xrpl_destination_address: zod_1.z.string().optional(),
    destination_username: zod_1.z.string().min(1).max(64).optional(),
})
    .superRefine((data, ctx) => {
    const hasAddr = !!data.xrpl_destination_address?.trim();
    const hasUser = !!data.destination_username?.trim();
    if (!hasAddr && !hasUser) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            message: "Provide either xrpl_destination_address or destination_username",
            path: ["destination_username"],
        });
    }
    if (hasAddr && !XRPL_ADDRESS_RE.test(data.xrpl_destination_address.trim())) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            message: "Invalid XRPL address",
            path: ["xrpl_destination_address"],
        });
    }
});
// POST /withdrawals/resolve-destination — preview username/address resolution (no withdrawal created)
router.post("/resolve-destination", auth_1.authenticate, frozen_1.requireNotFrozen, async (req, res) => {
    const parsed = ResolveDestinationSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ ok: false, error: "Validation failed", details: parsed.error.flatten() });
    }
    try {
        const destination = await XrplDestinationResolverService_1.xrplDestinationResolverService.resolveDestination({
            userId: req.user.sub,
            destinationUsername: parsed.data.destination_username,
            destinationAddress: parsed.data.xrpl_destination_address,
        });
        return res.json({ ok: true, destinationResolution: destination });
    }
    catch (err) {
        const status = typeof err.status === "number" ? err.status : 400;
        return res.status(status).json({ ok: false, error: err.message ?? "Destination resolution failed" });
    }
});
// POST /withdrawals — user requests a withdrawal
router.post("/", auth_1.authenticate, frozen_1.requireNotFrozen, require_idempotency_1.requireIdempotencyKey, idempotency_1.idempotent, withdrawal_risk_1.withdrawalRiskGuard, async (req, res) => {
    const parsed = WithdrawalRequestSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    }
    const { asset_id, gross_amount, xrpl_destination_address, destination_username, xrpl_destination_tag } = parsed.data;
    const userId = req.user.sub;
    const { rows } = await pool_1.pool.query("SELECT * FROM accounts WHERE user_id = $1 AND asset_id = $2 AND label = 'main'", [userId, asset_id]);
    if (!rows[0]) {
        return res.status(404).json({ ok: false, error: "Account not found for requested asset" });
    }
    try {
        const destination = await XrplDestinationResolverService_1.xrplDestinationResolverService.resolveDestination({
            userId,
            destinationUsername: destination_username,
            destinationAddress: xrpl_destination_address,
        });
        if (destination.resolvedFrom === "username") {
            void AuditLogService_1.auditLogService.log({
                actorUserId: userId,
                actionType: "withdrawal.destination_username_resolved",
                entityType: "users",
                entityId: destination.destinationUserId ?? null,
                correlationId: req.correlationId ?? null,
                metadata: {
                    requesterUserId: userId,
                    destinationUsername: destination.destinationUsername,
                    destinationUserId: destination.destinationUserId,
                    destinationAddress: destination.destinationAddress,
                },
            });
        }
        const withdrawal = await LedgerService_1.ledgerService.requestWithdrawal({
            userId,
            accountId: rows[0].id,
            assetId: asset_id,
            grossAmount: gross_amount,
            xrplDestinationAddress: destination.destinationAddress,
            xrplDestinationTag: xrpl_destination_tag,
        });
        return res.status(201).json({
            ok: true,
            withdrawal,
            destinationResolution: destination,
        });
    }
    catch (err) {
        console.error("withdrawal request error:", err);
        if (typeof err.status === "number") {
            return res.status(err.status).json({ ok: false, error: err.message ?? "Withdrawal request failed" });
        }
        const status = err.message?.includes("Insufficient") ? 422 : 400;
        return res.status(status).json({ ok: false, error: err.message ?? "Withdrawal request failed" });
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
//   - If SETTLEMENT_PROVIDER=xrpl_testnet, a real XRPL Testnet TX is submitted and awaited.
//   - If SETTLEMENT_PROVIDER=mock (default), returns a simulated confirmed result.
//
// ── XRPL INTEGRATION POINT ───────────────────────────────────────────────────
// Production testnet: set SETTLEMENT_PROVIDER=xrpl_testnet (XrplTestnetSettlementProvider).
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
            friendlyError: err.friendlyError ?? undefined,
            code: err.code ?? undefined,
            txHash: err.txHash ?? undefined,
        });
    }
});
// GET /admin/withdrawals/:id/diagnostics — destination readiness check ────────
//
// Returns a read-only XRPL Testnet diagnostic report for the withdrawal
// destination: whether the account exists and has the required trust line.
//
// READ-ONLY: no seed access, no DB writes, no balance changes.
// Useful before clicking "Settle" to understand why settlement might fail.
router.get("/admin/:id/diagnostics", auth_1.authenticate, (0, auth_1.requireRole)("admin"), async (req, res) => {
    const withdrawalId = req.params["id"];
    // Load withdrawal + asset code
    const { rows } = await pool_1.pool.query(`SELECT wr.id, wr.xrpl_destination_address, wr.asset_id,
              a.currency_code
         FROM withdrawal_requests wr
         JOIN assets a ON a.id = wr.asset_id
        WHERE wr.id = $1`, [withdrawalId]);
    const wr = rows[0];
    if (!wr) {
        return res.status(404).json({ ok: false, error: "Withdrawal request not found." });
    }
    const assetCode = wr.currency_code.toUpperCase();
    if (assetCode !== "RLUSD" && assetCode !== "EURQ") {
        return res.status(400).json({
            ok: false,
            error: `Unsupported asset '${assetCode}' for XRPL Testnet diagnostics. Expected RLUSD or EURQ.`,
        });
    }
    try {
        const result = await XrplDestinationDiagnosticsService_1.xrplDestinationDiagnosticsService.checkDestination(wr.xrpl_destination_address, assetCode);
        // Optional audit log — fire-and-forget
        if (result.status === "ok") {
            void AuditLogService_1.auditLogService.log({
                actorUserId: req.user?.sub ?? null,
                actionType: "xrpl.destination_diagnostics_checked",
                entityType: "withdrawal_requests",
                entityId: withdrawalId,
                correlationId: req.correlationId ?? null,
                metadata: {
                    withdrawalId,
                    destinationAddress: wr.xrpl_destination_address,
                    assetCode,
                    accountExists: result.accountExists,
                    hasRequiredTrustLine: result.hasRequiredTrustLine,
                    ready: result.ready,
                },
            });
        }
        if (result.status === "invalid_address") {
            return res.status(400).json({ ok: false, status: "invalid_address", message: result.message });
        }
        if (result.status === "config_missing") {
            return res.status(503).json({ ok: false, status: "config_missing", message: result.message });
        }
        if (result.status === "xrpl_testnet_unavailable") {
            return res.status(503).json({
                ok: false, status: "xrpl_testnet_unavailable", message: result.message,
            });
        }
        // status === "ok"
        return res.json({
            ok: true,
            withdrawalId,
            destinationAddress: wr.xrpl_destination_address,
            assetCode,
            diagnostics: {
                accountExists: result.accountExists,
                xrpBalance: result.xrpBalance,
                requiredIssuer: result.requiredIssuer,
                requiredCurrency: result.requiredCurrency,
                hasRequiredTrustLine: result.hasRequiredTrustLine,
                ready: result.ready,
                message: result.message,
            },
        });
    }
    catch (err) {
        console.error("GET /admin/:id/diagnostics error:", err);
        return res.status(500).json({ ok: false, error: "Internal server error" });
    }
});
// POST /admin/withdrawals/:id/cancel-approved — admin: cancel approved withdrawal & refund
//
// Safety conditions enforced before any ledger change:
//   - withdrawal.status = 'approved'
//   - xrpl_confirmed_at IS NULL   (no on-chain TX confirmed)
//   - xrpl_tx_hash IS NULL        (no TX has been broadcast)
//
// Ledger effect (mirrors reject-from-pending):
//   withdrawal_escrow → user_account (net)  [entry type: withdrawal_unlock]
//   user.locked -= net; user.available += net
//   Fee is NOT refunded.
//
// Idempotency key: withdrawal_cancel_approved:<id>  (safe to retry)
router.post("/admin/:id/cancel-approved", auth_1.authenticate, (0, auth_1.requireRole)("admin"), async (req, res) => {
    const withdrawalId = req.params["id"];
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "Cancelled by admin";
    try {
        const withdrawal = await LedgerService_1.ledgerService.cancelApprovedWithdrawal({
            withdrawalId,
            adminId: req.user.sub,
            reason,
        });
        void AuditLogService_1.auditLogService.log({
            actorUserId: req.user?.sub ?? null,
            actionType: "withdrawal.approved_cancelled",
            entityType: "withdrawal_requests",
            entityId: withdrawalId,
            correlationId: req.correlationId ?? null,
            metadata: { reason, adminUserId: req.user.sub, withdrawalId },
        });
        return res.json({
            ok: true,
            withdrawal,
            message: "Withdrawal cancelled and funds returned to the user.",
        });
    }
    catch (err) {
        console.error("POST /admin/:id/cancel-approved error:", err);
        const httpStatus = typeof err.status === "number" ? err.status :
            err.message?.includes("not found") ? 404 : 400;
        return res.status(httpStatus).json({
            error: err.message ?? "Cancel failed",
            code: err.code ?? undefined,
        });
    }
});
exports.default = router;
//# sourceMappingURL=withdrawals.js.map