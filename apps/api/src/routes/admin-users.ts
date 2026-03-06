import { Router } from "express";
import { authenticate, requireRole } from "../middleware/auth";
import { pool } from "../db/pool";

const router = Router();

// GET /admin/users?search=&limit=&offset=
router.get("/", authenticate, requireRole("admin"), async (req, res) => {
  const search = String(req.query["search"] ?? "").trim();
  const limit = Math.min(parseInt(String(req.query["limit"] ?? "50"), 10), 200);
  const offset = parseInt(String(req.query["offset"] ?? "0"), 10);

  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.full_name, u.username, u.role, u.created_at,
              (SELECT COALESCE(SUM(b.available), 0)
                 FROM accounts a JOIN balances b ON b.account_id = a.id
                WHERE a.user_id = u.id) AS total_available
         FROM users u
        WHERE u.role != 'system'
          AND ($1 = '' OR u.email ILIKE $1 OR u.full_name ILIKE $1 OR u.username ILIKE $1)
        ORDER BY u.created_at DESC
        LIMIT $2 OFFSET $3`,
      [search ? `%${search}%` : "", limit, offset]
    );
    return res.json({ users: rows });
  } catch (err) {
    console.error("GET /admin/users error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /admin/users/:id  — full detail
router.get("/:id", authenticate, requireRole("admin"), async (req, res) => {
  try {
    const { rows: userRows } = await pool.query(
      "SELECT id, email, full_name, username, role, created_at FROM users WHERE id = $1 AND role != 'system'",
      [req.params["id"]]
    );
    if (!userRows[0]) return res.status(404).json({ error: "User not found" });

    const { rows: accountRows } = await pool.query(
      `SELECT a.id, a.label, a.asset_id, a.created_at,
              ast.currency_code, ast.display_symbol,
              b.available, b.locked, b.updated_at AS balance_updated_at
         FROM accounts a
         JOIN assets ast ON ast.id = a.asset_id
         JOIN balances b ON b.account_id = a.id
        WHERE a.user_id = $1`,
      [req.params["id"]]
    );

    return res.json({ user: userRows[0], accounts: accountRows });
  } catch (err) {
    console.error("GET /admin/users/:id error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
