export type DryRunCurrency = "RLUSD" | "EURQ";
export type DryRunResult = {
    status: "sent";
    txHash: string;
    explorerUrl: string;
    validatedAt: Date;
} | {
    status: "not_funded";
    message: string;
} | {
    status: "no_trust_lines";
    message: string;
} | {
    status: "invalid_destination";
    message: string;
} | {
    status: "self_send";
    message: string;
} | {
    status: "config_missing";
    message: string;
} | {
    status: "xrpl_testnet_unavailable";
    message: string;
} | {
    status: "failed";
    error: string;
};
export declare class XrplSettlementDryRunService {
    /**
     * Sends exactly 1 token of `currency` from the caller's LumixPay-managed
     * custodial XRPL Testnet wallet to `destinationAddress`.
     *
     * ── Pre-checks (all before seed decryption) ────────────────────────────────
     *   1. Config: issuer address set, RPC URL is testnet.
     *   2. Destination: valid XRPL address format.
     *   3. No self-send (destination ≠ own custodial address).
     *   4. Wallet funded (funded_at set).
     *   5. Trust lines established (trust_lines_set_at set).
     *
     * ── Flow ──────────────────────────────────────────────────────────────────
     *   1. Fetch account_info for the SENDER (custodial wallet).
     *      Retries 5× for transient errors before returning xrpl_testnet_unavailable.
     *   2. Audit log: xrpl.settlement_test_begin.
     *   3. Decrypt seed → derive Wallet(secp256k1) → sign Payment TX synchronously.
     *      Seed does NOT cross the `await submitTx` boundary.
     *   4. Defensive guard: derived address matches stored address.
     *   5. Submit TX to XRPL Testnet.
     *   6. Poll for validation (up to 45 s).
     *   7. Audit log: xrpl.settlement_test_confirmed / xrpl.settlement_test_failed.
     *
     * ── XRPL Payment TX ──────────────────────────────────────────────────────
     *   TransactionType: "Payment"
     *   Account:         <custodial_wallet.classic_address>        ← SENDER
     *   Destination:     <destinationAddress>
     *   Amount:
     *     currency:      <currencyToHex("RLUSD") | currencyToHex("EURQ")>
     *     issuer:        <XRPL_TESTNET_ISSUER_ADDRESS>
     *     value:         "1"
     *   Fee:             "12"
     *   Sequence:        <account_info.Sequence>
     *   LastLedgerSequence: <ledger_current_index + 40>
     */
    sendTestPayment(userId: string, destinationAddress: string, currency: DryRunCurrency): Promise<DryRunResult>;
    private _auditFailed;
}
export declare const xrplSettlementDryRunService: XrplSettlementDryRunService;
//# sourceMappingURL=XrplSettlementDryRunService.d.ts.map