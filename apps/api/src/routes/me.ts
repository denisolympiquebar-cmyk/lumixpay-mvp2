import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { mutationLimiter } from "../middleware/rate-limit";
import { pool } from "../db/pool";
import { User } from "../db/types";
import {
  createWalletChallenge,
  unlinkWallet,
  verifyAndLinkWallet,
} from "../services/XrplWalletLinkService";

const router = Router();

const UsernameSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[a-z0-9_]+$/, "Username may only contain lowercase letters, digits and underscores"),
});

const WalletLinkSchema = z.object({
  challenge_id: z.string().uuid(),
  address: z.string().min(25).max(64),
  public_key: z.string().min(20).max(200),
  signature: z.string().min(20).max(400),
});

// GET /me/profile
router.get("/profile", authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query<User>(
      `SELECT id, email, full_name, role, username, created_at,
              xrpl_address, xrpl_network, xrpl_verified_at
       FROM users WHERE id = $1`,
      [req.user!.sub]
    );
    if (!rows[0]) return res.status(404).json({ error: "User not found" });
    return res.json({ profile: rows[0] });
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
    // Case-insensitive uniqueness check excluding the requesting user.
    // LOWER() on both sides ensures no CI collision even if the DB were to
    // contain mixed-case entries (belt-and-suspenders alongside idx_users_username_ci).
    const { rows: existing } = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND id != $2",
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

// POST /me/profile/wallet/challenge — begin XRPL Testnet ownership verification
router.post("/profile/wallet/challenge", authenticate, mutationLimiter, async (req, res) => {
  try {
    const out = await createWalletChallenge(req.user!.sub);
    return res.json(out);
  } catch (err: any) {
    if (err?.message === "USER_NOT_FOUND") return res.status(404).json({ error: "USER_NOT_FOUND" });
    console.error("POST /me/profile/wallet/challenge error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /me/profile/wallet — link verified XRPL Testnet address
router.patch("/profile/wallet", authenticate, mutationLimiter, async (req, res) => {
  const parsed = WalletLinkSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
  }
  try {
    await verifyAndLinkWallet(req.user!.sub, parsed.data);
    return res.json({ ok: true });
  } catch (err: any) {
    const code = err?.code ?? err?.message;
    const map: Record<string, number> = {
      XRPL_ADDRESS_INVALID: 400,
      WALLET_CHALLENGE_INVALID: 400,
      WALLET_CHALLENGE_EXPIRED: 400,
      XRPL_PUBLIC_KEY_INVALID: 400,
      XRPL_ADDRESS_KEY_MISMATCH: 400,
      XRPL_SIGNATURE_INVALID: 400,
      XRPL_ADDRESS_ALREADY_LINKED: 409,
    };
    const status = typeof code === "string" ? map[code] : undefined;
    if (status) return res.status(status).json({ error: code });
    console.error("PATCH /me/profile/wallet error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /me/profile/wallet — remove linked wallet
router.delete("/profile/wallet", authenticate, mutationLimiter, async (req, res) => {
  try {
    await unlinkWallet(req.user!.sub);
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /me/profile/wallet error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
