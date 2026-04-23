/**
 * Strict limiter: auth routes (login / register).
 * 10 attempts per 15 minutes per IP.
 */
export declare const authLimiter: import("express-rate-limit").RateLimitRequestHandler;
/**
 * Moderate limiter: money-mutation endpoints.
 * 30 requests per minute per IP.
 */
export declare const mutationLimiter: import("express-rate-limit").RateLimitRequestHandler;
/**
 * Light limiter: developer-facing management endpoints.
 * 60 requests per minute per IP.
 */
export declare const devLimiter: import("express-rate-limit").RateLimitRequestHandler;
//# sourceMappingURL=rate-limit.d.ts.map