import { Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import { authenticate } from "../middleware/auth";
import { pool } from "../db/pool";
import { ApiKey } from "../db/types";

const router = Router();

const CreateKeySchema = z.object({
  name: z.string().min(1).max(100),
});

// GET /me/api-keys
router.get("/", authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query<ApiKey>(
      `SELECT id, user_id, name, last4, created_at, revoked_at
         FROM api_keys
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [req.user!.sub]
    );
    return res.json({ api_keys: rows });
  } catch (err) {
    console.error("GET /me/api-keys error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /me/api-keys  — returns plaintext key once, never again
router.post("/", authenticate, async (req, res) => {
  const parsed = CreateKeySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
  }
  const { name } = parsed.data;

  const rawKey = `lx_${crypto.randomBytes(24).toString("hex")}`;   // 48 hex chars
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
  const last4 = rawKey.slice(-4) as string;

  try {
    const { rows } = await pool.query<Pick<ApiKey, "id" | "name" | "last4" | "created_at">>(
      `INSERT INTO api_keys (user_id, name, key_hash, last4)
       VALUES ($1,$2,$3,$4)
       RETURNING id, name, last4, created_at`,
      [req.user!.sub, name, keyHash, last4]
    );
    return res.status(201).json({
      api_key: rows[0],
      key: rawKey,   // shown ONCE; not stored
      warning: "Copy this key now — it will not be shown again.",
    });
  } catch (err) {
    console.error("POST /me/api-keys error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /me/api-keys/:id  (revoke)
router.delete("/:id", authenticate, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      "UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
      [req.params["id"], req.user!.sub]
    );
    if (!rowCount) return res.status(404).json({ error: "Active API key not found" });
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /me/api-keys/:id error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
