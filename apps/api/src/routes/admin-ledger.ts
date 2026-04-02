import { Router } from "express";
import { authenticate, requireRole } from "../middleware/auth";
import { pool } from "../db/pool";

const router = Router();

// GET /admin/ledger/reconciliation
// Bank-grade integrity view:
//  - Global invariant: sum(debits) must equal sum(credits) in ledger_entries.
//  - Per-asset invariant: debit sum == credit sum for each asset.
router.get("/reconciliation", authenticate, requireRole("admin"), async (_req, res) => {
  try {
    const totalQ = await pool.query<{ debits: string; credits: string }>(
      `SELECT
         COALESCE(SUM(amount), 0)::text AS debits,
         COALESCE(SUM(amount), 0)::text AS credits
       FROM ledger_entries`
    );
    const t = totalQ.rows[0] ?? { debits: "0", credits: "0" };

    const byAssetQ = await pool.query<{
      asset_id: string;
      currency_code: string;
      debit_total: string;
      credit_total: string;
    }>(
      `SELECT
         le.asset_id,
         a.currency_code,
         COALESCE(SUM(le.amount), 0)::text AS debit_total,
         COALESCE(SUM(le.amount), 0)::text AS credit_total
       FROM ledger_entries le
       JOIN assets a ON a.id = le.asset_id
       GROUP BY le.asset_id, a.currency_code
       ORDER BY a.currency_code`
    );

    const byAsset = byAssetQ.rows.map((r) => {
      const d = Number(r.debit_total);
      const c = Number(r.credit_total);
      return {
        asset_id: r.asset_id,
        currency_code: r.currency_code,
        debit_total: r.debit_total,
        credit_total: r.credit_total,
        balanced: Math.abs(d - c) < 1e-9,
      };
    });

    const dTotal = Number(t.debits);
    const cTotal = Number(t.credits);

    return res.json({
      global: {
        debit_total: t.debits,
        credit_total: t.credits,
        balanced: Math.abs(dTotal - cTotal) < 1e-9,
      },
      by_asset: byAsset,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("GET /admin/ledger/reconciliation error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /admin/ledger?user_id=&email=&username=&from=&to=&entry_type=&limit=&offset=
router.get("/", authenticate, requireRole("admin"), async (req, res) => {
  const { user_id, email, username, from, to, entry_type } = req.query as Record<string, string>;
  const limit  = Math.min(parseInt(String(req.query["limit"]  ?? "100"), 10), 500);
  const offset = parseInt(String(req.query["offset"] ?? "0"), 10);

  try {
    // Resolve user_id if email or username provided
    let resolvedUserId: string | null = user_id ?? null;
    if (!resolvedUserId && (email || username)) {
      const { rows } = await pool.query<{ id: string }>(
        "SELECT id FROM users WHERE email = $1 OR username = $2",
        [email ?? null, username ?? null]
      );
      if (rows[0]) resolvedUserId = rows[0].id;
      else return res.json({ entries: [] });
    }

    const conditions: string[] = [];
    const params: any[] = [];
    let p = 1;

    if (resolvedUserId) {
      // include entries where user's any account is debit or credit
      conditions.push(`(le.debit_account_id IN (SELECT id FROM accounts WHERE user_id = $${p})
                     OR le.credit_account_id IN (SELECT id FROM accounts WHERE user_id = $${p}))`);
      params.push(resolvedUserId);
      p++;
    }
    if (entry_type) {
      conditions.push(`le.entry_type = $${p}`);
      params.push(entry_type);
      p++;
    }
    if (from) {
      conditions.push(`le.created_at >= $${p}`);
      params.push(from);
      p++;
    }
    if (to) {
      conditions.push(`le.created_at <= $${p}`);
      params.push(to);
      p++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit, offset);

    const { rows } = await pool.query(
      `SELECT le.*, ast.currency_code, ast.display_symbol
         FROM ledger_entries le
         JOIN assets ast ON ast.id = le.asset_id
        ${where}
        ORDER BY le.created_at DESC
        LIMIT $${p} OFFSET $${p + 1}`,
      params
    );
    return res.json({ entries: rows });
  } catch (err) {
    console.error("GET /admin/ledger error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
