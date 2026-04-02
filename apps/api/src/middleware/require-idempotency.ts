import { Request, Response, NextFunction } from "express";

/**
 * Enforce Idempotency-Key header on high-risk write endpoints.
 * Keeps behavior retry-safe and explicit for integrators.
 */
export function requireIdempotencyKey(req: Request, res: Response, next: NextFunction): void {
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

