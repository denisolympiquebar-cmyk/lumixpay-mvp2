import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { requireRole } from "../middleware/auth";
import { config } from "../config";
import { pool } from "../db/pool";
import { pushService } from "../services/PushService";

const router = Router();

// ── GET /push/vapid-public-key  — expose public key to frontend ───────────────

router.get("/vapid-public-key", (_req, res) => {
  const key = process.env["VAPID_PUBLIC_KEY"] ?? "";
  if (!key) return res.status(503).json({ error: "Push notifications not configured" });
  return res.json({ vapidPublicKey: key });
});

// ── POST /push/subscribe  — store / refresh a push subscription ───────────────

const SubscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth:   z.string().min(1),
  }),
  userAgent: z.string().optional(),
});

router.post("/subscribe", authenticate, async (req, res) => {
  const parsed = SubscribeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
  }
  const { endpoint, keys, userAgent } = parsed.data;
  const userId = req.user!.sub;

  try {
    // Upsert: update user_id / user_agent if the endpoint already exists
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint)
       DO UPDATE SET user_id = EXCLUDED.user_id,
                     p256dh  = EXCLUDED.p256dh,
                     auth    = EXCLUDED.auth,
                     user_agent = EXCLUDED.user_agent`,
      [userId, endpoint, keys.p256dh, keys.auth, userAgent ?? null]
    );
    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error("POST /push/subscribe error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /push/unsubscribe  — remove a push subscription ─────────────────────

const UnsubscribeSchema = z.object({ endpoint: z.string().url() });

router.post("/unsubscribe", authenticate, async (req, res) => {
  const parsed = UnsubscribeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
  }
  const { endpoint } = parsed.data;
  const userId = req.user!.sub;

  try {
    await pool.query(
      "DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2",
      [endpoint, userId]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /push/unsubscribe error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /push/test  — authenticated push test helper ─────────────────────────
// Safe-by-default:
//  - In production: admin only.
//  - In non-production: any authenticated user can test a push to their own devices.
const PushTestSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  body:  z.string().max(500).optional(),
  url:   z.string().max(200).optional(),
  user_id: z.string().uuid().optional(), // admin only
});

router.post(
  "/test",
  authenticate,
  (req, res, next) => {
    if (config.nodeEnv === "production") return requireRole("admin")(req, res, next);
    return next();
  },
  async (req, res) => {
    const parsed = PushTestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    }

    const targetUserId = parsed.data.user_id ?? req.user!.sub;
    if (parsed.data.user_id && req.user?.role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    await pushService.sendToUser(targetUserId, {
      title: parsed.data.title ?? "LumixPay (test)",
      body:  parsed.data.body  ?? "Test push notification",
      url:   parsed.data.url   ?? "/notifications",
      type:  "push.test",
    });

    return res.json({ ok: true });
  }
);

export default router;
