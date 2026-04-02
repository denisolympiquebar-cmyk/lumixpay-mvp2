import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRole } from "../middleware/auth";
import { pool } from "../db/pool";
import { auditLogService } from "../services/AuditLogService";

const router = Router();

// ── GET /admin/treasury/revenue?period=today|7d|30d|all ──────────────────────

const PERIOD_SQL: Record<string, string> = {
  today: "NOW() - INTERVAL '1 day'",
  "7d":  "NOW() - INTERVAL '7 days'",
  "30d": "NOW() - INTERVAL '30 days'",
  all:   "'1970-01-01'::timestamptz",
};

router.get("/revenue", authenticate, requireRole("admin"), async (req, res) => {
  const period = (req.query["period"] as string | undefined) ?? "all";
  const since  = PERIOD_SQL[period] ?? PERIOD_SQL["all"]!;

  try {
    // All fee entries in the time window, grouped by reference_type.
    // reference_type tells us the origin of each fee:
    //   topup_transactions   → BANK
    //   voucher / voucher_products → BANK
    //   transfers            → CRYPTO
    //   withdrawal_requests  → CRYPTO
    const { rows } = await pool.query<{
      reference_type: string;
      total: string;
    }>(
      `SELECT
         COALESCE(reference_type, 'unknown') AS reference_type,
         SUM(amount)::text                   AS total
       FROM ledger_entries
       WHERE entry_type  = 'fee'
         AND created_at >= ${since}
       GROUP BY reference_type`
    );

    // Classify into bank vs crypto buckets
    let bankRevenue   = 0;
    let cryptoRevenue = 0;
    const breakdown: Record<string, number> = {};

    for (const row of rows) {
      const amt = parseFloat(row.total ?? "0");
      breakdown[row.reference_type] = amt;

      if (["topup_transactions", "voucher", "voucher_products"].includes(row.reference_type)) {
        bankRevenue += amt;
      } else if (["transfers", "withdrawal_requests"].includes(row.reference_type)) {
        cryptoRevenue += amt;
      }
    }

    return res.json({
      period,
      bankRevenue:   bankRevenue.toFixed(6),
      cryptoRevenue: cryptoRevenue.toFixed(6),
      totalRevenue:  (bankRevenue + cryptoRevenue).toFixed(6),
      breakdown,
    });
  } catch (err) {
    console.error("GET /admin/treasury/revenue error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /admin/treasury  — view all asset limits ──────────────────────────────

router.get("/", authenticate, requireRole("admin"), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT tl.*, a.currency_code, a.display_symbol, a.display_name
         FROM treasury_limits tl
         JOIN assets a ON a.id = tl.asset_id
        ORDER BY a.currency_code`
    );
    return res.json({ limits: rows });
  } catch (err) {
    console.error("GET /admin/treasury error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── PUT /admin/treasury/:asset_id  — update max_supply or current_supply ──────

const UpdateLimitSchema = z.object({
  max_supply:     z.number().nonnegative().optional(),
  current_supply: z.number().nonnegative().optional(),
});

router.put("/:asset_id", authenticate, requireRole("admin"), async (req, res) => {
  const { asset_id } = req.params;
  const parsed = UpdateLimitSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
  }
  const { max_supply, current_supply } = parsed.data;
  if (max_supply === undefined && current_supply === undefined) {
    return res.status(400).json({ error: "Provide max_supply or current_supply" });
  }

  try {
    // Upsert the treasury limit row
    const sets: string[] = ["updated_at = NOW()"];
    const vals: unknown[] = [asset_id];
    if (max_supply !== undefined) { sets.push(`max_supply = $${vals.push(max_supply)}`); }
    if (current_supply !== undefined) { sets.push(`current_supply = $${vals.push(current_supply)}`); }

    const { rows, rowCount } = await pool.query(
      `UPDATE treasury_limits SET ${sets.join(", ")} WHERE asset_id = $1 RETURNING *`,
      vals
    );
    if (!rowCount) {
      // Upsert if missing
      const insertRes = await pool.query(
        `INSERT INTO treasury_limits (asset_id, max_supply, current_supply)
         VALUES ($1, $2, $3) RETURNING *`,
        [asset_id, max_supply ?? 1000000, current_supply ?? 0]
      );
      void auditLogService.log({
        actorUserId: req.user?.sub ?? null,
        actionType: "admin.treasury.upsert",
        entityType: "treasury_limits",
        entityId: asset_id,
        correlationId: req.correlationId ?? null,
        metadata: { max_supply: max_supply ?? 1000000, current_supply: current_supply ?? 0 },
      });
      return res.json({ limit: insertRes.rows[0] });
    }
    void auditLogService.log({
      actorUserId: req.user?.sub ?? null,
      actionType: "admin.treasury.update",
      entityType: "treasury_limits",
      entityId: asset_id,
      correlationId: req.correlationId ?? null,
      metadata: { max_supply, current_supply },
    });
    return res.json({ limit: rows[0] });
  } catch (err) {
    console.error("PUT /admin/treasury/:asset_id error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
