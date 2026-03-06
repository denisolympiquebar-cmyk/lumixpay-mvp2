import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { pool } from "../db/pool";
import { RecurringPlan, Subscription } from "../db/types";

const router = Router();

const CreatePlanSchema = z.object({
  asset_id: z.string().uuid(),
  amount: z.number().positive(),
  interval: z.enum(["weekly", "monthly"]),
  day_of_week: z.number().int().min(0).max(6).optional(),
  day_of_month: z.number().int().min(1).max(28).optional(),
  description: z.string().max(255).optional(),
});

const SubscribeSchema = z.object({
  start_at: z.string().datetime().optional(), // default = now
});

// POST /recurring/plans
router.post("/plans", authenticate, async (req, res) => {
  const parsed = CreatePlanSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
  }
  const { asset_id, amount, interval, day_of_week, day_of_month, description } = parsed.data;

  if (interval === "weekly" && day_of_week === undefined) {
    return res.status(400).json({ error: "day_of_week required for weekly plans (0=Sun, 6=Sat)" });
  }
  if (interval === "monthly" && day_of_month === undefined) {
    return res.status(400).json({ error: "day_of_month required for monthly plans (1-28)" });
  }

  try {
    const { rows } = await pool.query<RecurringPlan>(
      `INSERT INTO recurring_plans (creator_user_id, asset_id, amount, interval, day_of_week, day_of_month, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user!.sub, asset_id, amount, interval, day_of_week ?? null, day_of_month ?? null, description ?? null]
    );
    return res.status(201).json({ plan: rows[0] });
  } catch (err) {
    console.error("POST /recurring/plans error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /recurring/plans  — list plans you created
router.get("/plans", authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT rp.*, a.currency_code, a.display_symbol,
              (SELECT COUNT(*) FROM subscriptions WHERE plan_id = rp.id AND status = 'active') AS subscriber_count
         FROM recurring_plans rp
         JOIN assets a ON a.id = rp.asset_id
        WHERE rp.creator_user_id = $1 AND rp.status != 'deleted'
        ORDER BY rp.created_at DESC`,
      [req.user!.sub]
    );
    return res.json({ plans: rows });
  } catch (err) {
    console.error("GET /recurring/plans error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /recurring/plans/public/:id  — public plan info
router.get("/plans/public/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT rp.id, rp.description, rp.amount, rp.interval, rp.day_of_week, rp.day_of_month, rp.status,
              a.currency_code, a.display_symbol,
              u.full_name AS creator_name, u.username AS creator_username
         FROM recurring_plans rp
         JOIN assets a ON a.id = rp.asset_id
         JOIN users u ON u.id = rp.creator_user_id
        WHERE rp.id = $1 AND rp.status = 'active'`,
      [req.params["id"]]
    );
    if (!rows[0]) return res.status(404).json({ error: "Plan not found or not active" });
    return res.json({ plan: rows[0] });
  } catch (err) {
    console.error("GET /recurring/plans/public/:id error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /recurring/subscriptions  — list my subscriptions
router.get("/subscriptions", authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*, rp.description AS plan_description, rp.amount AS plan_amount,
              rp.interval AS plan_interval, a.currency_code, a.display_symbol,
              u.full_name AS creator_name
         FROM subscriptions s
         JOIN recurring_plans rp ON rp.id = s.plan_id
         JOIN assets a ON a.id = rp.asset_id
         JOIN users u ON u.id = rp.creator_user_id
        WHERE s.subscriber_user_id = $1
        ORDER BY s.created_at DESC`,
      [req.user!.sub]
    );
    return res.json({ subscriptions: rows });
  } catch (err) {
    console.error("GET /recurring/subscriptions error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /recurring/plans/:id/subscribe
router.post("/plans/:id/subscribe", authenticate, async (req, res) => {
  const subParsed = SubscribeSchema.safeParse(req.body);
  if (!subParsed.success) {
    return res.status(400).json({ error: "Validation failed", details: subParsed.error.flatten() });
  }

  try {
    const { rows: planRows } = await pool.query<RecurringPlan>(
      "SELECT * FROM recurring_plans WHERE id = $1 AND status = 'active'",
      [req.params["id"]]
    );
    if (!planRows[0]) return res.status(404).json({ error: "Plan not found or not active" });
    const plan = planRows[0];

    if (plan.creator_user_id === req.user!.sub) {
      return res.status(400).json({ error: "Cannot subscribe to your own plan" });
    }

    const nextRunAt = subParsed.data.start_at ? new Date(subParsed.data.start_at) : new Date();

    const { rows } = await pool.query<Subscription>(
      `INSERT INTO subscriptions (plan_id, subscriber_user_id, next_run_at)
       VALUES ($1,$2,$3)
       ON CONFLICT (plan_id, subscriber_user_id) DO UPDATE
         SET status = 'active', next_run_at = EXCLUDED.next_run_at
       RETURNING *`,
      [plan.id, req.user!.sub, nextRunAt.toISOString()]
    );
    return res.status(201).json({ subscription: rows[0] });
  } catch (err) {
    console.error("POST /recurring/plans/:id/subscribe error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /recurring/subscriptions/:id
router.delete("/subscriptions/:id", authenticate, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      "UPDATE subscriptions SET status = 'canceled' WHERE id = $1 AND subscriber_user_id = $2",
      [req.params["id"], req.user!.sub]
    );
    if (!rowCount) return res.status(404).json({ error: "Subscription not found" });
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /recurring/subscriptions/:id error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /recurring/plans/:id/pause  (creator)
router.patch("/plans/:id/pause", authenticate, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      "UPDATE recurring_plans SET status = 'paused' WHERE id = $1 AND creator_user_id = $2",
      [req.params["id"], req.user!.sub]
    );
    if (!rowCount) return res.status(404).json({ error: "Plan not found" });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
