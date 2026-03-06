import crypto from "crypto";
import { pool } from "../db/pool";
import { Webhook, WebhookDelivery } from "../db/types";

export const ALL_WEBHOOK_EVENTS = [
  "topup.completed",
  "transfer.sent",
  "transfer.received",
  "withdrawal.requested",
  "withdrawal.approved",
  "withdrawal.rejected",
  "withdrawal.settled",
  "voucher.redeemed",
  "payment_link.paid",
  "subscription.charged",
  "webhook.failed",
] as const;

export type WebhookEventType = (typeof ALL_WEBHOOK_EVENTS)[number];

export class WebhookService {
  /**
   * Dispatch an event to all active webhooks subscribed to it for a given user.
   * Delivery is fire-and-forget; failures are logged and stored for retries.
   */
  async dispatch(userId: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
    let hooks: Webhook[];
    try {
      const { rows } = await pool.query<Webhook>(
        `SELECT * FROM webhooks
          WHERE user_id = $1
            AND status = 'active'
            AND events @> $2::jsonb`,
        [userId, JSON.stringify([eventType])]
      );
      hooks = rows;
    } catch (err) {
      console.error("[WebhookService] Failed to load webhooks:", err);
      return;
    }

    for (const hook of hooks) {
      void this.deliver(hook, eventType, payload);
    }
  }

  private async deliver(
    hook: Webhook,
    eventType: string,
    payload: Record<string, unknown>,
    attempt = 1
  ): Promise<void> {
    const body = JSON.stringify({ event: eventType, data: payload, timestamp: new Date().toISOString() });
    const sig = crypto.createHmac("sha256", hook.secret).update(body).digest("hex");

    let deliveryId: string | undefined;
    try {
      const { rows } = await pool.query<WebhookDelivery>(
        `INSERT INTO webhook_deliveries (webhook_id, event_type, payload, attempts)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [hook.id, eventType, payload, attempt]
      );
      deliveryId = rows[0]?.id;
    } catch {
      // non-fatal — continue with delivery attempt
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const resp = await fetch(hook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-LumixPay-Signature": `sha256=${sig}`,
          "X-LumixPay-Event": eventType,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (deliveryId) {
        if (resp.ok) {
          await pool.query(
            "UPDATE webhook_deliveries SET status = 'delivered', delivered_at = NOW() WHERE id = $1",
            [deliveryId]
          );
        } else {
          const errText = `HTTP ${resp.status}`;
          await pool.query(
            "UPDATE webhook_deliveries SET status = 'failed', last_error = $1 WHERE id = $2",
            [errText, deliveryId]
          );
          await this.scheduleRetry(hook, eventType, payload, attempt);
        }
      }
    } catch (err: any) {
      const errMsg = err?.message ?? "Unknown error";
      if (deliveryId) {
        await pool.query(
          "UPDATE webhook_deliveries SET status = 'failed', last_error = $1 WHERE id = $2",
          [errMsg, deliveryId]
        ).catch(() => {});
      }
      await this.scheduleRetry(hook, eventType, payload, attempt);
    }
  }

  private async scheduleRetry(
    hook: Webhook,
    eventType: string,
    payload: Record<string, unknown>,
    attempt: number
  ): Promise<void> {
    if (attempt >= 3) return; // max 3 attempts
    const delayMs = Math.pow(2, attempt) * 5_000; // 10s, 20s backoff
    setTimeout(() => {
      void this.deliver(hook, eventType, payload, attempt + 1);
    }, delayMs);
  }
}

export const webhookService = new WebhookService();
