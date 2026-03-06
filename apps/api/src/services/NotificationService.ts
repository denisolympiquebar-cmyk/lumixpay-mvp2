import { v4 as uuidv4 } from "uuid";
import { pool } from "../db/pool";
import { pushService } from "./PushService";
import { streamService } from "./StreamService";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type NotificationType =
  | "topup.completed"
  | "transfer.sent"
  | "transfer.received"
  | "withdrawal.requested"
  | "withdrawal.approved"
  | "withdrawal.rejected"
  | "withdrawal.settled"
  | "voucher.redeemed"
  | "voucher.purchased"
  | "payment_link.paid"
  | "recurring.executed"
  | "fx.converted";

export interface Notification {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  metadata: Record<string, unknown> | null;
  is_read: boolean;
  created_at: Date;
}

export interface CreateNotificationParams {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string;
  metadata?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// NotificationService
// ─────────────────────────────────────────────────────────────────────────────

export class NotificationService {
  async create(params: CreateNotificationParams): Promise<Notification> {
    const { rows } = await pool.query<Notification>(
      `INSERT INTO notifications (id, user_id, type, title, body, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        uuidv4(),
        params.userId,
        params.type,
        params.title,
        params.body ?? null,
        params.metadata ? JSON.stringify(params.metadata) : null,
      ]
    );
    const notification = rows[0]!;

    // Fire-and-forget push — never blocks the caller
    void pushService
      .sendToUser(params.userId, {
        title: params.title,
        body:  params.body,
        type:  params.type,
        url:   "/notifications",
      })
      .catch((e) => console.error("[NotificationService] push error:", e));

    // Fire-and-forget SSE — send unread count update to the user's stream
    void this.unreadCount(params.userId)
      .then((count) => {
        streamService.publish(params.userId, "notifications.unread", { count });
      })
      .catch(() => {});

    return notification;
  }

  async list(userId: string, limit = 50, offset = 0): Promise<Notification[]> {
    const { rows } = await pool.query<Notification>(
      `SELECT * FROM notifications
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
    return rows;
  }

  async unreadCount(userId: string): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM notifications
        WHERE user_id = $1 AND is_read = false`,
      [userId]
    );
    return parseInt(rows[0]?.count ?? "0", 10);
  }

  async markRead(notificationId: string, userId: string): Promise<void> {
    await pool.query(
      `UPDATE notifications
          SET is_read = true
        WHERE id = $1 AND user_id = $2`,
      [notificationId, userId]
    );
  }

  async markAllRead(userId: string): Promise<void> {
    await pool.query(
      `UPDATE notifications
          SET is_read = true
        WHERE user_id = $1 AND is_read = false`,
      [userId]
    );
  }
}

export const notificationService = new NotificationService();
