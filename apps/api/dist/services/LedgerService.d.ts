import Decimal from "decimal.js";
import { LedgerEntry, TopupTransaction, Transfer, WithdrawalRequest, AccountWithBalance } from "../db/types";
import { FeeService } from "./FeeService";
import { MockPaymentProvider, AllowedTopupAmount } from "./MockPaymentProvider";
import { SettlementProvider } from "../xrpl";
export interface TopUpParams {
    userId: string;
    accountId: string;
    assetId: string;
    grossAmount: AllowedTopupAmount;
    simulatedCardLast4: string;
}
export interface TopUpResult {
    topupTransaction: TopupTransaction;
    entries: LedgerEntry[];
}
export interface TransferParams {
    fromAccountId: string;
    toAccountId: string;
    assetId: string;
    grossAmount: Decimal | string | number;
    idempotencyOverride?: string;
}
export interface TransferResult {
    transfer: Transfer;
    entries: LedgerEntry[];
}
export interface WithdrawalParams {
    userId: string;
    accountId: string;
    assetId: string;
    grossAmount: Decimal | string | number;
    xrplDestinationAddress: string;
    xrplDestinationTag?: number;
}
export interface ReviewWithdrawalParams {
    withdrawalId: string;
    adminId: string;
    decision: "approve" | "reject";
    note?: string;
}
export interface SettleWithdrawalParams {
    withdrawalId: string;
    adminId: string;
}
export declare class LedgerService {
    private readonly fees;
    private readonly payments;
    private readonly settlement;
    constructor(fees?: FeeService, payments?: MockPaymentProvider, settlement?: SettlementProvider);
    /**
     * Inserts one immutable ledger_entries row and updates both sides of the
     * `balances` read model — all within the caller's open transaction.
     *
     * debitField / creditField control which balance column is modified.
     * Default is 'available' for both sides.
     */
    private postEntry;
    private assertSufficientAvailable;
    private systemAccounts;
    private getCurrencyCode;
    /**
     * Simulated card top-up flow:
     * 1. MockPaymentProvider.charge() — always succeeds
     * 2. Insert topup_transactions (pending → completed)
     * 3. postEntry: FLOAT → user_account  (gross) [type=topup]
     *    FLOAT represents LumixPay's on-chain reserve; each top-up draws from it.
     * 4. postEntry: user_account → fee_collector (fee) [type=fee]
     * Balance net: user.available += net; FLOAT.available -= gross
     */
    topUp(params: TopUpParams): Promise<TopUpResult>;
    /**
     * Internal P2P transfer:
     * Entry 1: from → to           (net)  [type=transfer]
     * Entry 2: from → fee_collector (fee)  [type=fee]
     * Balance: from.available -= gross; to.available += net
     */
    transfer(params: TransferParams): Promise<TransferResult>;
    /**
     * Moves funds from available into "locked" state pending admin approval.
     *
     * Entry 1: user_account → withdrawal_escrow  (net)  [type=withdrawal_lock]
     * Entry 2: user_account → fee_collector       (fee)  [type=fee]
     * Balance: user.available -= gross; user.locked += net
     *
     * Fee is collected at lock time and is NOT refunded on rejection.
     */
    requestWithdrawal(params: WithdrawalParams): Promise<WithdrawalRequest>;
    /**
     * Admin approves or rejects a pending withdrawal.
     *
     * ┌─ PHASE 1 behaviour ────────────────────────────────────────────────────┐
     * │                                                                         │
     * │  approve → status = 'approved'                                          │
     * │            NO ledger entry. NO balance movement.                        │
     * │            Funds remain: escrow holds net, user.locked holds net.       │
     * │            The approved row is the settlement instruction for Phase 2.  │
     * │                                                                         │
     * │  reject  → withdrawal_escrow → user_account (net) [withdrawal_unlock]  │
     * │            user.locked -= net; user.available += net                    │
     * │            Fee is NOT refunded.                                         │
     * │                                                                         │
     * └─ PHASE 2 (on-chain confirmed) ─────────────────────────────────────────┘
     *    settleWithdrawal() will post: escrow → FLOAT [withdrawal_settle]
     *    and reduce user.locked -= net after TX is confirmed on-chain.
     */
    reviewWithdrawal(params: ReviewWithdrawalParams): Promise<WithdrawalRequest>;
    getBalance(accountId: string): Promise<{
        available: string;
        locked: string;
    }>;
    getAccountsWithBalances(userId: string): Promise<AccountWithBalance[]>;
    getLedgerHistory(accountId: string, limit?: number, offset?: number): Promise<LedgerEntry[]>;
    /**
     * Executes the settlement of an already-approved withdrawal request.
     *
     * This is the Phase 2 injection point described in reviewWithdrawal().
     * The flow is deliberately separated from approval so that:
     *   - Approval = admin authorisation intent (status: approved)
     *   - Settlement = actual execution (status: settled)
     *
     * Ledger entries posted:
     *   withdrawal_escrow → FLOAT  (net_amount)  [entry_type=withdrawal_settle]
     *
     * ── ACCOUNTING NOTE ──────────────────────────────────────────────────────────
     * Debit  withdrawal_escrow.available -= net  (escrowed funds released)
     * Credit FLOAT.available             += net  (reserve credited — mirrors on-chain debit)
     *
     * Separately, user.locked -= net (obligation cleared — funds are gone on-chain).
     *
     * Net effect on FLOAT balance after a full topup→withdraw→settle cycle:
     *   topup:    FLOAT.available -= gross  (reserve paid user)
     *   settle:   FLOAT.available += net    (reserve credited from escrow)
     *   delta:    FLOAT.available -= fee    (platform kept the fee)
     *
     * This means FLOAT tracks total stablecoin custody minus fee revenue.
     * In Phase 2 this must be reconciled against the actual XRPL hot wallet balance
     * using TreasuryService.syncFromChain() (to be implemented).
     * ─────────────────────────────────────────────────────────────────────────────
     *
     * Idempotency:
     *   - If status='settled' on entry, the existing row is returned immediately.
     *   - If xrpl_submitted_at is set but xrpl_confirmed_at is null, a concurrent
     *     settlement is likely in-flight — return 409 SETTLEMENT_IN_FLIGHT.
     *   - The DB transaction uses SELECT FOR UPDATE to prevent a race between two
     *     concurrent admin /settle calls arriving simultaneously.
     */
    settleWithdrawal(params: SettleWithdrawalParams): Promise<WithdrawalRequest>;
    /**
     * Fire-and-forget: fetch updated balances for the user and publish via SSE.
     * Also publishes the ledger entry summary as `activity.new` if provided.
     */
    private publishBalancesAndActivity;
}
export declare const ledgerService: LedgerService;
//# sourceMappingURL=LedgerService.d.ts.map