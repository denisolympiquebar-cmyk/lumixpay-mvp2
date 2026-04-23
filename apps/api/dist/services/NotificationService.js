"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notificationService = exports.NotificationService = void 0;
const uuid_1 = require("uuid");
const pool_1 = require("../db/pool");
const PushService_1 = require("./PushService");
const StreamService_1 = require("./StreamService");
// ─────────────────────────────────────────────────────────────────────────────
// NotificationService
// ─────────────────────────────────────────────────────────────────────────────
class NotificationService {
    async create(params) {
        const { rows } = await pool_1.pool.query(`INSERT INTO notifications (id, user_id, type, title, body, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`, [
            (0, uuid_1.v4)(),
            params.userId,
            params.type,
            params.title,
            params.body ?? null,
            params.metadata ? JSON.stringify(params.metadata) : null,
        ]);
        const notification = rows[0];
        // Fire-and-forget push — never blocks the caller
        void PushService_1.pushService
            .sendToUser(params.userId, {
            title: params.title,
            body: params.body,
            type: params.type,
            url: "/notifications",
        })
            .catch((e) => console.error("[NotificationService] push error:", e));
        // Fire-and-forget SSE — send unread count update to the user's stream
        void this.unreadCount(params.userId)
            .then((count) => {
            StreamService_1.streamService.publish(params.userId, "notifications.unread", { count });
        })
            .catch(() => { });
        return notification;
    }
    async list(userId, limit = 50, offset = 0) {
        const { rows } = await pool_1.pool.query(`SELECT * FROM notifications
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`, [userId, limit, offset]);
        return rows;
    }
    async unreadCount(userId) {
        const { rows } = await pool_1.pool.query(`SELECT COUNT(*)::text AS count
         FROM notifications
        WHERE user_id = $1 AND is_read = false`, [userId]);
        return parseInt(rows[0]?.count ?? "0", 10);
    }
    async markRead(notificationId, userId) {
        await pool_1.pool.query(`UPDATE notifications
          SET is_read = true
        WHERE id = $1 AND user_id = $2`, [notificationId, userId]);
    }
    async markAllRead(userId) {
        await pool_1.pool.query(`UPDATE notifications
          SET is_read = true
        WHERE user_id = $1 AND is_read = false`, [userId]);
    }
}
exports.NotificationService = NotificationService;
exports.notificationService = new NotificationService();
//# sourceMappingURL=NotificationService.js.map