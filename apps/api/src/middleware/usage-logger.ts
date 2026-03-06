import { Request, Response, NextFunction } from "express";
import { pool } from "../db/pool";

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
export function usageLogger(req: Request, res: Response, next: NextFunction): void {
  const startMs = Date.now();

  res.on("finish", () => {
    const responseTimeMs = Date.now() - startMs;
    const userId    = req.user?.sub ?? null;
    const apiKeyId  = req.apiKeyId  ?? null;
    const route     = req.route?.path ?? req.path;
    const method    = req.method.toUpperCase();
    const status    = res.statusCode;

    pool
      .query(
        `INSERT INTO api_usage_logs
           (user_id, api_key_id, route, method, status_code, response_time_ms)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, apiKeyId, route, method, status, responseTimeMs]
      )
      .catch(() => {}); // intentionally silent
  });

  next();
}
