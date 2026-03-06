import { Router } from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import Decimal from "decimal.js";
import { authenticate } from "../middleware/auth";
import { requireNotFrozen } from "../middleware/frozen";
import { idempotent } from "../middleware/idempotency";
import { pool, withTransaction } from "../db/pool";
import { Account } from "../db/types";
import { notificationService } from "../services/NotificationService";

const router = Router();

// ── GET /fx-rate?base=<asset_id>&quote=<asset_id>  ────────────────────────────

router.get("/", async (req, res) => {
  const { base, quote } = req.query as { base?: string; quote?: string };
  if (!base || !quote) {
    return res.status(400).json({ error: "base and quote asset IDs are required" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT fr.rate, fr.updated_at,
              b.currency_code AS base_code, b.display_symbol AS base_symbol,
              q.currency_code AS quote_code, q.display_symbol AS quote_symbol
         FROM fx_rates fr
         JOIN assets b ON b.id = fr.base_asset
         JOIN assets q ON q.id = fr.quote_asset
        WHERE fr.base_asset = $1 AND fr.quote_asset = $2`,
      [base, quote]
    );
    if (!rows[0]) return res.status(404).json({ error: "No FX rate for this pair" });
    return res.json({ rate: rows[0] });
  } catch (err) {
    console.error("GET /fx-rate error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /fx-rates  — all rates ─────────────────────────────────────────────────

router.get("/all", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT fr.id, fr.rate, fr.updated_at,
              b.id AS base_asset_id, b.currency_code AS base_code, b.display_symbol AS base_symbol,
              q.id AS quote_asset_id, q.currency_code AS quote_code, q.display_symbol AS quote_symbol
         FROM fx_rates fr
         JOIN assets b ON b.id = fr.base_asset
         JOIN assets q ON q.id = fr.quote_asset
        ORDER BY b.currency_code, q.currency_code`
    );
    return res.json({ rates: rows });
  } catch (err) {
    console.error("GET /fx-rates/all error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /convert  — convert between assets ────────────────────────────────────

const ConvertSchema = z.object({
  from_asset_id: z.string().uuid(),
  to_asset_id:   z.string().uuid(),
  amount:        z.number().positive(),
});

router.post("/convert", authenticate, requireNotFrozen, idempotent, async (req, res) => {
  const parsed = ConvertSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
  }
  const { from_asset_id, to_asset_id, amount } = parsed.data;
  const userId = req.user!.sub;

  if (from_asset_id === to_asset_id) {
    return res.status(400).json({ error: "Cannot convert an asset to itself" });
  }

  try {
    const result = await withTransaction(async (client) => {
      // 1. Load FX rate (locked for read)
      const { rows: rateRows } = await client.query(
        `SELECT fr.rate, b.currency_code AS from_code, q.currency_code AS to_code
           FROM fx_rates fr
           JOIN assets b ON b.id = fr.base_asset
           JOIN assets q ON q.id = fr.quote_asset
          WHERE fr.base_asset = $1 AND fr.quote_asset = $2`,
        [from_asset_id, to_asset_id]
      );
      if (!rateRows[0]) throw Object.assign(new Error("No FX rate for this asset pair"), { status: 404 });

      const rate      = new Decimal(rateRows[0].rate);
      const fromAmt   = new Decimal(amount);
      const toAmt     = fromAmt.mul(rate).toDecimalPlaces(6);

      // 2. Resolve user accounts (FOR UPDATE to lock balance rows)
      const { rows: accRows } = await client.query<Account>(
        "SELECT * FROM accounts WHERE user_id = $1 AND asset_id = ANY($2) AND label = 'main'",
        [userId, [from_asset_id, to_asset_id]]
      );
      const fromAcc = accRows.find((a) => a.asset_id === from_asset_id);
      const toAcc   = accRows.find((a) => a.asset_id === to_asset_id);
      if (!fromAcc) throw Object.assign(new Error("Source account not found"), { status: 422 });
      if (!toAcc)   throw Object.assign(new Error("Destination account not found"), { status: 422 });

      // 3. Check sufficient balance
      const { rows: balRows } = await client.query<{ available: string }>(
        "SELECT available FROM balances WHERE account_id = $1 FOR UPDATE",
        [fromAcc.id]
      );
      // Also lock destination balance
      await client.query("SELECT available FROM balances WHERE account_id = $1 FOR UPDATE", [toAcc.id]);

      const available = new Decimal(balRows[0]?.available ?? "0");
      if (available.lt(fromAmt)) {
        throw Object.assign(
          new Error(`Insufficient balance. Need ${fromAmt.toFixed(2)}, have ${available.toFixed(2)}`),
          { status: 422 }
        );
      }

      // 4. Post two ledger entries: debit from_account, credit to_account
      const conversionId   = uuidv4();
      const idempKeyDebit  = `fx:${conversionId}:debit`;
      const idempKeyCredit = `fx:${conversionId}:credit`;

      await client.query(
        `INSERT INTO ledger_entries
           (idempotency_key, debit_account_id, credit_account_id, asset_id, amount,
            entry_type, reference_id, reference_type, metadata)
         VALUES ($1, $2, $2, $3, $4, 'fx_conversion', $5, 'fx_conversion', $6)`,
        [
          idempKeyDebit,
          fromAcc.id,
          fromAcc.id,
          from_asset_id,
          fromAmt.toFixed(6),
          conversionId,
          JSON.stringify({ direction: "out", rate: rate.toString(), to_asset: to_asset_id }),
        ]
      );
      await client.query(
        `INSERT INTO ledger_entries
           (idempotency_key, debit_account_id, credit_account_id, asset_id, amount,
            entry_type, reference_id, reference_type, metadata)
         VALUES ($1, $2, $2, $3, $4, 'fx_conversion', $5, 'fx_conversion', $6)`,
        [
          idempKeyCredit,
          toAcc.id,
          toAcc.id,
          to_asset_id,
          toAmt.toFixed(6),
          conversionId,
          JSON.stringify({ direction: "in", rate: rate.toString(), from_asset: from_asset_id }),
        ]
      );

      // 5. Update balances
      await client.query(
        "UPDATE balances SET available = available - $1, updated_at = NOW() WHERE account_id = $2",
        [fromAmt.toFixed(6), fromAcc.id]
      );
      await client.query(
        "UPDATE balances SET available = available + $1, updated_at = NOW() WHERE account_id = $2",
        [toAmt.toFixed(6), toAcc.id]
      );

      return {
        conversion_id: conversionId,
        from_amount:   fromAmt.toFixed(2),
        to_amount:     toAmt.toFixed(2),
        rate:          rate.toString(),
        from_code:     rateRows[0].from_code as string,
        to_code:       rateRows[0].to_code as string,
      };
    });

    void notificationService.create({
      userId,
      type: "fx.converted",
      title: "Currency converted",
      body: `Converted ${result.from_amount} ${result.from_code} → ${result.to_amount} ${result.to_code} (rate: ${result.rate})`,
      metadata: result,
    }).catch(() => {});

    return res.json({ conversion: result });
  } catch (err: any) {
    console.error("POST /convert error:", err);
    return res.status(err.status ?? 500).json({ error: err.message ?? "Conversion failed" });
  }
});

export default router;
