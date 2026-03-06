import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { requireNotFrozen } from "../middleware/frozen";
import { idempotent } from "../middleware/idempotency";
import { ledgerService } from "../services/LedgerService";
import { pool } from "../db/pool";
import { Account } from "../db/types";

const router = Router();

const TransferSchema = z.object({
  to_user_id: z.string().uuid(),
  asset_id: z.string().uuid(),
  gross_amount: z.number().positive(),
});

// POST /transfers
router.post("/", authenticate, requireNotFrozen, idempotent, async (req, res) => {
  const parsed = TransferSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
  }
  const { to_user_id, asset_id, gross_amount } = parsed.data;
  const fromUserId = req.user!.sub;

  if (fromUserId === to_user_id) {
    return res.status(400).json({ error: "Cannot transfer to yourself" });
  }

  // Resolve sender account
  const { rows: fromRows } = await pool.query<Account>(
    "SELECT * FROM accounts WHERE user_id = $1 AND asset_id = $2 AND label = 'main'",
    [fromUserId, asset_id]
  );
  if (!fromRows[0]) {
    return res.status(404).json({ error: "Sender account not found for requested asset" });
  }

  // Resolve recipient account
  const { rows: toRows } = await pool.query<Account>(
    "SELECT * FROM accounts WHERE user_id = $1 AND asset_id = $2 AND label = 'main'",
    [to_user_id, asset_id]
  );
  if (!toRows[0]) {
    return res.status(404).json({ error: "Recipient account not found" });
  }

  try {
    const result = await ledgerService.transfer({
      fromAccountId: fromRows[0].id,
      toAccountId:   toRows[0].id,
      assetId:       asset_id,
      grossAmount:   gross_amount,
    });

    return res.status(201).json({
      transfer: result.transfer,
      ledger_entries: result.entries,
    });
  } catch (err: any) {
    console.error("transfer error:", err);
    const status = err.message?.includes("Insufficient") ? 422 : 400;
    return res.status(status).json({ error: err.message ?? "Transfer failed" });
  }
});

export default router;
