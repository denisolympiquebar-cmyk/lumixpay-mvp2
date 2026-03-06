import { Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import { authenticate } from "../middleware/auth";
import { pool } from "../db/pool";
import { Webhook, WebhookDelivery } from "../db/types";
import { ALL_WEBHOOK_EVENTS } from "../services/WebhookService";

const router = Router();

const CreateWebhookSchema = z.object({
  url: z.string().url().max(500),
  events: z.array(z.string()).min(1),
});

// GET /me/webhooks
router.get("/", authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query<Omit<Webhook, "secret">>(
      `SELECT id, user_id, url, events, status, created_at
         FROM webhooks WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user!.sub]
    );
    return res.json({ webhooks: rows, available_events: ALL_WEBHOOK_EVENTS });
  } catch (err) {
    console.error("GET /me/webhooks error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /me/webhooks
router.post("/", authenticate, async (req, res) => {
  const parsed = CreateWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
  }
  const { url, events } = parsed.data;
  const secret = `whsec_${crypto.randomBytes(20).toString("hex")}`;

  try {
    const { rows } = await pool.query<Webhook>(
      `INSERT INTO webhooks (user_id, url, secret, events)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.user!.sub, url, secret, JSON.stringify(events)]
    );
    return res.status(201).json({
      webhook: rows[0],
      warning: "Store the secret securely — it is shown once for verification purposes.",
    });
  } catch (err) {
    console.error("POST /me/webhooks error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /me/webhooks/:id
router.delete("/:id", authenticate, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      "UPDATE webhooks SET status = 'disabled' WHERE id = $1 AND user_id = $2",
      [req.params["id"], req.user!.sub]
    );
    if (!rowCount) return res.status(404).json({ error: "Webhook not found" });
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /me/webhooks/:id error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /me/webhooks/:id/deliveries
router.get("/:id/deliveries", authenticate, async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query["limit"] ?? "50"), 10), 200);
    const { rows } = await pool.query<WebhookDelivery>(
      `SELECT wd.*
         FROM webhook_deliveries wd
         JOIN webhooks wh ON wh.id = wd.webhook_id
        WHERE wd.webhook_id = $1 AND wh.user_id = $2
        ORDER BY wd.created_at DESC LIMIT $3`,
      [req.params["id"], req.user!.sub, limit]
    );
    return res.json({ deliveries: rows });
  } catch (err) {
    console.error("GET /me/webhooks/:id/deliveries error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
