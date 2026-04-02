import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import crypto from "crypto";
import { OAuth2Client } from "google-auth-library";
import { pool } from "../db/pool";
import { config } from "../config";
import { User } from "../db/types";

const router = Router();

const googleClientId = process.env["GOOGLE_CLIENT_ID"] ?? "";
const googleOAuth = googleClientId ? new OAuth2Client(googleClientId) : null;

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

// POST /auth/google
// Google Identity Services: frontend obtains an ID token, backend verifies it.
const GoogleSchema = z.object({
  id_token: z.string().min(10),
});

router.post("/google", async (req, res) => {
  if (!googleOAuth) {
    return res.status(503).json({ error: "GOOGLE_AUTH_NOT_CONFIGURED" });
  }

  const parsed = GoogleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
  }

  const idToken = parsed.data.id_token;

  let ticket;
  try {
    ticket = await googleOAuth.verifyIdToken({
      idToken,
      audience: googleClientId,
    });
  } catch (err) {
    console.error("[google] verifyIdToken failed:", err);
    return res.status(401).json({ error: "GOOGLE_TOKEN_INVALID" });
  }

  const payload = ticket.getPayload();
  const email = payload?.email ?? null;
  const emailVerified = payload?.email_verified ?? false;
  const sub = payload?.sub ?? null;
  const fullName = payload?.name ?? payload?.given_name ?? "User";

  if (!sub) return res.status(401).json({ error: "GOOGLE_TOKEN_INVALID" });
  if (!email || !emailVerified) {
    return res.status(400).json({ error: "GOOGLE_EMAIL_REQUIRED" });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    // 1) If identity exists, use it.
    const { rows: idRows } = await client.query<{ user_id: string }>(
      "SELECT user_id FROM user_identities WHERE provider = 'google' AND provider_sub = $1",
      [sub]
    );

    let userId: string | null = idRows[0]?.user_id ?? null;

    // 2) Else link to existing user by verified email (prevents duplicate accounts).
    if (!userId) {
      const { rows: existing } = await client.query<User>(
        "SELECT * FROM users WHERE email = $1 AND role != 'system'",
        [email]
      );
      const u = existing[0] ?? null;
      if (u) {
        userId = u.id;
      }
    }

    // 3) Else create a new user + provision balances like normal signup.
    if (!userId) {
      userId = uuidv4();
      const randomPass = crypto.randomBytes(24).toString("hex");
      const password_hash = await bcrypt.hash(randomPass, 12);

      await client.query(
        `INSERT INTO users (id, email, password_hash, full_name, role)
         VALUES ($1, $2, $3, $4, 'user')`,
        [userId, email, password_hash, fullName]
      );

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
    }

    // 4) Upsert identity link
    await client.query(
      `INSERT INTO user_identities (user_id, provider, provider_sub, email)
       VALUES ($1, 'google', $2, $3)
       ON CONFLICT (provider, provider_sub)
       DO UPDATE SET user_id = EXCLUDED.user_id, email = EXCLUDED.email`,
      [userId, sub, email]
    );

    const { rows: userRows } = await client.query<User>(
      "SELECT id, email, full_name, role, created_at FROM users WHERE id = $1",
      [userId]
    );
    const user = userRows[0];
    if (!user) throw new Error("User not found after Google auth");

    await client.query("COMMIT");

    const token = jwt.sign(
      { sub: user.id, email: user.email, role: user.role },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn } as jwt.SignOptions
    );

    return res.json({ token, user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role } });
  } catch (err) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch {}
    }
    console.error("google auth error:", err);
    return res.status(500).json({ error: "Internal server error" });
  } finally {
    if (client) client.release();
  }
});

// POST /auth/refresh
// Placeholder endpoint to prepare refresh-token architecture rollout.
// Non-breaking: explicit unsupported response until refresh tokens are enabled.
router.post("/refresh", async (_req, res) => {
  return res.status(501).json({
    error: "REFRESH_NOT_ENABLED",
    message: "Refresh-token flow is not enabled in this environment.",
  });
});

export default router;
