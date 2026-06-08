export type TrustLineResult = {
    status: "trust_lines_set";
    rlusdTxHash: string;
    eurqTxHash: string;
} | {
    status: "already_set";
} | {
    status: "not_funded";
    message: string;
} | {
    status: "config_missing";
    message: string;
} | {
    status: "failed";
    currency: string;
    error: string;
};
/**
 * Converts a currency name to the 20-byte uppercase hex representation
 * required by ripple-binary-codec for non-standard (>3 char) currency codes.
 *
 * 3-char codes (e.g. "USD") are returned as-is — they are native XRPL ISO codes.
 * Longer codes (e.g. "RLUSD", "EURQ") are ASCII-encoded into the first N bytes
 * of a 20-byte buffer, padded with zeros, then hex-uppercased.
 *
 * Examples:
 *   "RLUSD" → "524C555344000000000000000000000000000000"
 *   "EURQ"  → "4555525100000000000000000000000000000000"
 */
export declare function currencyToHex(currency: string): string;
export declare class TrustLineService {
    /**
     * Establishes XRPL Testnet trust lines for two test currencies on `userId`'s
     * custodial wallet.
     *
     * ── Flow ─────────────────────────────────────────────────────────────────
     *   1. Validate config (issuer address, RPC URL safety guard).
     *   2. Load wallet — require funded_at, skip if trust_lines_set_at already set.
     *   3. Audit log wallet.trust_line_setup_begin.
     *   4. Fetch account_info → current Sequence + LastLedgerSequence.
     *   5. Decrypt seed (ONE call, auto-logged by CustodialWalletService).
     *   6. Sign BOTH TrustSet TXs synchronously (Wallet object lives only here).
     *   7. Submit RLUSD TrustSet → poll for validation.
     *   8. Submit EURQ TrustSet  → poll for validation.
     *   9. UPDATE trust_lines_set_at = NOW().
     *  10. Audit log wallet.trust_line_setup_complete.
     *
     * ── Idempotency ──────────────────────────────────────────────────────────
     *   Returns { status: "already_set" } immediately if trust_lines_set_at is
     *   already populated, without touching the seed or submitting any TX.
     *
     * ── Safety ───────────────────────────────────────────────────────────────
     *   Never logs, stores, or returns the plaintext seed.
     *   All errors are caught and converted to a typed TrustLineResult.
     *   Failure does not affect the user's wallet balance or funded_at status.
     */
    setupTrustLines(userId: string): Promise<TrustLineResult>;
    /**
     * Checks whether both test currency trust lines are present on-ledger for `userId`.
     * Calls account_lines on XRPL Testnet — does NOT decrypt the seed.
     * Returns null if the wallet is not funded or config is missing.
     */
    checkTrustLines(userId: string): Promise<{
        checked: boolean;
        hasRlusd: boolean;
        hasEurq: boolean;
    } | null>;
    private _getAccountInfo;
    private _submitTx;
    private _pollTxValidated;
    private _isTxValidated;
    private _fetchAccountLines;
    private _auditFailed;
}
export declare const trustLineService: TrustLineService;
//# sourceMappingURL=TrustLineService.d.ts.map