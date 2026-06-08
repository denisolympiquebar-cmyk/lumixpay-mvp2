export interface TreasuryWalletState {
    address: string;
    accountExists: boolean;
    /** Raw XRP balance string e.g. "123.456000". Null if account not found. */
    xrpBalance: string | null;
    ownerCount: number | null;
    /**
     * Tokens currently in circulation (issued by this wallet).
     *
     * XRPL issuer mechanic: when the issuer calls account_lines, each line
     * represents an obligation — i.e. another account holding the issuer's
     * tokens. The line.balance is NEGATIVE from the issuer's perspective.
     * Summing abs(line.balance) per currency gives total tokens outstanding.
     *
     * This is different from a normal account's balance view.
     */
    totalIssuedRLUSD: string | null;
    totalIssuedEURQ: string | null;
}
export interface SettlementStats {
    pendingWithdrawals: number;
    approvedWithdrawals: number;
    settledWithdrawals: number;
    rejectedWithdrawals: number;
    /** Rows stuck with xrpl_submitted_at set but unconfirmed (legacy bug / crash). */
    stuckWithdrawals: number;
    totalSettledRLUSD: string;
    totalSettledEURQ: string;
    totalFeesRLUSD: string;
    totalFeesEURQ: string;
    totalNetworkFeesXRP: string;
    lastSettlementAt: string | null;
}
export interface RecentSettlement {
    id: string;
    userEmail: string;
    currencyCode: string;
    grossAmount: string;
    netAmount: string;
    feeAmount: string;
    status: string;
    destinationAddress: string;
    xrplTxHash: string | null;
    xrplConfirmedAt: string | null;
    xrplNetworkFeeXrp: string | null;
    explorerUrl: string | null;
}
export type TreasuryHealthStatus = "healthy" | "warning" | "critical";
export interface TreasuryHealth {
    status: TreasuryHealthStatus;
    message: string;
    xrpBalance: string;
    thresholdWarning: string;
    thresholdCritical: string;
}
export interface SettlementMetrics {
    totalSettlements: number;
    successfulSettlements: number;
    /**
     * Count of unique withdrawal IDs that have at least one failure recorded in
     * audit_logs (xrpl.queue.failed / xrpl.treasury_settlement_failed) and are
     * not yet settled. Excludes retries — each withdrawal counts once.
     */
    failedSettlements: number;
    settlementSuccessRate: string;
    averageConfirmationSeconds: string | null;
    totalSettledRLUSD: string;
    totalSettledEURQ: string;
    totalSettlementVolume: string;
    totalNetworkFeesXRP: string;
    lastSuccessfulSettlementAt: string | null;
    lastFailedSettlementAt: string | null;
}
export interface QueueMetrics {
    workerEnabled: boolean;
    queued: number;
    processing: number;
    lastRunAt: string | null;
    nextRunAt: string | null;
    lastSuccessfulQueueRun: string | null;
    lastFailedQueueRun: string | null;
}
export type XrplTreasuryResult = {
    status: "ok";
    network: "xrpl_testnet";
    treasury: TreasuryWalletState;
    health: TreasuryHealth;
    metrics: SettlementMetrics;
    queueMetrics: QueueMetrics;
    settlementStats: SettlementStats;
    recentSettlements: RecentSettlement[];
} | {
    status: "config_missing";
    message: string;
} | {
    status: "xrpl_testnet_unavailable";
    message: string;
};
export declare class XrplTreasuryService {
    /**
     * Returns the full treasury dashboard snapshot:
     *   - On-chain wallet state from XRPL Testnet (account_info + account_lines)
     *   - Settlement stats aggregated from withdrawal_requests
     *   - Last 20 xrpl_testnet settlements
     *
     * READ-ONLY: no seeds, no signing, no DB writes.
     */
    getDashboard(): Promise<XrplTreasuryResult>;
}
export declare const xrplTreasuryService: XrplTreasuryService;
//# sourceMappingURL=XrplTreasuryService.d.ts.map