import { SettlementProvider, SettlementRequest, SettlementResult } from "./SettlementProvider";
export declare class XrplTestnetSettlementProvider implements SettlementProvider {
    /**
     * Executes an XRPL Testnet issued-currency Payment from the treasury/issuer
     * wallet to the withdrawal destination address.
     *
     * Contract: never throws — all errors are returned via SettlementResult.status.
     *
     * ── Flow ─────────────────────────────────────────────────────────────────
     *   1. Validate config (issuer address, seed, RPC URL, asset code).
     *   2. Log begin audit event.
     *   3. Fetch issuer account_info (Sequence, ledger index) with retry.
     *   4. Synchronously: read seed → derive Wallet(secp256k1) → sign TX → seed out of scope.
     *   5. Submit signed TX blob.
     *   6. If engine result is immediate failure (tec*, tem*, tef*, tefPAST_SEQ, etc.): return failed.
     *   7. If accepted (tes* or ter*): poll for on-ledger validation.
     *   8. Return confirmed / timeout / failed based on poll outcome.
     *
     * ── XRPL Payment TX ──────────────────────────────────────────────────────
     *   TransactionType:    "Payment"
     *   Account:            config.xrplTestnetIssuerAddress   ← treasury/issuer signs
     *   Destination:        request.destinationAddress
     *   DestinationTag:     request.destinationTag (if present)
     *   Amount.currency:    currencyToHex("RLUSD") | currencyToHex("EURQ")
     *   Amount.issuer:      config.xrplTestnetIssuerAddress   ← always testnet issuer
     *   Amount.value:       request.amountDecimal
     *   Fee:                "12" (drops)
     *   Sequence:           issuer account_info.Sequence
     *   LastLedgerSequence: ledger_current_index + 40
     *
     * Note: request.assetIssuerAddress (from the assets table) is IGNORED because
     * it may contain a mainnet issuer address. The testnet issuer from config is
     * always used instead, and a warning is logged when they differ.
     */
    settle(request: SettlementRequest): Promise<SettlementResult>;
    private _settle;
    private _audit;
}
export declare const xrplTestnetSettlementProvider: XrplTestnetSettlementProvider;
//# sourceMappingURL=XrplTestnetSettlementProvider.d.ts.map