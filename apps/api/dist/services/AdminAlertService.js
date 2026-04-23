"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminAlertService = exports.AdminAlertService = void 0;
const pool_1 = require("../db/pool");
function keyToStableHash(input) {
    let h = 0;
    for (let i = 0; i < input.length; i++)
        h = (h << 5) - h + input.charCodeAt(i);
    return Math.abs(h);
}
/**
 * Fire-and-forget helper for operational risk alerts.
 * Includes coarse dedupe/cooldown to reduce noisy duplicate alerts.
 */
class AdminAlertService {
    async emit(params) {
        const { type, title, body, severity, metadata, dedupeKey, dedupeMinutes = 30, } = params;
        try {
            if (dedupeKey) {
                const hash = keyToStableHash(`${type}:${dedupeKey}`);
                const { rows } = await pool_1.pool.query(`SELECT id
             FROM admin_alerts
            WHERE type = $1
              AND metadata->>'dedupe_hash' = $2
              AND created_at >= NOW() - ($3::text || ' minutes')::interval
            LIMIT 1`, [type, String(hash), String(dedupeMinutes)]);
                if (rows[0])
                    return;
            }
            await pool_1.pool.query(`INSERT INTO admin_alerts (type, title, body, metadata, severity)
         VALUES ($1, $2, $3, $4, $5)`, [
                type,
                title,
                body ?? null,
                JSON.stringify({
                    ...(metadata ?? {}),
                    ...(dedupeKey ? { dedupe_hash: String(keyToStableHash(`${type}:${dedupeKey}`)) } : {}),
                }),
                severity,
            ]);
        }
        catch (err) {
            console.error("[AdminAlertService] emit failed:", err);
        }
    }
}
exports.AdminAlertService = AdminAlertService;
exports.adminAlertService = new AdminAlertService();
//# sourceMappingURL=AdminAlertService.js.map