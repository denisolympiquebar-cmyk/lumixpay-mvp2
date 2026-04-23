"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.devLimiter = exports.mutationLimiter = exports.authLimiter = void 0;
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const JSON_HANDLER = (_req, res) => {
    res.status(429).json({ error: "RATE_LIMITED" });
};
/**
 * Strict limiter: auth routes (login / register).
 * 10 attempts per 15 minutes per IP.
 */
exports.authLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: JSON_HANDLER,
    skipSuccessfulRequests: false,
});
/**
 * Moderate limiter: money-mutation endpoints.
 * 30 requests per minute per IP.
 */
exports.mutationLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    handler: JSON_HANDLER,
});
/**
 * Light limiter: developer-facing management endpoints.
 * 60 requests per minute per IP.
 */
exports.devLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    handler: JSON_HANDLER,
});
//# sourceMappingURL=rate-limit.js.map