export type DropCurrency = "RLUSD" | "EURQ";
export type DropResult = {
    status: "sent";
    currency: DropCurrency;
    amount: string;
    xrplTxHash: string;
    explorerUrl: string;
    confirmedAt: Date;
} | {
    status: "already_requested_recently";
    cooldownRemainingSeconds: number;
    lastDropAt: Date;
} | {
    status: "no_trust_lines";
    message: string;
} | {
    status: "not_funded";
    message: string;
} | {
    status: "config_missing";
    message: string;
} | {
    status: "disabled";
} | {
    status: "xrpl_testnet_unavailable";
    message: string;
} | {
    status: "failed";
    error: string;
};
export interface DropRecord {
    id: string;
    currency: string;
    amount_decimal: string;
    xrpl_tx_hash: string | null;
    status: "pending" | "confirmed" | "failed";
    error_message: string | null;
    requested_at: Date;
    confirmed_at: Date | null;
    explorerUrl: string | null;
}
export interface IssuedBalance {
    currency: string;
    label: string;
    issuer: string;
    balance: string;
}
export interface OnchainBalances {
    xrpBalance: string;
    reserveBalance: string;
    availableXrpBalance: string;
    issuedBalances: IssuedBalance[];
}
export type OnchainBalancesResult = {
    status: "ok";
    walletAddress: string;
    balances: OnchainBalances;
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
export declare class TestTokenService {
    /**
     * Sends test issued tokens from the XRPL Testnet issuer wallet to
     * `userId`'s custodial wallet.
     *
     * ── Pre-checks ────────────────────────────────────────────────────────────
     *   1. Feature must be enabled (XRPL_TEST_TOKEN_DROP_ENABLED=true).
     *   2. Issuer address and seed must be configured.
     *   3. RPC URL must be XRPL Testnet (altnet/rippletest guard).
     *   4. User must have an active, funded custodial wallet.
     *   5. User must have established trust lines (trust_lines_set_at set).
     *   6. No confirmed/pending drop for the same currency within cooldown window.
     *
     * ── Flow ─────────────────────────────────────────────────────────────────
     *   1. Insert pending row in xrpl_test_token_drops.
     *   2. Audit log: xrpl.test_token_drop_begin.
     *   3. Fetch issuer account_info (Sequence + current ledger index).
     *   4. Build + sign Payment TX (issuer → user custodial address).
     *      ECDSA.secp256k1, same algorithm used to generate issuer wallet.
     *   5. Defensive guard: issuerWallet.classicAddress === XRPL_TESTNET_ISSUER_ADDRESS.
     *   6. Submit TX to XRPL Testnet.
     *   7. Poll tx RPC until validated:true + tesSUCCESS (up to 45 s).
     *   8. Update DB row: status=confirmed, xrpl_tx_hash, confirmed_at.
     *   9. Audit log: xrpl.test_token_drop_confirmed.
     *
     * ── Isolation guarantees ─────────────────────────────────────────────────
     *   - Does NOT touch LedgerService, balances, ledger_entries, or topup_transactions.
     *   - Does NOT decrypt user's custodial wallet seed.
     *   - Internal LumixPay balances are unaffected.
     */
    requestDrop(userId: string, currency: DropCurrency): Promise<DropResult>;
    /**
     * Returns the most recent test token drops for `userId`, newest first.
     * Includes a pre-computed explorerUrl for each confirmed drop.
     */
    recentDrops(userId: string, limit?: number): Promise<DropRecord[]>;
    /**
     * Returns the real on-chain XRP and issued token balances for `userId`'s
     * custodial XRPL Testnet wallet.
     *
     * Uses:
     *   - account_info  → XRP balance (drops) + OwnerCount for reserve calc
     *   - account_lines → issued token balances filtered to XRPL_TESTNET_ISSUER_ADDRESS
     *
     * Both calls use withRetry (5×, 2 s apart) for transient XRPL unavailability.
     *
     * SAFETY:
     *   - Read-only: no DB writes, no ledger_entries, no seed access.
     *   - Does NOT affect internal LumixPay balances.
     *   - Returns amounts in human-readable XRP (not drops).
     *   - Only reports balances from the configured testnet issuer.
     */
    getOnchainBalances(userId: string): Promise<OnchainBalancesResult>;
    private _getAccountInfo;
    private _submitTx;
    private _pollTxValidated;
    private _isTxValidated;
    /**
     * Fetches XRP balance (in drops) and OwnerCount for `address`.
     * Used only for balance display — does NOT decrypt or access any seed.
     * Uses `ledger_index: "validated"` for a confirmed ledger state.
     */
    private _getAccountXrpInfo;
    /**
     * Fetches all trust-line entries for `address` from the validated ledger.
     * Used only for balance display — does NOT decrypt or access any seed.
     * Caller filters the returned lines by issuer address.
     */
    private _fetchAccountLines;
    private _markFailed;
    private _auditFailed;
}
export declare const testTokenService: TestTokenService;
//# sourceMappingURL=TestTokenService.d.ts.map