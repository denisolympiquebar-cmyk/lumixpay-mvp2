import { Request, Response, NextFunction } from "express";
import { pool } from "../db/pool";

/**
 * Middleware: reject the request if the authenticated user's account is frozen.
 * Must be placed after `authenticate`.
 */
export async function requireNotFrozen(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { rows } = await pool.query<{ is_frozen: boolean }>(
      "SELECT is_frozen FROM users WHERE id = $1",
      [req.user!.sub]
    );
    if (rows[0]?.is_frozen) {
      res.status(403).json({ error: "Account is frozen. Contact support to resolve." });
      return;
    }
    next();
  } catch (err) {
    console.error("requireNotFrozen error:", err);
    next(err);
  }
}
