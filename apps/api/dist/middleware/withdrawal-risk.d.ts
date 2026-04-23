import { Request, Response, NextFunction } from "express";
/**
 * Soft controls:
 *  - Never blocks normal flows under soft limit thresholds.
 *  - Escalates only clearly risky burst patterns for high-value withdrawals.
 *  - Emits admin alerts for oversight.
 */
export declare function withdrawalRiskGuard(req: Request, res: Response, next: NextFunction): void;
//# sourceMappingURL=withdrawal-risk.d.ts.map