"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processRecurring = processRecurring;
exports.startRecurringJob = startRecurringJob;
const pool_1 = require("../db/pool");
const LedgerService_1 = require("./LedgerService");
const NotificationService_1 = require("./NotificationService");
/**
 * Processes subscriptions whose next_run_at <= now.
 * Called every 60 seconds from the API startup loop.
 * Each run is idempotent: the transfer's idempotency key encodes
 * subscription_id + next_run_at so double-charges are impossible.
 */
async function processRecurring() {
    let dueRows;
    try {
        const { rows } = await pool_1.pool.query(`SELECT s.*, rp.amount AS plan_amount, rp.asset_id AS plan_asset_id,
              rp.creator_user_id, rp.interval AS plan_interval,
              rp.day_of_week, rp.day_of_month
         FROM subscriptions s
         JOIN recurring_plans rp ON rp.id = s.plan_id
        WHERE s.status = 'active'
          AND rp.status = 'active'
          AND s.next_run_at <= NOW()
        FOR UPDATE SKIP LOCKED`);
        dueRows = rows;
    }
    catch (err) {
        console.error("[RecurringService] Error loading due subscriptions:", err);
        return;
    }
    for (const sub of dueRows) {
        try {
            const [subscriberAccount, creatorAccount] = await Promise.all([
                pool_1.pool.query("SELECT * FROM accounts WHERE user_id = $1 AND asset_id = $2 AND label = 'main'", [sub.subscriber_user_id, sub.plan_asset_id]),
                pool_1.pool.query("SELECT * FROM accounts WHERE user_id = $1 AND asset_id = $2 AND label = 'main'", [sub.creator_user_id, sub.plan_asset_id]),
            ]);
            if (!subscriberAccount.rows[0] || !creatorAccount.rows[0]) {
                console.warn(`[RecurringService] Missing accounts for subscription ${sub.id}`);
                continue;
            }
            await LedgerService_1.ledgerService.transfer({
                fromAccountId: subscriberAccount.rows[0].id,
                toAccountId: creatorAccount.rows[0].id,
                assetId: sub.plan_asset_id,
                grossAmount: sub.plan_amount,
                idempotencyOverride: `recurring:${sub.id}:${sub.next_run_at.toISOString()}`,
            });
            // Compute next_run_at
            const next = computeNextRun(sub);
            await pool_1.pool.query("UPDATE subscriptions SET next_run_at = $1 WHERE id = $2", [next.toISOString(), sub.id]);
            // Notify both parties
            void NotificationService_1.notificationService.create({
                userId: sub.subscriber_user_id,
                type: "recurring.executed",
                title: "Recurring payment charged",
                body: `${sub.plan_amount} charged for subscription`,
                metadata: { subscription_id: sub.id, amount: sub.plan_amount },
            }).catch(() => { });
            void NotificationService_1.notificationService.create({
                userId: sub.creator_user_id,
                type: "recurring.executed",
                title: "Recurring payment received",
                body: `Subscription payment of ${sub.plan_amount} received`,
                metadata: { subscription_id: sub.id, amount: sub.plan_amount },
            }).catch(() => { });
        }
        catch (err) {
            console.error(`[RecurringService] Failed to charge subscription ${sub.id}:`, err.message);
            // On failure, advance next_run_at by 1 hour to avoid rapid retry storms
            await pool_1.pool.query("UPDATE subscriptions SET next_run_at = next_run_at + INTERVAL '1 hour' WHERE id = $1", [sub.id]).catch(() => { });
        }
    }
}
function computeNextRun(sub) {
    const now = new Date();
    if (sub.plan_interval === "weekly") {
        const next = new Date(now);
        next.setDate(now.getDate() + 7);
        return next;
    }
    // monthly
    const next = new Date(now);
    next.setMonth(now.getMonth() + 1);
    const dom = sub.day_of_month ?? now.getDate();
    next.setDate(Math.min(dom, new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()));
    return next;
}
function startRecurringJob() {
    setInterval(() => {
        void processRecurring();
    }, 60_000);
    console.log("[RecurringService] Job runner started (every 60 s)");
}
//# sourceMappingURL=RecurringService.js.map