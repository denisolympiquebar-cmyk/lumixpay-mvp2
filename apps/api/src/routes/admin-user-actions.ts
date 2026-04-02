import { Router } from "express";
import { authenticate, requireRole } from "../middleware/auth";
import { pool } from "../db/pool";
import { auditLogService } from "../services/AuditLogService";

const router = Router();

// ── POST /admin/users/:id/promote  — set role = 'admin' ──────────────────────

router.post("/:id/promote", authenticate, requireRole("admin"), async (req, res) => {
  const { id } = req.params;
  if (id === req.user!.sub) {
    return res.status(400).json({ error: "Cannot promote yourself" });
  }
  try {
    const { rows, rowCount } = await pool.query(
      "UPDATE users SET role = 'admin' WHERE id = $1 AND role != 'system' RETURNING id, email, role",
      [id]
    );
    if (!rowCount) return res.status(404).json({ error: "User not found or is a system account" });
    void auditLogService.log({
      actorUserId: req.user?.sub ?? null,
      actionType: "admin.user.promote",
      entityType: "user",
      entityId: id,
      correlationId: req.correlationId ?? null,
      metadata: { to_role: "admin" },
    });
    return res.json({ user: rows[0] });
  } catch (err) {
    console.error("POST /admin/users/:id/promote error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /admin/users/:id/demote  — set role = 'user' ────────────────────────

router.post("/:id/demote", authenticate, requireRole("admin"), async (req, res) => {
  const { id } = req.params;
  if (id === req.user!.sub) {
    return res.status(400).json({ error: "Cannot demote yourself" });
  }
  try {
    const { rows, rowCount } = await pool.query(
      "UPDATE users SET role = 'user' WHERE id = $1 AND role != 'system' RETURNING id, email, role",
      [id]
    );
    if (!rowCount) return res.status(404).json({ error: "User not found or is a system account" });
    void auditLogService.log({
      actorUserId: req.user?.sub ?? null,
      actionType: "admin.user.demote",
      entityType: "user",
      entityId: id,
      correlationId: req.correlationId ?? null,
      metadata: { to_role: "user" },
    });
    return res.json({ user: rows[0] });
  } catch (err) {
    console.error("POST /admin/users/:id/demote error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /admin/users/:id/freeze  — set is_frozen = TRUE ─────────────────────

router.post("/:id/freeze", authenticate, requireRole("admin"), async (req, res) => {
  const { id } = req.params;
  if (id === req.user!.sub) {
    return res.status(400).json({ error: "Cannot freeze yourself" });
  }
  try {
    const { rows, rowCount } = await pool.query(
      "UPDATE users SET is_frozen = TRUE WHERE id = $1 AND role != 'system' RETURNING id, email, is_frozen",
      [id]
    );
    if (!rowCount) return res.status(404).json({ error: "User not found or is a system account" });
    void auditLogService.log({
      actorUserId: req.user?.sub ?? null,
      actionType: "admin.user.freeze",
      entityType: "user",
      entityId: id,
      correlationId: req.correlationId ?? null,
      metadata: { is_frozen: true },
    });
    return res.json({ user: rows[0] });
  } catch (err) {
    console.error("POST /admin/users/:id/freeze error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /admin/users/:id/unfreeze  — set is_frozen = FALSE ──────────────────

router.post("/:id/unfreeze", authenticate, requireRole("admin"), async (req, res) => {
  const { id } = req.params;
  try {
    const { rows, rowCount } = await pool.query(
      "UPDATE users SET is_frozen = FALSE WHERE id = $1 RETURNING id, email, is_frozen",
      [id]
    );
    if (!rowCount) return res.status(404).json({ error: "User not found" });
    void auditLogService.log({
      actorUserId: req.user?.sub ?? null,
      actionType: "admin.user.unfreeze",
      entityType: "user",
      entityId: id,
      correlationId: req.correlationId ?? null,
      metadata: { is_frozen: false },
    });
    return res.json({ user: rows[0] });
  } catch (err) {
    console.error("POST /admin/users/:id/unfreeze error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
