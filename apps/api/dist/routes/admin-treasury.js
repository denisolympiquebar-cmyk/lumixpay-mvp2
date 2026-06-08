"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../middleware/auth");
const pool_1 = require("../db/pool");
const AuditLogService_1 = require("../services/AuditLogService");
const XrplTreasuryService_1 = require("../services/XrplTreasuryService");
const XrplSettlementQueueService_1 = require("../services/XrplSettlementQueueService");
const router = (0, express_1.Router)();
// ── GET /admin/treasury/revenue?period=today|7d|30d|all ──────────────────────
const PERIOD_SQL = {
    today: "NOW() - INTERVAL '1 day'",
    "7d": "NOW() - INTERVAL '7 days'",
    "30d": "NOW() - INTERVAL '30 days'",
    all: "'1970-01-01'::timestamptz",
};
router.get("/revenue", auth_1.authenticate, (0, auth_1.requireRole)("admin"), async (req, res) => {
    const period = req.query["period"] ?? "all";
    const since = PERIOD_SQL[period] ?? PERIOD_SQL["all"];
    try {
        // All fee entries in the time window, grouped by reference_type.
        // reference_type tells us the origin of each fee:
        //   topup_transactions   → BANK
        //   voucher / voucher_products → BANK
        //   transfers            → CRYPTO
        //   withdrawal_requests  → CRYPTO
        const { rows } = await pool_1.pool.query(`SELECT
         COALESCE(reference_type, 'unknown') AS reference_type,
         SUM(amount)::text                   AS total
       FROM ledger_entries
       WHERE entry_type  = 'fee'
         AND created_at >= ${since}
       GROUP BY reference_type`);
        // Classify into bank vs crypto buckets
        let bankRevenue = 0;
        let cryptoRevenue = 0;
        const breakdown = {};
        for (const row of rows) {
            const amt = parseFloat(row.total ?? "0");
            breakdown[row.reference_type] = amt;
            if (["topup_transactions", "voucher", "voucher_products"].includes(row.reference_type)) {
                bankRevenue += amt;
            }
            else if (["transfers", "withdrawal_requests"].includes(row.reference_type)) {
                cryptoRevenue += amt;
            }
        }
        return res.json({
            period,
            bankRevenue: bankRevenue.toFixed(6),
            cryptoRevenue: cryptoRevenue.toFixed(6),
            totalRevenue: (bankRevenue + cryptoRevenue).toFixed(6),
            breakdown,
        });
    }
    catch (err) {
        console.error("GET /admin/treasury/revenue error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// ── GET /admin/treasury  — view all asset limits ──────────────────────────────
router.get("/", auth_1.authenticate, (0, auth_1.requireRole)("admin"), async (_req, res) => {
    try {
        const { rows } = await pool_1.pool.query(`SELECT tl.*, a.currency_code, a.display_symbol, a.display_name
         FROM treasury_limits tl
         JOIN assets a ON a.id = tl.asset_id
        ORDER BY a.currency_code`);
        return res.json({ limits: rows });
    }
    catch (err) {
        console.error("GET /admin/treasury error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// ── PUT /admin/treasury/:asset_id  — update max_supply or current_supply ──────
const UpdateLimitSchema = zod_1.z.object({
    max_supply: zod_1.z.number().nonnegative().optional(),
    current_supply: zod_1.z.number().nonnegative().optional(),
});
router.put("/:asset_id", auth_1.authenticate, (0, auth_1.requireRole)("admin"), async (req, res) => {
    const { asset_id } = req.params;
    const parsed = UpdateLimitSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    }
    const { max_supply, current_supply } = parsed.data;
    if (max_supply === undefined && current_supply === undefined) {
        return res.status(400).json({ error: "Provide max_supply or current_supply" });
    }
    try {
        // Upsert the treasury limit row
        const sets = ["updated_at = NOW()"];
        const vals = [asset_id];
        if (max_supply !== undefined) {
            sets.push(`max_supply = $${vals.push(max_supply)}`);
        }
        if (current_supply !== undefined) {
            sets.push(`current_supply = $${vals.push(current_supply)}`);
        }
        const { rows, rowCount } = await pool_1.pool.query(`UPDATE treasury_limits SET ${sets.join(", ")} WHERE asset_id = $1 RETURNING *`, vals);
        if (!rowCount) {
            // Upsert if missing
            const insertRes = await pool_1.pool.query(`INSERT INTO treasury_limits (asset_id, max_supply, current_supply)
         VALUES ($1, $2, $3) RETURNING *`, [asset_id, max_supply ?? 1000000, current_supply ?? 0]);
            void AuditLogService_1.auditLogService.log({
                actorUserId: req.user?.sub ?? null,
                actionType: "admin.treasury.upsert",
                entityType: "treasury_limits",
                entityId: asset_id,
                correlationId: req.correlationId ?? null,
                metadata: { max_supply: max_supply ?? 1000000, current_supply: current_supply ?? 0 },
            });
            return res.json({ limit: insertRes.rows[0] });
        }
        void AuditLogService_1.auditLogService.log({
            actorUserId: req.user?.sub ?? null,
            actionType: "admin.treasury.update",
            entityType: "treasury_limits",
            entityId: asset_id,
            correlationId: req.correlationId ?? null,
            metadata: { max_supply, current_supply },
        });
        return res.json({ limit: rows[0] });
    }
    catch (err) {
        console.error("PUT /admin/treasury/:asset_id error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// ── GET /admin/treasury/xrpl-testnet/queue ───────────────────────────────────
//
// Returns the real-time settlement queue status:
//   - Worker running state
//   - Number of pending withdrawals awaiting settlement (DB count)
//   - Number currently in flight within this process
//   - Last / next run timestamps
router.get("/xrpl-testnet/queue", auth_1.authenticate, (0, auth_1.requireRole)("admin"), async (_req, res) => {
    try {
        const [status, queued] = await Promise.all([
            Promise.resolve(XrplSettlementQueueService_1.xrplSettlementQueueService.getStatus()),
            XrplSettlementQueueService_1.xrplSettlementQueueService.getQueuedCount(),
        ]);
        return res.json({
            ok: true,
            workerEnabled: status.workerEnabled,
            queued,
            processing: status.processing,
            lastRunAt: status.lastRunAt,
            nextRunAt: status.nextRunAt,
        });
    }
    catch (err) {
        console.error("GET /admin/treasury/xrpl-testnet/queue error:", err);
        return res.status(500).json({ ok: false, error: "Internal server error" });
    }
});
// ── POST /admin/treasury/xrpl-testnet/queue/run ──────────────────────────────
//
// Triggers one immediate settlement queue cycle outside the 30 s interval.
// Useful for testing or when the admin wants to process approvals right away.
//
// The cycle runs asynchronously — the response returns immediately.
// If a cycle is already running, the response indicates that.
router.post("/xrpl-testnet/queue/run", auth_1.authenticate, (0, auth_1.requireRole)("admin"), async (req, res) => {
    void AuditLogService_1.auditLogService.log({
        actorUserId: req.user?.sub ?? null,
        actionType: "admin.queue.manual_trigger",
        entityType: "system",
        entityId: "xrpl_settlement_queue",
        correlationId: req.correlationId ?? null,
        metadata: { triggeredBy: req.user?.sub ?? "unknown" },
    });
    // Fire the cycle asynchronously — don't await (it can take up to 30s+)
    void XrplSettlementQueueService_1.xrplSettlementQueueService.runCycle();
    const queuedCount = await XrplSettlementQueueService_1.xrplSettlementQueueService.getQueuedCount();
    return res.json({
        ok: true,
        message: `Queue cycle triggered. ${queuedCount} withdrawal(s) pending.`,
        queued: queuedCount,
    });
});
// ── GET /admin/treasury/xrpl-testnet ─────────────────────────────────────────
//
// Returns the XRPL Testnet treasury dashboard:
//   - Treasury/issuer wallet on-chain state (XRP balance, outstanding obligations)
//   - Settlement statistics from withdrawal_requests (aggregated by asset)
//   - Last 20 xrpl_testnet settlement records
//
// READ-ONLY: no seed access, no signing, no DB writes.
router.get("/xrpl-testnet", auth_1.authenticate, (0, auth_1.requireRole)("admin"), async (req, res) => {
    try {
        const result = await XrplTreasuryService_1.xrplTreasuryService.getDashboard();
        if (result.status === "config_missing") {
            return res.status(503).json({ ok: false, status: "config_missing", message: result.message });
        }
        if (result.status === "xrpl_testnet_unavailable") {
            return res.status(503).json({ ok: false, status: "xrpl_testnet_unavailable", message: result.message });
        }
        return res.json({
            ok: true,
            network: result.network,
            treasury: result.treasury,
            health: result.health,
            metrics: result.metrics,
            queueMetrics: result.queueMetrics,
            settlementStats: result.settlementStats,
            recentSettlements: result.recentSettlements,
        });
    }
    catch (err) {
        console.error("GET /admin/treasury/xrpl-testnet error:", err);
        return res.status(500).json({ ok: false, error: "Internal server error" });
    }
});
exports.default = router;
//# sourceMappingURL=admin-treasury.js.map