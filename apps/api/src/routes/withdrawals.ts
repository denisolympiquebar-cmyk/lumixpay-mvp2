import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRole } from "../middleware/auth";
import { requireNotFrozen } from "../middleware/frozen";
import { idempotent } from "../middleware/idempotency";
import { requireIdempotencyKey } from "../middleware/require-idempotency";
import { withdrawalRiskGuard } from "../middleware/withdrawal-risk";
import { ledgerService } from "../services/LedgerService";
import { pool } from "../db/pool";
import { Account, WithdrawalRequest } from "../db/types";
import { auditLogService } from "../services/AuditLogService";
import {
  xrplDestinationDiagnosticsService,
  type DiagnosticsAssetCode,
} from "../services/XrplDestinationDiagnosticsService";
import { xrplDestinationResolverService } from "../services/XrplDestinationResolverService";

const router = Router();

const XRPL_ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

const WithdrawalRequestSchema = z
  .object({
    asset_id: z.string().uuid(),
    gross_amount: z.number().positive(),
    xrpl_destination_address: z.string().optional(),
    destination_username: z.string().min(1).max(64).optional(),
    xrpl_destination_tag: z.number().int().nonnegative().optional(),
  })
  .superRefine((data, ctx) => {
    const hasAddr = !!data.xrpl_destination_address?.trim();
    const hasUser = !!data.destination_username?.trim();
    if (!hasAddr && !hasUser) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide either xrpl_destination_address or destination_username",
        path: ["xrpl_destination_address"],
      });
    }
    if (hasAddr && !XRPL_ADDRESS_RE.test(data.xrpl_destination_address!.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid XRPL address",
        path: ["xrpl_destination_address"],
      });
    }
  });

const ReviewSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().max(1000).optional(),
});

const ResolveDestinationSchema = z
  .object({
    xrpl_destination_address: z.string().optional(),
    destination_username: z.string().min(1).max(64).optional(),
  })
  .superRefine((data, ctx) => {
    const hasAddr = !!data.xrpl_destination_address?.trim();
    const hasUser = !!data.destination_username?.trim();
    if (!hasAddr && !hasUser) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide either xrpl_destination_address or destination_username",
        path: ["destination_username"],
      });
    }
    if (hasAddr && !XRPL_ADDRESS_RE.test(data.xrpl_destination_address!.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid XRPL address",
        path: ["xrpl_destination_address"],
      });
    }
  });

// POST /withdrawals/resolve-destination — preview username/address resolution (no withdrawal created)
router.post("/resolve-destination", authenticate, requireNotFrozen, async (req, res) => {
  const parsed = ResolveDestinationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "Validation failed", details: parsed.error.flatten() });
  }

  try {
    const destination = await xrplDestinationResolverService.resolveDestination({
      userId: req.user!.sub,
      destinationUsername: parsed.data.destination_username,
      destinationAddress: parsed.data.xrpl_destination_address,
    });
    return res.json({ ok: true, destinationResolution: destination });
  } catch (err: any) {
    const status = typeof err.status === "number" ? err.status : 400;
    return res.status(status).json({ ok: false, error: err.message ?? "Destination resolution failed" });
  }
});

