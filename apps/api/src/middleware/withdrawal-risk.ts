import { Request, Response, NextFunction } from "express";
import { adminAlertService } from "../services/AdminAlertService";

type Tier = "retail" | "business" | "institutional";

const overrideMap: Record<string, Tier> = {};
const rawOverrides = process.env["WITHDRAWAL_TIER_OVERRIDES"] ?? "";
for (const pair of rawOverrides.split(",").map((v) => v.trim()).filter(Boolean)) {
  const [userId, tier] = pair.split(":").map((v) => v.trim());
  if (!userId || !tier) continue;
  if (tier === "retail" || tier === "business" || tier === "institutional") overrideMap[userId] = tier;
}

const softDailyLimitByTier: Record<Tier, number> = {
  retail: Number(process.env["SOFT_DAILY_LIMIT_RETAIL"] ?? 1000),
  business: Number(process.env["SOFT_DAILY_LIMIT_BUSINESS"] ?? 10000),
  institutional: Number(process.env["SOFT_DAILY_LIMIT_INSTITUTIONAL"] ?? 100000),
};

const highValueThreshold = Number(process.env["WITHDRAWAL_HIGH_VALUE_THRESHOLD"] ?? 5000);
const highValueBurstPerHour = Number(process.env["WITHDRAWAL_HIGH_VALUE_MAX_PER_HOUR"] ?? 2);

const highValueHits = new Map<string, number[]>();

function resolveTier(req: Request): Tier {
  const userId = req.user?.sub ?? "";
  if (userId && overrideMap[userId]) return overrideMap[userId]!;
  if (req.user?.role === "admin") return "institutional";
  return "retail";
}

/**
 * Soft controls:
 *  - Never blocks normal flows under soft limit thresholds.
 *  - Escalates only clearly risky burst patterns for high-value withdrawals.
 *  - Emits admin alerts for oversight.
 */
export function withdrawalRiskGuard(req: Request, res: Response, next: NextFunction): void {
  const amount = Number(req.body?.gross_amount ?? 0);
  const userId = req.user?.sub;
  if (!userId || !Number.isFinite(amount) || amount <= 0) {
    next();
    return;
  }

  const tier = resolveTier(req);
  const softLimit = softDailyLimitByTier[tier];

  // Soft signal only (non-blocking): large withdrawal relative to tier threshold.
  if (amount >= softLimit) {
    res.setHeader("x-risk-flag", "soft_limit_exceeded");
    void adminAlertService.emit({
      type: "withdrawal.soft_limit_exceeded",
      title: "Soft withdrawal limit exceeded",
      body: `User ${userId} requested ${amount.toFixed(2)} above ${tier} soft limit ${softLimit.toFixed(2)}`,
      severity: "warning",
      metadata: { user_id: userId, amount, tier, soft_limit: softLimit },
      dedupeKey: `${userId}:${Math.floor(Date.now() / (30 * 60 * 1000))}`,
      dedupeMinutes: 30,
    });
  }

  // High-value burst escalation (blocking): very large + too many in short window.
  if (amount >= highValueThreshold) {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const existing = highValueHits.get(userId) ?? [];
    const recent = existing.filter((ts) => ts >= oneHourAgo);
    recent.push(now);
    highValueHits.set(userId, recent);

    if (recent.length > highValueBurstPerHour) {
      void adminAlertService.emit({
        type: "withdrawal.high_value_burst",
        title: "High-value withdrawal burst detected",
        body: `User ${userId} exceeded high-value withdrawal burst threshold`,
        severity: "critical",
        metadata: {
          user_id: userId,
          amount,
          threshold: highValueThreshold,
          count_last_hour: recent.length,
          max_per_hour: highValueBurstPerHour,
        },
        dedupeKey: `${userId}:high_value_burst`,
        dedupeMinutes: 15,
      });
      res.status(429).json({ error: "WITHDRAWAL_RISK_ESCALATED" });
      return;
    }
  }

  next();
}

