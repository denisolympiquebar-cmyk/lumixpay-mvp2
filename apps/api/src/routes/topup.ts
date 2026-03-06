import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { requireNotFrozen } from "../middleware/frozen";
import { idempotent } from "../middleware/idempotency";
import { ledgerService } from "../services/LedgerService";
import { pool } from "../db/pool";
import { ALLOWED_TOPUP_AMOUNTS } from "../services/MockPaymentProvider";
import { Account } from "../db/types";

const router = Router();

const TopUpSchema = z.object({
  asset_id: z.string().uuid(),
  gross_amount: z.union([
    z.literal(10),
    z.literal(20),
    z.literal(50),
    z.literal(100),
  ]),
  simulated_card_last4: z.string().regex(/^\d{4}$/, "Must be exactly 4 digits"),
});

// POST /topup
router.post("/", authenticate, requireNotFrozen, idempotent, async (req, res) => {
  const parsed = TopUpSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten(),
      allowed_amounts: ALLOWED_TOPUP_AMOUNTS,
    });
  }
  const { asset_id, gross_amount, simulated_card_last4 } = parsed.data;
  const userId = req.user!.sub;

  // Resolve user's 'main' account for the requested asset
  const { rows } = await pool.query<Account>(
    "SELECT * FROM accounts WHERE user_id = $1 AND asset_id = $2 AND label = 'main'",
    [userId, asset_id]
  );
  if (!rows[0]) {
    return res.status(404).json({ error: "Account not found for requested asset" });
  }
  const account = rows[0];

  try {
    const result = await ledgerService.topUp({
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
  } catch (err: any) {
    console.error("topup error:", err);
    const statusCode = (err.status as number | undefined) ?? 400;
    return res.status(statusCode).json({
      error: err.message ?? "Top-up failed",
      ...(err.code ? { code: err.code, details: err.details } : {}),
    });
  }
});

export default router;
