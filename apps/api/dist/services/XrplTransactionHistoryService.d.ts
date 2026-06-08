export interface WalletTransaction {
    hash: string;
    type: "Payment" | "TrustSet";
    direction: "IN" | "OUT" | "SYSTEM";
    currency: string;
    trustLineCurrency?: string;
    amount: string;
    counterparty: string;
    status: "confirmed" | "failed";
    ledgerIndex?: number;
    timestamp: string | null;
    explorerUrl: string;
}
export type TxHistoryResult = {
    status: "ok";
    walletAddress: string;
    transactions: WalletTransaction[];
} | {
    status: "not_funded";
    message: string;
} | {
    status: "no_wallet";
    message: string;
} | {
    status: "xrpl_testnet_unavailable";
    message: string;
} | {
    status: "failed";
    error: string;
};
export declare class XrplTransactionHistoryService {
    /**
     * Fetches and maps transaction history for `userId`'s custodial wallet.
     *
     * ── Data source ──────────────────────────────────────────────────────────
     *   XRPL JSON-RPC account_tx, `forward: false` (newest first).
     *   Transactions are read from the validated ledger only (`validated: true`).
     *
     * ── Filtering rules ──────────────────────────────────────────────────────
     *   Payment transactions:
     *     - XRP payments: included regardless of counterparty.
     *     - Issued-currency payments: included ONLY if Amount.issuer equals
     *       XRPL_TESTNET_ISSUER_ADDRESS. Unknown-issuer tokens are dropped.
     *   TrustSet transactions:
     *     - Included ONLY if Account === wallet address AND
     *       LimitAmount.issuer === XRPL_TESTNET_ISSUER_ADDRESS.
     *   All other transaction types (AccountSet, OfferCreate, etc.) are ignored.
     *
     * ── Safety ───────────────────────────────────────────────────────────────
     *   Read-only. No DB writes. No seed access. No balance changes.
     */
    getTransactionHistory(userId: string, limit: number): Promise<TxHistoryResult>;
    /**
     * Calls account_tx on XRPL Testnet for `address`.
     * Returns raw entries newest-first (`forward: false`).
     * Throws on HTTP errors or XRPL logical errors (noNetwork, etc.) so that
     * the withRetry wrapper above can handle transient failures.
     */
    private _fetchAccountTx;
}
export declare const xrplTransactionHistoryService: XrplTransactionHistoryService;
//# sourceMappingURL=XrplTransactionHistoryService.d.ts.map