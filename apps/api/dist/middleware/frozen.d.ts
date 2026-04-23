import { Request, Response, NextFunction } from "express";
/**
 * Middleware: reject the request if the authenticated user's account is frozen.
 * Must be placed after `authenticate`.
 */
export declare function requireNotFrozen(req: Request, res: Response, next: NextFunction): Promise<void>;
//# sourceMappingURL=frozen.d.ts.map