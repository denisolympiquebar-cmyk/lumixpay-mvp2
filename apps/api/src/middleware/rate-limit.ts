import rateLimit from "express-rate-limit";

const JSON_HANDLER = (_req: any, res: any) => {
  res.status(429).json({ error: "RATE_LIMITED" });
};

/**
 * Strict limiter: auth routes (login / register).
 * 10 attempts per 15 minutes per IP.
 */
export const authLimiter = rateLimit({
  windowMs:         15 * 60 * 1000,
  max:              10,
  standardHeaders:  true,
  legacyHeaders:    false,
  handler:          JSON_HANDLER,
  skipSuccessfulRequests: false,
});

/**
 * Moderate limiter: money-mutation endpoints.
 * 30 requests per minute per IP.
 */
export const mutationLimiter = rateLimit({
  windowMs:         60 * 1000,
  max:              30,
  standardHeaders:  true,
  legacyHeaders:    false,
  handler:          JSON_HANDLER,
});

/**
 * Light limiter: developer-facing management endpoints.
 * 60 requests per minute per IP.
 */
export const devLimiter = rateLimit({
  windowMs:         60 * 1000,
  max:              60,
  standardHeaders:  true,
  legacyHeaders:    false,
  handler:          JSON_HANDLER,
});
