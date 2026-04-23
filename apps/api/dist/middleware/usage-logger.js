"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.usageLogger = usageLogger;
const pool_1 = require("../db/pool");
/**
 * Usage-logger middleware — records each request to api_usage_logs.
 *
 * Fire-and-forget: any DB error is silently swallowed so logging never
 * degrades response latency or causes a 500 error.
 *
 * Attach per-router:
 *   app.use("/topup", usageLogger, topupRouter);
 *
 * user_id is taken from req.user (set by `authenticate`).
 * api_key_id is taken from req.apiKeyId (set by any future API-key middleware).
 */
function usageLogger(req, res, next) {
    const startMs = Date.now();
    res.on("finish", () => {
        const responseTimeMs = Date.now() - startMs;
        const userId = req.user?.sub ?? null;
        const apiKeyId = req.apiKeyId ?? null;
        const route = req.route?.path ?? req.path;
        const method = req.method.toUpperCase();
        const status = res.statusCode;
        pool_1.pool
            .query(`INSERT INTO api_usage_logs
           (user_id, api_key_id, route, method, status_code, response_time_ms)
         VALUES ($1, $2, $3, $4, $5, $6)`, [userId, apiKeyId, route, method, status, responseTimeMs])
            .catch(() => { }); // intentionally silent
    });
    next();
}
//# sourceMappingURL=usage-logger.js.map