// POST /withdrawals — user requests a withdrawal
router.post("/", authenticate, requireNotFrozen, requireIdempotencyKey, idempotent, withdrawalRiskGuard, async (req, res) => {
  const parsed = WithdrawalRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
  }
  const { asset_id, gross_amount, xrpl_destination_address, destination_username, xrpl_destination_tag } =
    parsed.data;
  const userId = req.user!.sub;

  const { rows } = await pool.query<Account>(
    "SELECT * FROM accounts WHERE user_id = $1 AND asset_id = $2 AND label = 'main'",
    [userId, asset_id]
  );
  if (!rows[0]) {
    return res.status(404).json({ ok: false, error: "Account not found for requested asset" });
  }

  try {
    const destination = await xrplDestinationResolverService.resolveDestination({
      userId,
      destinationUsername: destination_username,
      destinationAddress: xrpl_destination_address,
    });

    if (destination.resolvedFrom === "username") {
      void auditLogService.log({
        actorUserId:   userId,
        actionType:    "withdrawal.destination_username_resolved",
        entityType:    "users",
        entityId:      destination.destinationUserId ?? null,
        correlationId: req.correlationId ?? null,
        metadata: {
          requesterUserId:     userId,
          destinationUsername: destination.destinationUsername,
          destinationUserId:   destination.destinationUserId,
          destinationAddress:  destination.destinationAddress,
        },
      });
    }

    const withdrawal = await ledgerService.requestWithdrawal({
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
  } catch (err: any) {
    console.error("withdrawal request error:", err);
    if (typeof err.status === "number") {
      return res.status(err.status).json({ ok: false, error: err.message ?? "Withdrawal request failed" });
    }
    const status = err.message?.includes("Insufficient") ? 422 : 400;
    return res.status(status).json({ ok: false, error: err.message ?? "Withdrawal request failed" });
  }
});

// GET /withdrawals — user's own withdrawal history
router.get("/", authenticate, async (req, res) => {
  const userId = req.user!.sub;
  const limit  = Math.min(parseInt(String(req.query["limit"]  ?? "50"), 10), 200);
  const offset = parseInt(String(req.query["offset"] ?? "0"), 10);

  const { rows } = await pool.query<WithdrawalRequest>(
    `SELECT wr.*, a.currency_code AS currency
       FROM withdrawal_requests wr
       JOIN assets a ON a.id = wr.asset_id
      WHERE wr.user_id = $1
      ORDER BY wr.created_at DESC
      LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return res.json({ withdrawals: rows });
});

// GET /admin/withdrawals — admin: list pending withdrawals
router.get(
  "/admin",
  authenticate,
  requireRole("admin"),
  async (req, res) => {
    const status = String(req.query["status"] ?? "pending");
    const limit  = Math.min(parseInt(String(req.query["limit"]  ?? "50"), 10), 200);
    const offset = parseInt(String(req.query["offset"] ?? "0"), 10);

    const { rows } = await pool.query<WithdrawalRequest>(
      `SELECT wr.*, u.email AS user_email, a.currency_code AS currency
         FROM withdrawal_requests wr
         JOIN users  u ON u.id = wr.user_id
         JOIN assets a ON a.id = wr.asset_id
        WHERE wr.status = $1
        ORDER BY wr.created_at ASC
        LIMIT $2 OFFSET $3`,
      [status, limit, offset]
    );
    return res.json({ withdrawals: rows });
  }
);

// POST /admin/withdrawals/:id/review — admin: approve or reject
router.post(
  "/admin/:id/review",
  authenticate,
  requireRole("admin"),
  async (req, res) => {
    const parsed = ReviewSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    }

    try {
      const withdrawal = await ledgerService.reviewWithdrawal({
        withdrawalId: req.params["id"]!,
        adminId: req.user!.sub,
        decision: parsed.data.decision,
        note: parsed.data.note,
      });

      void auditLogService.log({
        actorUserId: req.user?.sub ?? null,
        actionType: "admin.withdrawal.review",
        entityType: "withdrawal_requests",
        entityId: withdrawal.id,
        correlationId: req.correlationId ?? null,
        metadata: { decision: parsed.data.decision, note: parsed.data.note ?? null },
      });
      return res.json({ withdrawal });
    } catch (err: any) {
      console.error("review withdrawal error:", err);
      const status = err.message?.includes("not found") ? 404 : 400;
      return res.status(status).json({ error: err.message ?? "Review failed" });
    }
  }
);

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
router.post(
  "/admin/:id/settle",
  authenticate,
  requireRole("admin"),
  async (req, res) => {
    try {
      const withdrawal = await ledgerService.settleWithdrawal({
        withdrawalId: req.params["id"]!,
        adminId:      req.user!.sub,
      });
      void auditLogService.log({
        actorUserId: req.user?.sub ?? null,
        actionType: "admin.withdrawal.settle",
        entityType: "withdrawal_requests",
        entityId: withdrawal.id,
        correlationId: req.correlationId ?? null,
        metadata: { status: withdrawal.status, tx_hash: withdrawal.xrpl_tx_hash ?? null },
      });
      return res.json({ withdrawal });
    } catch (err: any) {
      const httpStatus =
        typeof err.status === "number"
          ? err.status
          : err.message?.includes("not found")
          ? 404
          : 400;
      return res.status(httpStatus).json({
        error:         err.message          ?? "Settlement failed",
        friendlyError: err.friendlyError    ?? undefined,
        code:          err.code             ?? undefined,
        txHash:        err.txHash           ?? undefined,
      });
    }
  }
);

// GET /admin/withdrawals/:id/diagnostics — destination readiness check ────────
//
// Returns a read-only XRPL Testnet diagnostic report for the withdrawal
// destination: whether the account exists and has the required trust line.
//
// READ-ONLY: no seed access, no DB writes, no balance changes.
// Useful before clicking "Settle" to understand why settlement might fail.
router.get(
  "/admin/:id/diagnostics",
  authenticate,
  requireRole("admin"),
  async (req, res) => {
    const withdrawalId = req.params["id"]!;

    // Load withdrawal + asset code
    const { rows } = await pool.query<
      Pick<WithdrawalRequest, "id" | "xrpl_destination_address" | "asset_id"> &
      { currency_code: string }
    >(
      `SELECT wr.id, wr.xrpl_destination_address, wr.asset_id,
              a.currency_code
         FROM withdrawal_requests wr
         JOIN assets a ON a.id = wr.asset_id
        WHERE wr.id = $1`,
      [withdrawalId]
    );

    const wr = rows[0];
    if (!wr) {
      return res.status(404).json({ ok: false, error: "Withdrawal request not found." });
    }

    const assetCode = wr.currency_code.toUpperCase() as DiagnosticsAssetCode;
    if (assetCode !== "RLUSD" && assetCode !== "EURQ") {
      return res.status(400).json({
        ok: false,
        error: `Unsupported asset '${assetCode}' for XRPL Testnet diagnostics. Expected RLUSD or EURQ.`,
      });
    }

    try {
      const result = await xrplDestinationDiagnosticsService.checkDestination(
        wr.xrpl_destination_address,
        assetCode
      );

      // Optional audit log — fire-and-forget
      if (result.status === "ok") {
        void auditLogService.log({
          actorUserId:  req.user?.sub ?? null,
          actionType:   "xrpl.destination_diagnostics_checked",
          entityType:   "withdrawal_requests",
          entityId:     withdrawalId,
          correlationId: req.correlationId ?? null,
          metadata: {
            withdrawalId,
            destinationAddress:   wr.xrpl_destination_address,
            assetCode,
            accountExists:        result.accountExists,
            hasRequiredTrustLine: result.hasRequiredTrustLine,
            ready:                result.ready,
          },
        });
      }

      if (result.status === "invalid_address") {
        return res.status(400).json({ ok: false, status: "invalid_address", message: result.message });
      }
      if (result.status === "config_missing") {
        return res.status(503).json({ ok: false, status: "config_missing",  message: result.message });
      }
      if (result.status === "xrpl_testnet_unavailable") {
        return res.status(503).json({
          ok: false, status: "xrpl_testnet_unavailable", message: result.message,
        });
      }

      // status === "ok"
      return res.json({
        ok:                 true,
        withdrawalId,
        destinationAddress: wr.xrpl_destination_address,
        assetCode,
        diagnostics: {
          accountExists:        result.accountExists,
          xrpBalance:           result.xrpBalance,
          requiredIssuer:       result.requiredIssuer,
          requiredCurrency:     result.requiredCurrency,
          hasRequiredTrustLine: result.hasRequiredTrustLine,
          ready:                result.ready,
          message:              result.message,
        },
      });
    } catch (err) {
      console.error("GET /admin/:id/diagnostics error:", err);
      return res.status(500).json({ ok: false, error: "Internal server error" });
    }
  }
);

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
router.post(
  "/admin/:id/cancel-approved",
  authenticate,
  requireRole("admin"),
  async (req, res) => {
    const withdrawalId = req.params["id"]!;
    const reason       = typeof req.body?.reason === "string" ? req.body.reason.trim() : "Cancelled by admin";

    try {
      const withdrawal = await ledgerService.cancelApprovedWithdrawal({
        withdrawalId,
        adminId: req.user!.sub,
        reason,
      });

      void auditLogService.log({
        actorUserId:   req.user?.sub ?? null,
        actionType:    "withdrawal.approved_cancelled",
        entityType:    "withdrawal_requests",
        entityId:      withdrawalId,
        correlationId: req.correlationId ?? null,
        metadata:      { reason, adminUserId: req.user!.sub, withdrawalId },
      });

      return res.json({
        ok:         true,
        withdrawal,
        message:    "Withdrawal cancelled and funds returned to the user.",
      });
    } catch (err: any) {
      console.error("POST /admin/:id/cancel-approved error:", err);
      const httpStatus =
        typeof err.status === "number" ? err.status :
        err.message?.includes("not found") ? 404 : 400;
      return res.status(httpStatus).json({
        error: err.message ?? "Cancel failed",
        code:  err.code   ?? undefined,
      });
    }
  }
);

export default router;
