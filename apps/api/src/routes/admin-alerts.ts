import { Router } from "express";
import { authenticate, requireRole } from "../middleware/auth";
import { pool } from "../db/pool";
import { AdminAlert } from "../db/types";

const router = Router();

// GET /admin/alerts?severity=&resolved=false
router.get("/", authenticate, requireRole("admin"), async (req, res) => {
  const { severity, resolved } = req.query as Record<string, string>;
  const limit  = Math.min(parseInt(String(req.query["limit"]  ?? "100"), 10), 500);
  const offset = parseInt(String(req.query["offset"] ?? "0"),  10);

  try {
    const conditions: string[] = [];
    const params: any[] = [];
    let p = 1;

    if (severity) { conditions.push(`severity = $${p}`); params.push(severity); p++; }
    if (resolved === "false") { conditions.push(`is_resolved = false`); }
    else if (resolved === "true") { conditions.push(`is_resolved = true`); }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit, offset);

    const { rows } = await pool.query<AdminAlert>(
      `SELECT * FROM admin_alerts ${where} ORDER BY created_at DESC LIMIT $${p} OFFSET $${p + 1}`,
      params
    );
    return res.json({ alerts: rows });
  } catch (err) {
    console.error("GET /admin/alerts error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /admin/alerts/:id/resolve
router.post("/:id/resolve", authenticate, requireRole("admin"), async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      "UPDATE admin_alerts SET is_resolved = true WHERE id = $1",
      [req.params["id"]]
    );
    if (!rowCount) return res.status(404).json({ error: "Alert not found" });
    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /admin/alerts/:id/resolve error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
