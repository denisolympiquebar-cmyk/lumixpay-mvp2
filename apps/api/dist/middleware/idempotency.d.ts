import { Request, Response, NextFunction } from "express";
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
export declare function idempotent(req: Request, res: Response, next: NextFunction): void;
//# sourceMappingURL=idempotency.d.ts.map