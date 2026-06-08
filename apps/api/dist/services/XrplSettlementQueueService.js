"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.xrplSettlementQueueService = exports.XrplSettlementQueueService = void 0;
const pool_1 = require("../db/pool");
const AuditLogService_1 = require("./AuditLogService");
// ─────────────────────────────────────────────────────────────────────────────
// XrplSettlementQueueService — Phase 3E.1
//
// A simple in-process polling worker that automatically settles approved
// XRPL Testnet withdrawals without manual admin intervention.
//
// ── DESIGN PRINCIPLES ────────────────────────────────────────────────────────
//   - No Redis, no BullMQ, no new infrastructure.
//   - Uses setInterval(30 s) — one cycle at a time (isRunning guard).
//   - Delegates all settlement logic to ledgerService.settleWithdrawal().
//   - Failure of one withdrawal never stops the queue (per-item try/catch).
//   - The "Settle" button remains available as a manual override.
//
// ── SAFETY GUARANTEES ─────────────────────────────────────────────────────────
//   - Only picks up: status = 'approved' AND xrpl_submitted_at IS NULL.
//   - Does NOT call XRPL directly — only calls ledgerService.settleWithdrawal().
//   - Does NOT modify accounting, balances, or the settlement provider.
//   - LedgerService already has a SETTLEMENT_IN_FLIGHT guard (xrpl_submitted_at
//     IS NOT NULL → 409) as a second layer of protection.
//   - processingIds tracks in-flight IDs in this process so the same ID is
//     never submitted to two concurrent _processOne() calls.
// ─────────────────────────────────────────────────────────────────────────────
const INTERVAL_MS = 30_000;
const BATCH_SIZE = 10;
// ── XrplSettlementQueueService ────────────────────────────────────────────────
class XrplSettlementQueueService {
    isRunning = false;
    workerStarted = false;
    processingIds = new Set();
    lastRunAt = null;
    nextRunAt = null;
    // Lazily resolved to avoid circular deps at module load time
    _ledger = null;
    // ── Lifecycle ──────────────────────────────────────────────────────────────
    /** Called once at API startup. Idempotent — safe to call more than once. */
    start() {
        if (this.workerStarted)
            return;
        this.workerStarted = true;
        this.nextRunAt = new Date(Date.now() + INTERVAL_MS);
        setInterval(() => { void this.runCycle(); }, INTERVAL_MS);
        console.log(`[SettlementQueue] Worker started — scanning every ${INTERVAL_MS / 1000} s`);
    }
    // ── Status ─────────────────────────────────────────────────────────────────
    /** Returns in-memory worker status. Does NOT query the DB for the queued count. */
    getStatus() {
        return {
            workerEnabled: this.workerStarted,
            processing: this.processingIds.size,
            lastRunAt: this.lastRunAt?.toISOString() ?? null,
            nextRunAt: this.nextRunAt?.toISOString() ?? null,
        };
    }
    /** Queries the DB for the current number of unsettled approved withdrawals. */
    async getQueuedCount() {
        const { rows } = await pool_1.pool.query(`SELECT COUNT(*)::text AS n
         FROM withdrawal_requests
        WHERE status = 'approved'
          AND xrpl_submitted_at IS NULL`);
        return parseInt(rows[0]?.n ?? "0", 10);
    }
    // ── Cycle ──────────────────────────────────────────────────────────────────
    /**
     * Runs one queue cycle.
     *
     * Public so the admin can trigger an immediate cycle via POST /queue/run.
     * Skips if a previous cycle is still running (isRunning guard).
     */
    async runCycle() {
        if (this.isRunning) {
            console.log("[SettlementQueue] Previous cycle still running — skipping this tick.");
            return;
        }
        this.isRunning = true;
        try {
            await this._processBatch();
        }
        catch (err) {
            // Batch-level errors (e.g. DB unreachable) are caught here so the worker
            // stays alive and retries on the next tick.
            console.error("[SettlementQueue] Batch-level error (non-fatal):", err);
        }
        finally {
            this.isRunning = false;
            this.lastRunAt = new Date();
            this.nextRunAt = new Date(Date.now() + INTERVAL_MS);
        }
    }
    // ── Internals ──────────────────────────────────────────────────────────────
    async _processBatch() {
        const { rows } = await pool_1.pool.query(`SELECT id
         FROM withdrawal_requests
        WHERE status = 'approved'
          AND xrpl_submitted_at IS NULL
        ORDER BY created_at ASC
        LIMIT $1`, [BATCH_SIZE]);
        if (rows.length === 0) {
            // Nothing to process — silent tick
            return;
        }
        console.log(`[SettlementQueue] Picked up ${rows.length} withdrawal(s) to settle.`);
        for (const { id } of rows) {
            if (this.processingIds.has(id)) {
                // This can happen if a previous long-running cycle overlaps via
                // `runCycle()` called manually while the interval is active.
                console.log(`[SettlementQueue] Skipping ${id} — already in flight.`);
                continue;
            }
            // Process sequentially — one failure does not skip remaining items
            await this._processOne(id);
        }
    }
    async _processOne(withdrawalId) {
        this.processingIds.add(withdrawalId);
        console.log(`[SettlementQueue] → Processing ${withdrawalId}…`);
        void AuditLogService_1.auditLogService.log({
            actorUserId: null,
            actionType: "xrpl.queue.pickup",
            entityType: "withdrawal_requests",
            entityId: withdrawalId,
            correlationId: null,
            metadata: { withdrawalId, worker: "XrplSettlementQueue" },
        });
        try {
            const ledger = this._getLedger();
            const result = await ledger.settleWithdrawal({
                withdrawalId,
                adminId: "SYSTEM_QUEUE",
            });
            console.log(`[SettlementQueue] ✓ Settled ${withdrawalId} ` +
                `status=${result.status} txHash=${result.xrpl_tx_hash ?? "—"}`);
            void AuditLogService_1.auditLogService.log({
                actorUserId: null,
                actionType: "xrpl.queue.success",
                entityType: "withdrawal_requests",
                entityId: withdrawalId,
                correlationId: null,
                metadata: {
                    withdrawalId,
                    status: result.status,
                    txHash: result.xrpl_tx_hash ?? null,
                },
            });
        }
        catch (err) {
            // LedgerService throws on failed/timeout settlements.
            // xrpl_submitted_at has already been reset (auto-commit) before the throw,
            // so the withdrawal is immediately retryable on the next cycle.
            const code = err.code ?? "UNKNOWN";
            const message = err.message ?? String(err);
            console.error(`[SettlementQueue] ✗ Failed to settle ${withdrawalId}: [${code}] ${message}`);
            void AuditLogService_1.auditLogService.log({
                actorUserId: null,
                actionType: "xrpl.queue.failed",
                entityType: "withdrawal_requests",
                entityId: withdrawalId,
                correlationId: null,
                metadata: {
                    withdrawalId,
                    errorCode: code,
                    error: message,
                    friendlyError: err.friendlyError ?? null,
                    txHash: err.txHash ?? null,
                },
            });
            // Do NOT rethrow — one failed withdrawal must not stop the queue.
        }
        finally {
            this.processingIds.delete(withdrawalId);
        }
    }
    /**
     * Lazily resolves LedgerService to avoid circular module dependencies at
     * require() time. XrplSettlementQueueService ← LedgerService ← SettlementProvider
     * form a potential cycle if all imported at the top level.
     */
    _getLedger() {
        if (!this._ledger) {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            this._ledger = require("./LedgerService").ledgerService;
        }
        return this._ledger;
    }
}
exports.XrplSettlementQueueService = XrplSettlementQueueService;
exports.xrplSettlementQueueService = new XrplSettlementQueueService();
//# sourceMappingURL=XrplSettlementQueueService.js.map