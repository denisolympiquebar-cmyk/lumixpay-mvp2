import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { requireNotFrozen } from "../middleware/frozen";
import { idempotent } from "../middleware/idempotency";
import { requireIdempotencyKey } from "../middleware/require-idempotency";
import { ledgerService } from "../services/LedgerService";
import { pool } from "../db/pool";
import { Account } from "../db/types";

const router = Router();

// UUID v4 pattern — used to decide whether to look up by id or username
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TransferSchema = z.object({
  /**
   * `recipient` accepts either:
   *   - a user UUID (looked up against users.id)
   *   - a username (looked up against users.username, case-insensitive)
   */
  recipient: z.string().min(1, "Recipient is required"),
  asset_id: z.string().uuid(),
  gross_amount: z.number().positive(),
});

/**
 * Resolves a recipient string to a user_id.
 * Returns null if no matching non-system user is found.
 */
async function resolveRecipientUserId(recipient: string): Promise<string | null> {
  if (UUID_RE.test(recipient)) {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE id = $1 AND role != 'system'",
      [recipient],
    );
    return rows[0]?.id ?? null;
  }

  // Username lookup — case-insensitive (all stored usernames are lowercase,
  // but LOWER() guards against any bypass of the application-layer constraint)
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND role != 'system'",
    [recipient],
  );
  return rows[0]?.id ?? null;
}

// POST /transfers
router.post("/", authenticate, requireNotFrozen, requireIdempotencyKey, idempotent, async (req, res) => {
  const parsed = TransferSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
  }

  const { recipient, asset_id, gross_amount } = parsed.data;
  const fromUserId = req.user!.sub;

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
  const { rows: fromRows } = await pool.query<Account>(
    "SELECT * FROM accounts WHERE user_id = $1 AND asset_id = $2 AND label = 'main'",
    [fromUserId, asset_id],
  );
  if (!fromRows[0]) {
    return res.status(404).json({ error: "Sender account not found for requested asset" });
  }

  // Resolve recipient account
  const { rows: toRows } = await pool.query<Account>(
    "SELECT * FROM accounts WHERE user_id = $1 AND asset_id = $2 AND label = 'main'",
    [toUserId, asset_id],
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
