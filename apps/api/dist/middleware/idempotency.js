"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.idempotent = idempotent;
const crypto_1 = __importDefault(require("crypto"));
const pool_1 = require("../db/pool");
/**
 * Idempotency middleware.
 *
 * Usage (per-route):
 *   router.post("/", authenticate, idempotent, async (req, res) => { ... });
 *
 * Behaviour:
 *   1. If no `Idempotency-Key` header → passes through (no protection).
 *   2. If key seen before with the SAME payload hash → replay cached response.
 *   3. If key seen before with a DIFFERENT payload hash → 409 Conflict.
 *   4. If key is new → execute handler, then store the response for replay.
 *
 * Requires: req.user must be set (authenticate must run first).
 */
function idempotent(req, res, next) {
    const key = req.headers["idempotency-key"];
    if (!key) {
        next();
        return;
    }
    const userId = req.user?.sub;
    if (!userId) {
        next();
        return;
    } // unauthenticated — skip
    // Use a stable route key at router-level (baseUrl + path) to avoid collisions.
    const route = `${req.baseUrl || ""}${req.path}`;
    const method = req.method.toUpperCase();
    const bodyStr = JSON.stringify(req.body ?? {});
    const requestHash = crypto_1.default.createHash("sha256").update(bodyStr).digest("hex");
    // Wrap the rest asynchronously
    void (async () => {
        try {
            // Check for existing record
            const { rows } = await pool_1.pool.query(`SELECT request_hash, response_status, response_body
           FROM idempotency_keys
          WHERE user_id = $1 AND route = $2 AND method = $3 AND idempotency_key = $4`, [userId, route, method, key]);
            if (rows[0]) {
                if (rows[0].request_hash !== requestHash) {
                    // Same key, different payload
                    res.status(409).json({
                        error: "IDEMPOTENCY_CONFLICT",
                        message: "The Idempotency-Key was already used with a different request payload.",
                    });
                    return;
                }
                // Replay stored response
                res.status(rows[0].response_status).json(rows[0].response_body);
                return;
            }
            // Intercept the response so we can store it
            const originalJson = res.json.bind(res);
            res.json = function (body) {
                const statusCode = res.statusCode ?? 200;
                // Only cache successful responses (2xx) so errors aren't replayed
                if (statusCode >= 200 && statusCode < 300) {
                    pool_1.pool
                        .query(`INSERT INTO idempotency_keys
                 (user_id, route, method, idempotency_key, request_hash, response_status, response_body)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (user_id, route, method, idempotency_key) DO NOTHING`, [userId, route, method, key, requestHash, statusCode, JSON.stringify(body)])
                        .catch((e) => console.error("[idempotency] Failed to store record:", e));
                }
                return originalJson(body);
            };
            next();
        }
        catch (err) {
            console.error("[idempotency] middleware error:", err);
            next(); // fail open — let the request through
        }
    })();
}
//# sourceMappingURL=idempotency.js.map