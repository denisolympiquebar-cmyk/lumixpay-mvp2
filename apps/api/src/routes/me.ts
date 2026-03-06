import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { pool } from "../db/pool";
import { User } from "../db/types";

const router = Router();

const UsernameSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[a-z0-9_]+$/, "Username may only contain lowercase letters, digits and underscores"),
});

// GET /me/profile
router.get("/profile", authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query<User>(
      "SELECT id, email, full_name, role, username, created_at FROM users WHERE id = $1",
      [req.user!.sub]
    );
    if (!rows[0]) return res.status(404).json({ error: "User not found" });
    const { password_hash: _ph, ...profile } = rows[0] as any;
    return res.json({ profile });
  } catch (err) {
    console.error("GET /me/profile error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /me/username  — claim or update username
router.post("/username", authenticate, async (req, res) => {
  const parsed = UsernameSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
  }
  const { username } = parsed.data;

  try {
    // Check uniqueness excluding the requesting user
    const { rows: existing } = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE username = $1 AND id != $2",
      [username, req.user!.sub]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: "Username already taken" });
    }

    const { rows } = await pool.query<{ username: string }>(
      "UPDATE users SET username = $1 WHERE id = $2 RETURNING username",
      [username, req.user!.sub]
    );
    return res.json({ username: rows[0]!.username });
  } catch (err) {
    console.error("POST /me/username error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
