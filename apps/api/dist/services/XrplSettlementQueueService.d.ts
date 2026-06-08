export interface QueueStatus {
    workerEnabled: boolean;
    processing: number;
    lastRunAt: string | null;
    nextRunAt: string | null;
}
export declare class XrplSettlementQueueService {
    private isRunning;
    private workerStarted;
    private processingIds;
    private lastRunAt;
    private nextRunAt;
    private _ledger;
    /** Called once at API startup. Idempotent — safe to call more than once. */
    start(): void;
    /** Returns in-memory worker status. Does NOT query the DB for the queued count. */
    getStatus(): QueueStatus;
    /** Queries the DB for the current number of unsettled approved withdrawals. */
    getQueuedCount(): Promise<number>;
    /**
     * Runs one queue cycle.
     *
     * Public so the admin can trigger an immediate cycle via POST /queue/run.
     * Skips if a previous cycle is still running (isRunning guard).
     */
    runCycle(): Promise<void>;
    private _processBatch;
    private _processOne;
    /**
     * Lazily resolves LedgerService to avoid circular module dependencies at
     * require() time. XrplSettlementQueueService ← LedgerService ← SettlementProvider
     * form a potential cycle if all imported at the top level.
     */
    private _getLedger;
}
export declare const xrplSettlementQueueService: XrplSettlementQueueService;
//# sourceMappingURL=XrplSettlementQueueService.d.ts.map