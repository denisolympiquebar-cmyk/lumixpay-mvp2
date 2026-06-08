import { PoolClient } from "pg";
export type FundingResult = {
    status: "funded";
    wallet: CustodialWalletPublic;
    txHash?: string;
} | {
    status: "already_funded";
    wallet: CustodialWalletPublic;
} | {
    status: "pending_confirmation";
    message: string;
    txHash?: string;
} | {
    status: "no_wallet";
} | {
    status: "disabled";
} | {
    status: "faucet_error";
    code: string;
    message: string;
};
export interface CustodialWalletPublic {
    id: string;
    network: string;
    classic_address: string;
    public_key: string;
    wallet_type: string;
    is_active: boolean;
    funded_at: Date | null;
    trust_lines_set_at: Date | null;
    created_at: Date;
}
export declare class CustodialWalletService {
    /**
     * Generates a new XRPL Testnet wallet for `userId` and persists the encrypted
     * seed inside the caller's open DB transaction.
     *
     * Must be called INSIDE a BEGIN ... COMMIT block so that a registration
     * failure rolls back the wallet row together with the user row.
     *
     * Returns the public wallet fields on success.
     * Returns null in development when WALLET_MASTER_KEY is not set (skips silently).
     * Throws in production when WALLET_MASTER_KEY is not set.
     */
    provision(userId: string, client: PoolClient): Promise<CustodialWalletPublic | null>;
    /**
     * Returns public custodial wallet fields for `userId`.
     * Never includes encrypted_seed — that column is excluded by the SELECT.
     * Returns null if the user has no active custodial wallet (e.g. old account
     * created before Phase 1, or provisioning was skipped in dev).
     */
    getWallet(userId: string): Promise<CustodialWalletPublic | null>;
    /**
     * Requests XRPL Testnet XRP from the official faucet for `userId`'s
     * custodial wallet, then verifies the account exists on-ledger before
     * setting funded_at. Safe to call fire-and-forget after registration commits.
     *
     * ── Flow ─────────────────────────────────────────────────────────────────
     *   1. Pre-check:  call account_info — if already on-ledger, set funded_at + return.
     *   2. Faucet:     POST { "destination": address } to faucet.altnet.rippletest.net.
     *   3. Poll:       retry account_info every 2 s for up to 30 s.
     *      a. Confirmed → UPDATE funded_at = NOW() → return "funded".
     *      b. Timeout   → return "pending_confirmation" (funded_at left NULL).
     *
     * ── Safety guarantees ─────────────────────────────────────────────────────
     *   - funded_at is set ONLY after account_info returns status=success.
     *   - Never creates a new wallet or modifies the encrypted seed.
     *   - Is idempotent: if funded_at is already set, returns "already_funded".
     *   - If XRPL_AUTO_FUND_CUSTODIAL_WALLETS=false, returns "disabled".
     */
    requestTestnetFunding(userId: string): Promise<FundingResult>;
    /** Internal helper: atomically set funded_at = NOW() for active unfunded wallet. */
    private _setFundedAt;
    /**
     * Decrypts and returns the plaintext seed for `userId`'s custodial wallet.
     *
     * ── DO NOT CALL FROM HTTP ROUTE HANDLERS ─────────────────────────────────
     * This method is reserved for internal settlement / signing services only.
     * Every call is written to audit_logs for traceability.
     *
     * Phase 1: implemented but not yet called by any route.
     * Phase 2: called by XrplSettlementService to sign on-chain transactions.
     *
     * NEVER log, expose in API responses, or store the return value.
     */
    decryptSeed(userId: string, reason: string): Promise<string>;
}
export declare const custodialWalletService: CustodialWalletService;
//# sourceMappingURL=CustodialWalletService.d.ts.map