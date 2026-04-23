import { Request, Response, NextFunction } from "express";
declare global {
    namespace Express {
        interface Request {
            /** Set by any API-key auth middleware to associate the log with a key. */
            apiKeyId?: string;
        }
    }
}
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
export declare function usageLogger(req: Request, res: Response, next: NextFunction): void;
//# sourceMappingURL=usage-logger.d.ts.map