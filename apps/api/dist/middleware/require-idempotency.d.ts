import { Request, Response, NextFunction } from "express";
/**
 * Enforce Idempotency-Key header on high-risk write endpoints.
 * Keeps behavior retry-safe and explicit for integrators.
 */
export declare function requireIdempotencyKey(req: Request, res: Response, next: NextFunction): void;
//# sourceMappingURL=require-idempotency.d.ts.map