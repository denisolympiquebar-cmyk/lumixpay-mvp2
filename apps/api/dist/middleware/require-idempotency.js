"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireIdempotencyKey = requireIdempotencyKey;
/**
 * Enforce Idempotency-Key header on high-risk write endpoints.
 * Keeps behavior retry-safe and explicit for integrators.
 */
function requireIdempotencyKey(req, res, next) {
    const key = req.header("idempotency-key");
    if (!key || key.trim().length < 8) {
        res.status(400).json({
            error: "MISSING_IDEMPOTENCY_KEY",
            message: "Idempotency-Key header is required for this endpoint.",
        });
        return;
    }
    next();
}
//# sourceMappingURL=require-idempotency.js.map