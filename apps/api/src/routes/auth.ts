import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { pool } from "../db/pool";
import { config } from "../config";
import { User } from "../db/types";

const router = Router();

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  full_name: z.string().min(1).max(255),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// POST /auth/register
router.post("/register", async (req, res) => {
  const parsed = RegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { email, password, full_name } = parsed.data;

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    // Check uniqueness
    const { rows: existing } = await client.query<{ id: string }>(
      "SELECT id FROM users WHERE email = $1",
      [email]
    );
    if (existing.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Email already registered" });
    }

    const password_hash = await bcrypt.hash(password, 12);
    const userId = uuidv4();

    const { rows: userRows } = await client.query<User>(
      `INSERT INTO users (id, email, password_hash, full_name, role)
       VALUES ($1,$2,$3,$4,'user')
       RETURNING id, email, full_name, role, created_at`,
      [userId, email, password_hash, full_name]
    );
    const user = userRows[0]!;

    // Provision one 'main' account + balance row per active asset
    const { rows: assets } = await client.query<{ id: string }>(
      "SELECT id FROM assets WHERE is_active = true ORDER BY currency_code"
    );

    for (const asset of assets) {
      const accountId = uuidv4();
      await client.query(
        `INSERT INTO accounts (id, user_id, asset_id, label) VALUES ($1,$2,$3,'main')`,
        [accountId, userId, asset.id]
      );
      await client.query(
        `INSERT INTO balances (account_id, available, locked) VALUES ($1, 0, 0)`,
        [accountId]
      );
    }

    await client.query("COMMIT");

    const token = jwt.sign(
      { sub: user.id, email: user.email, role: user.role },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn } as jwt.SignOptions
    );

    return res.status(201).json({ token, user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role } });
  } catch (err) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch {}
    }
    console.error("register error:", err);
    return res.status(500).json({ error: "Internal server error" });
  } finally {
    if (client) client.release();
  }
});

// POST /auth/login
router.post("/login", async (req, res) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { email, password } = parsed.data;

  try {
    const { rows } = await pool.query<User>(
      "SELECT * FROM users WHERE email = $1 AND role != 'system'",
      [email]
    );
    const user = rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
      { sub: user.id, email: user.email, role: user.role },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn } as jwt.SignOptions
    );

    return res.json({ token, user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role } });
  } catch (err) {
    console.error("login error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
