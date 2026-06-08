export type DiagnosticsAssetCode = "RLUSD" | "EURQ";
export interface DiagnosticsOk {
    status: "ok";
    address: string;
    currency: DiagnosticsAssetCode;
    network: "xrpl_testnet";
    accountExists: boolean;
    xrpBalance: string | null;
    requiredIssuer: string;
    requiredCurrency: string;
    hasRequiredTrustLine: boolean;
    ready: boolean;
    message: string;
}
export type DiagnosticsResult = DiagnosticsOk | {
    status: "invalid_address";
    message: string;
} | {
    status: "xrpl_testnet_unavailable";
    message: string;
} | {
    status: "config_missing";
    message: string;
};
export declare class XrplDestinationDiagnosticsService {
    /**
     * Checks whether `address` can receive issued currency `assetCode` from the
     * configured XRPL Testnet issuer.
     *
     * ── Checks performed ────────────────────────────────────────────────────────
     *   1. Address format (XRPL classic address regex).
     *   2. account_info — whether the account exists on the validated ledger.
     *   3. account_lines — whether a trust line to the testnet issuer for the
     *      requested currency exists (and has a non-zero limit).
     *
     * ── Safety ───────────────────────────────────────────────────────────────────
     *   Read-only. No seeds, no signing, no DB writes.
     */
    checkDestination(address: string, assetCode: DiagnosticsAssetCode): Promise<DiagnosticsResult>;
}
export declare const xrplDestinationDiagnosticsService: XrplDestinationDiagnosticsService;
//# sourceMappingURL=XrplDestinationDiagnosticsService.d.ts.map