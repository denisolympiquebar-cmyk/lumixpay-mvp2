"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.pushService = exports.PushService = void 0;
const web_push_1 = __importDefault(require("web-push"));
const pool_1 = require("../db/pool");
// ─────────────────────────────────────────────────────────────────────────────
// VAPID configuration — loaded once at module init.
// Requires env vars:
//   VAPID_PUBLIC_KEY  — base64url-encoded public key
//   VAPID_PRIVATE_KEY — base64url-encoded private key
//   VAPID_SUBJECT     — mailto: or https: URL
// ─────────────────────────────────────────────────────────────────────────────
const publicKey = process.env["VAPID_PUBLIC_KEY"] ?? "";
const privateKey = process.env["VAPID_PRIVATE_KEY"] ?? "";
const subject = process.env["VAPID_SUBJECT"] ?? "mailto:admin@lumixpay.app";
let vapidConfigured = false;
if (publicKey && privateKey) {
    try {
        web_push_1.default.setVapidDetails(subject, publicKey, privateKey);
        vapidConfigured = true;
    }
    catch (err) {
        console.error("[PushService] Invalid VAPID keys — push notifications disabled:", err);
    }
}
else {
    console.warn("[PushService] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — push disabled.");
}
class PushService {
    /**
     * Send a push notification to every registered device for `userId`.
     * Invalid / expired subscriptions (HTTP 404 / 410) are silently deleted.
     * Never throws — failures are fire-and-forget.
     */
    async sendToUser(userId, payload) {
        if (!vapidConfigured)
            return;
        let subs;
        try {
            const { rows } = await pool_1.pool.query("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1", [userId]);
            subs = rows;
        }
        catch (err) {
            console.error("[PushService] Failed to fetch subscriptions:", err);
            return;
        }
        if (!subs.length)
            return;
        const data = JSON.stringify(payload);
        const staleIds = [];
        await Promise.allSettled(subs.map(async (sub) => {
            try {
                await web_push_1.default.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, data);
            }
            catch (err) {
                // 410 Gone or 404 Not Found → subscription is no longer valid
                if (err?.statusCode === 410 || err?.statusCode === 404) {
                    staleIds.push(sub.id);
                }
                else {
                    console.error(`[PushService] Failed to send to ${sub.id}:`, err?.message ?? err);
                }
            }
        }));
        if (staleIds.length) {
            pool_1.pool
                .query("DELETE FROM push_subscriptions WHERE id = ANY($1)", [staleIds])
                .catch((e) => console.error("[PushService] Failed to delete stale subs:", e));
        }
    }
}
exports.PushService = PushService;
exports.pushService = new PushService();
//# sourceMappingURL=PushService.js.map