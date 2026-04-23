import { PoolClient } from "pg";
import { v4 as uuidv4 } from "uuid";
import Decimal from "decimal.js";
import { pool, withTransaction } from "../db/pool";
import {
  LedgerEntry,
  TopupTransaction,
  Transfer,
  WithdrawalRequest,
  AccountWithBalance,
  EntryType,
} from "../db/types";
import { FeeService, feeService } from "./FeeService";
import {
  MockPaymentProvider,
  mockPaymentProvider,
  AllowedTopupAmount,
} from "./MockPaymentProvider";
import { notificationService } from "./NotificationService";
import { treasuryService } from "./TreasuryService";
import { streamService } from "./StreamService";
import { config } from "../config";
import {
  SettlementProvider,
  settlementProvider as defaultSettlementProvider,
} from "../xrpl";

// ─────────────────────────────────────────────────────────────────────────────
// Parameter types
// ─────────────────────────────────────────────────────────────────────────────

export interface TopUpParams {
  userId: string;
  accountId: string; // user's 'main' account for the asset
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
  idempotencyOverride?: string; // used by recurring service for deterministic idempotency
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

// ─────────────────────────────────────────────────────────────────────────────
// LedgerService
// ─────────────────────────────────────────────────────────────────────────────

export class LedgerService {
  constructor(
    private readonly fees: FeeService = feeService,
    private readonly payments: MockPaymentProvider = mockPaymentProvider,
    // ── XRPL INTEGRATION POINT ──────────────────────────────────────────────
    // Phase 2: pass XrplSettlementService here (or set SETTLEMENT_PROVIDER=xrpl).
    // Default uses MockSettlementProvider which always confirms without network calls.
    // ────────────────────────────────────────────────────────────────────────
    private readonly settlement: SettlementProvider = defaultSettlementProvider
  ) {}

  // ── Private: core double-entry posting ─────────────────────────────────────

  /**
   * Inserts one immutable ledger_entries row and updates both sides of the
   * `balances` read model — all within the caller's open transaction.
   *
   * debitField / creditField control which balance column is modified.
   * Default is 'available' for both sides.
   */
  private async postEntry(
    client: PoolClient,
    params: {
      idempotencyKey: string;
      debitAccountId: string;
      creditAccountId: string;
      assetId: string;
      amount: Decimal;
      entryType: EntryType;
      referenceId: string;
      referenceType: string;
      metadata?: Record<string, unknown>;
      debitField?: "available" | "locked";
      creditField?: "available" | "locked";
    }
  ): Promise<LedgerEntry> {
    const {
      idempotencyKey,
      debitAccountId,
      creditAccountId,
      assetId,
      amount,
      entryType,
      referenceId,
      referenceType,
      metadata,
      debitField = "available",
      creditField = "available",
    } = params;

    // Runtime invariants: never write invalid/degenerate journal lines.
    if (debitAccountId === creditAccountId) {
      throw new Error("Ledger invariant failed: debit account equals credit account");
    }
    if (amount.lte(0)) {
      throw new Error("Ledger invariant failed: amount must be > 0");
    }

    // 1. Write the immutable journal row
    const { rows } = await client.query<LedgerEntry>(
      `INSERT INTO ledger_entries
         (idempotency_key, debit_account_id, credit_account_id, asset_id,
          amount, entry_type, reference_id, reference_type, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        idempotencyKey,
        debitAccountId,
        creditAccountId,
        assetId,
        amount.toFixed(6),
        entryType,
        referenceId,
        referenceType,
        metadata ? JSON.stringify(metadata) : null,
      ]
    );
    const entry = rows[0]!;

    // 2. Apply debit: reduce debitField on debit account
    const debitRes = await client.query(
      `UPDATE balances
          SET ${debitField} = ${debitField} - $1, updated_at = NOW()
        WHERE account_id = $2`,
      [amount.toFixed(6), debitAccountId]
    );
    if (debitRes.rowCount !== 1) {
      throw new Error(`Ledger invariant failed: missing debit balance row for ${debitAccountId}`);
    }

    // 3. Apply credit: increase creditField on credit account
    const creditRes = await client.query(
      `UPDATE balances
          SET ${creditField} = ${creditField} + $1, updated_at = NOW()
        WHERE account_id = $2`,
      [amount.toFixed(6), creditAccountId]
    );
    if (creditRes.rowCount !== 1) {
      throw new Error(`Ledger invariant failed: missing credit balance row for ${creditAccountId}`);
    }

    return entry;
  }

  // ── Private: balance sufficiency guard ─────────────────────────────────────

  private async assertSufficientAvailable(
    client: PoolClient,
    accountId: string,
    required: Decimal
  ): Promise<void> {
    const { rows } = await client.query<{ available: string }>(
      "SELECT available FROM balances WHERE account_id = $1 FOR UPDATE",
      [accountId]
    );
    if (!rows[0]) throw new Error(`Balance row not found for account ${accountId}`);
    const available = new Decimal(rows[0].available);
    if (available.lt(required)) {
      throw new Error(
        `Insufficient balance. Available: ${available.toFixed(6)}, Required: ${required.toFixed(6)}`
      );
    }
  }

  // ── Private: system account lookup ─────────────────────────────────────────

  private systemAccounts(assetId: string) {
    const { rlusd, eurq } = config.system.accounts;
    if (assetId === rlusd.assetId) return rlusd;
    if (assetId === eurq.assetId) return eurq;
    throw new Error(`No system accounts configured for asset ${assetId}`);
  }

  // ── Private: currency code from assetId ─────────────────────────────────────

  private getCurrencyCode(assetId: string): string {
    const { rlusd, eurq } = config.system.accounts;
    if (assetId === rlusd.assetId) return "RLUSD";
    if (assetId === eurq.assetId) return "EURQ";
    return assetId;
  }

  // ── Public: topUp ───────────────────────────────────────────────────────────

  /**
   * Simulated card top-up flow:
   * 1. MockPaymentProvider.charge() — always succeeds
   * 2. Insert topup_transactions (pending → completed)
   * 3. postEntry: FLOAT → user_account  (gross) [type=topup]
   *    FLOAT represents LumixPay's on-chain reserve; each top-up draws from it.
   * 4. postEntry: user_account → fee_collector (fee) [type=fee]
   * Balance net: user.available += net; FLOAT.available -= gross
   */
  async topUp(params: TopUpParams): Promise<TopUpResult> {
    const { userId, accountId, assetId, grossAmount, simulatedCardLast4 } = params;
    const gross = new Decimal(grossAmount);
    const { fee, net } = this.fees.compute(gross);
    const sys = this.systemAccounts(assetId);
    const topupId = uuidv4();

    const idempotencyBase = `topup:${topupId}`;

    // Charge card before opening the DB transaction
    const charge = await this.payments.charge({
      amount: gross,
      currency: assetId,
      cardLast4: simulatedCardLast4,
      idempotencyKey: idempotencyBase,
    });

    const result = await withTransaction(async (client) => {
      // ── Treasury gate: blocks issuance when supply cap is reached ─────────────
      await treasuryService.ensureCanIssue(client, assetId, gross);

      // Insert topup record (pending)
      const { rows: topupRows } = await client.query<TopupTransaction>(
        `INSERT INTO topup_transactions
           (id, user_id, account_id, asset_id, gross_amount, fee_amount, net_amount,
            provider, provider_reference, simulated_card_last4, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'mock',$8,$9,'pending')
         RETURNING *`,
        [
          topupId,
          userId,
          accountId,
          assetId,
          gross.toFixed(6),
          fee.toFixed(6),
          net.toFixed(6),
          charge.providerReference,
          simulatedCardLast4,
        ]
      );
      const topup = topupRows[0]!;

      // Entry 1: FLOAT → user_account (gross drawn from on-chain reserve)
      const entryTopup = await this.postEntry(client, {
        idempotencyKey: `${idempotencyBase}:topup`,
        debitAccountId: sys.float,
        creditAccountId: accountId,
        assetId,
        amount: gross,
        entryType: "topup",
        referenceId: topupId,
        referenceType: "topup_transactions",
        metadata: { card_last4: simulatedCardLast4, provider_ref: charge.providerReference },
      });

      // Entry 2: user_account → fee_collector (fee)
      const entryFee = await this.postEntry(client, {
        idempotencyKey: `${idempotencyBase}:fee`,
        debitAccountId: accountId,
        creditAccountId: sys.feeCollector,
        assetId,
        amount: fee,
        entryType: "fee",
        referenceId: topupId,
        referenceType: "topup_transactions",
      });

      // ── Treasury: consume inventory (decrease available supply) ──────────────
      await treasuryService.consume(client, assetId, gross);

      // Mark topup completed
      const { rows: completedRows } = await client.query<TopupTransaction>(
        `UPDATE topup_transactions
            SET status = 'completed', updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [topupId]
      );

      return {
        topupTransaction: completedRows[0]!,
        entries: [entryTopup, entryFee],
      };
    });

    void notificationService
      .create({
        userId,
        type: "topup.completed",
        title: "Top-up completed",
        body: `Your account was credited ${result.topupTransaction.net_amount} ${this.getCurrencyCode(assetId)}`,
        metadata: { topup_id: result.topupTransaction.id, amount: result.topupTransaction.net_amount },
      })
      .catch((e) => console.error("notification error (topup):", e));

    // SSE: push balances + activity to user's stream
    void this.publishBalancesAndActivity(userId, accountId, result.entries[0] ?? null);

    return result;
  }

  // ── Public: transfer ────────────────────────────────────────────────────────

  /**
   * Internal P2P transfer:
   * Entry 1: from → to           (net)  [type=transfer]
   * Entry 2: from → fee_collector (fee)  [type=fee]
   * Balance: from.available -= gross; to.available += net
   */
  async transfer(params: TransferParams): Promise<TransferResult> {
    const { fromAccountId, toAccountId, assetId, idempotencyOverride } = params;
    const gross = new Decimal(params.grossAmount);
    const { fee, net } = this.fees.compute(gross);
    const sys = this.systemAccounts(assetId);
    const transferId = uuidv4();
    const idempotencyBase = idempotencyOverride ?? `transfer:${transferId}`;

    if (fromAccountId === toAccountId) {
      throw new Error("Cannot transfer to the same account");
    }

    const result = await withTransaction(async (client) => {
      await this.assertSufficientAvailable(client, fromAccountId, gross);

      const { rows: transferRows } = await client.query<Transfer>(
        `INSERT INTO transfers
           (id, from_account_id, to_account_id, asset_id,
            gross_amount, fee_amount, net_amount, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'completed')
         RETURNING *`,
        [
          transferId,
          fromAccountId,
          toAccountId,
          assetId,
          gross.toFixed(6),
          fee.toFixed(6),
          net.toFixed(6),
        ]
      );

      const entryTransfer = await this.postEntry(client, {
        idempotencyKey: `${idempotencyBase}:transfer`,
        debitAccountId: fromAccountId,
        creditAccountId: toAccountId,
        assetId,
        amount: net,
        entryType: "transfer",
        referenceId: transferId,
        referenceType: "transfers",
      });

      const entryFee = await this.postEntry(client, {
        idempotencyKey: `${idempotencyBase}:fee`,
        debitAccountId: fromAccountId,
        creditAccountId: sys.feeCollector,
        assetId,
        amount: fee,
        entryType: "fee",
        referenceId: transferId,
        referenceType: "transfers",
      });

      return {
        transfer: transferRows[0]!,
        entries: [entryTransfer, entryFee],
      };
    });

    void (async () => {
      try {
        const currency  = this.getCurrencyCode(assetId);
        const netAmount = result.transfer.net_amount;
        const meta = { transfer_id: result.transfer.id, amount: result.transfer.gross_amount, currency };

        // Resolve account → user_id for both sides
        const [senderRes, recipRes] = await Promise.all([
          pool.query<{ user_id: string }>("SELECT user_id FROM accounts WHERE id = $1", [fromAccountId]),
          pool.query<{ user_id: string }>("SELECT user_id FROM accounts WHERE id = $1", [toAccountId]),
        ]);
        const senderUserId    = senderRes.rows[0]?.user_id;
        const recipientUserId = recipRes.rows[0]?.user_id;

        // Fetch display identities in one batch query (username preferred, UUID fallback)
        const idsToFetch = [senderUserId, recipientUserId].filter((id): id is string => !!id);
        const usernameMap = new Map<string, string | null>();
        if (idsToFetch.length > 0) {
          const { rows: userRows } = await pool.query<{ id: string; username: string | null }>(
            "SELECT id, username FROM users WHERE id = ANY($1::uuid[])",
            [idsToFetch],
          );
          for (const u of userRows) usernameMap.set(u.id, u.username);
        }

        const formatIdentity = (userId: string) => {
          const username = usernameMap.get(userId);
          return username ? `@${username}` : userId;
        };

        if (senderUserId) {
          const recipientDisplay = recipientUserId ? formatIdentity(recipientUserId) : "unknown";
          await notificationService.create({
            userId: senderUserId,
            type: "transfer.sent",
            title: "Transfer sent",
            body: `You sent ${netAmount} ${currency} to ${recipientDisplay}`,
            metadata: meta,
          });
          void this.publishBalancesAndActivity(senderUserId, fromAccountId, result.entries[0] ?? null);
        }
        if (recipientUserId && recipientUserId !== senderUserId) {
          const senderDisplay = senderUserId ? formatIdentity(senderUserId) : "unknown";
          await notificationService.create({
            userId: recipientUserId,
            type: "transfer.received",
            title: "Transfer received",
            body: `You received ${netAmount} ${currency} from ${senderDisplay}`,
            metadata: meta,
          });
          void this.publishBalancesAndActivity(recipientUserId, toAccountId, result.entries[0] ?? null);
        }
      } catch (e) {
        console.error("notification error (transfer):", e);
      }
    })();

    return result;
  }

  // ── Public: requestWithdrawal ────────────────────────────────────────────────

  /**
   * Moves funds from available into "locked" state pending admin approval.
   *
   * Entry 1: user_account → withdrawal_escrow  (net)  [type=withdrawal_lock]
   * Entry 2: user_account → fee_collector       (fee)  [type=fee]
   * Balance: user.available -= gross; user.locked += net
   *
   * Fee is collected at lock time and is NOT refunded on rejection.
   */
  async requestWithdrawal(params: WithdrawalParams): Promise<WithdrawalRequest> {
    const { userId, accountId, assetId, xrplDestinationAddress, xrplDestinationTag } =
      params;
    const gross = new Decimal(params.grossAmount);
    const { fee, net } = this.fees.compute(gross);
    const sys = this.systemAccounts(assetId);
    const withdrawalId = uuidv4();
    const idempotencyBase = `withdrawal:${withdrawalId}`;

    const result = await withTransaction(async (client) => {
      await this.assertSufficientAvailable(client, accountId, gross);

      const { rows: wRows } = await client.query<WithdrawalRequest>(
        `INSERT INTO withdrawal_requests
           (id, user_id, account_id, asset_id, gross_amount, fee_amount, net_amount,
            xrpl_destination_address, xrpl_destination_tag, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
         RETURNING *`,
        [
          withdrawalId,
          userId,
          accountId,
          assetId,
          gross.toFixed(6),
          fee.toFixed(6),
          net.toFixed(6),
          xrplDestinationAddress,
          xrplDestinationTag ?? null,
        ]
      );

      // Entry 1: lock net amount into escrow
      // debitField='available' (reduces available), creditField='available' on escrow
      await this.postEntry(client, {
        idempotencyKey: `${idempotencyBase}:lock`,
        debitAccountId: accountId,
        creditAccountId: sys.withdrawalEscrow,
        assetId,
        amount: net,
        entryType: "withdrawal_lock",
        referenceId: withdrawalId,
        referenceType: "withdrawal_requests",
        metadata: { xrpl_destination: xrplDestinationAddress },
      });

      // Entry 2: collect fee
      await this.postEntry(client, {
        idempotencyKey: `${idempotencyBase}:fee`,
        debitAccountId: accountId,
        creditAccountId: sys.feeCollector,
        assetId,
        amount: fee,
        entryType: "fee",
        referenceId: withdrawalId,
        referenceType: "withdrawal_requests",
      });

      // Explicitly move net from available → locked on the user's balance row
      // (postEntry already reduced available by net via debit; now add to locked)
      await client.query(
        `UPDATE balances SET locked = locked + $1, updated_at = NOW() WHERE account_id = $2`,
        [net.toFixed(6), accountId]
      );

      return wRows[0]!;
    });

    void notificationService
      .create({
        userId,
        type: "withdrawal.requested",
        title: "Withdrawal submitted",
        body: `Withdrawal of ${result.net_amount} ${this.getCurrencyCode(assetId)} is pending admin review`,
        metadata: { withdrawal_id: result.id, amount: result.net_amount },
      })
      .catch((e) => console.error("notification error (withdrawal.request):", e));

    // SSE: update balances (funds are now locked)
    void this.publishBalancesAndActivity(userId, accountId, null);
    // SSE: notify all admins of a new pending withdrawal
    void streamService.publishAdmin("admin.withdrawals.updated", { userId });

    return result;
  }

  // ── Public: reviewWithdrawal ─────────────────────────────────────────────────

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
  async reviewWithdrawal(params: ReviewWithdrawalParams): Promise<WithdrawalRequest> {
    const { withdrawalId, adminId, decision, note } = params;

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query<WithdrawalRequest>(
        "SELECT * FROM withdrawal_requests WHERE id = $1 FOR UPDATE",
        [withdrawalId]
      );
      const wr = rows[0];
      if (!wr) throw new Error(`Withdrawal request ${withdrawalId} not found`);
      if (wr.status !== "pending") {
        throw new Error(`Cannot review withdrawal in status '${wr.status}'`);
      }

      // Status-only update for both decisions.
      // approve: purely an authorization signal — no ledger or balance change.
      // reject:  ledger + balance movements follow below.
      const { rows: updated } = await client.query<WithdrawalRequest>(
        `UPDATE withdrawal_requests
            SET status     = $1,
                reviewed_by = $2,
                reviewed_at = NOW(),
                admin_note  = $3,
                updated_at  = NOW()
          WHERE id = $4
          RETURNING *`,
        [decision === "approve" ? "approved" : "rejected", adminId, note ?? null, withdrawalId]
      );

      if (decision === "reject") {
        const net = new Decimal(wr.net_amount);
        const sys = this.systemAccounts(wr.asset_id);

        // Unwind the lock: escrow → user (net). Fee stays with fee_collector.
        await this.postEntry(client, {
          idempotencyKey: `withdrawal_unlock:${withdrawalId}`,
          debitAccountId: sys.withdrawalEscrow,
          creditAccountId: wr.account_id,
          assetId: wr.asset_id,
          amount: net,
          entryType: "withdrawal_unlock",
          referenceId: withdrawalId,
          referenceType: "withdrawal_requests",
        });

        // Mirror in the read model: locked → available.
        await client.query(
          `UPDATE balances
              SET locked     = locked    - $1,
                  available  = available + $1,
                  updated_at = NOW()
            WHERE account_id = $2`,
          [net.toFixed(6), wr.account_id]
        );
      }

      // Phase 2 note: for approved withdrawals, call settleWithdrawal() after
      // the on-chain TX is confirmed. That method will post escrow → FLOAT
      // [withdrawal_settle] and decrement user.locked.

      return updated[0]!;
    });

    void (async () => {
      try {
        const currency = this.getCurrencyCode(result.asset_id);
        const type  = decision === "approve" ? "withdrawal.approved" : "withdrawal.rejected";
        const title = decision === "approve" ? "Withdrawal approved" : "Withdrawal rejected";
        const body  = decision === "approve"
          ? `Your withdrawal of ${result.net_amount} ${currency} was approved and will settle shortly`
          : `Your withdrawal of ${result.net_amount} ${currency} was rejected. Net funds have been returned.`;
        await notificationService.create({
          userId: result.user_id,
          type,
          title,
          body,
          metadata: { withdrawal_id: result.id, amount: result.net_amount, currency },
        });
      } catch (e) {
        console.error("notification error (withdrawal.review):", e);
      }
    })();

    return result;
  }

  // ── Public: getBalance ───────────────────────────────────────────────────────

  async getBalance(accountId: string): Promise<{ available: string; locked: string }> {
    const { rows } = await pool.query<{ available: string; locked: string }>(
      "SELECT available, locked FROM balances WHERE account_id = $1",
      [accountId]
    );
    if (!rows[0]) throw new Error(`No balance found for account ${accountId}`);
    return rows[0];
  }

  // ── Public: getAccountsWithBalances ─────────────────────────────────────────

  async getAccountsWithBalances(userId: string): Promise<AccountWithBalance[]> {
    const { rows } = await pool.query<AccountWithBalance>(
      `SELECT
         a.id, a.user_id, a.asset_id, a.label, a.created_at,
         json_build_object(
           'currency_code',  ast.currency_code,
           'display_name',   ast.display_name,
           'display_symbol', ast.display_symbol
         ) AS asset,
         json_build_object(
           'available', b.available,
           'locked',    b.locked
         ) AS balance
       FROM accounts a
       JOIN assets   ast ON ast.id = a.asset_id
       JOIN balances b   ON b.account_id = a.id
       WHERE a.user_id = $1
         AND a.label = 'main'
       ORDER BY ast.currency_code`,
      [userId]
    );
    return rows;
  }

  // ── Public: getLedgerHistory ─────────────────────────────────────────────────

  async getLedgerHistory(
    accountId: string,
    limit = 50,
    offset = 0
  ): Promise<LedgerEntry[]> {
    const { rows } = await pool.query<LedgerEntry>(
      `SELECT * FROM ledger_entries
        WHERE debit_account_id = $1 OR credit_account_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [accountId, limit, offset]
    );
    return rows;
  }

  // ── Public: settleWithdrawal ─────────────────────────────────────────────────

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
  async settleWithdrawal(params: SettleWithdrawalParams): Promise<WithdrawalRequest> {
    const { withdrawalId } = params;

    // ── 1. Pre-flight status check (outside transaction — fast path) ──────────
    const { rows: preRows } = await pool.query<WithdrawalRequest>(
      "SELECT * FROM withdrawal_requests WHERE id = $1",
      [withdrawalId]
    );
    const pre = preRows[0];
    if (!pre) {
      throw Object.assign(new Error(`Withdrawal request ${withdrawalId} not found`), { status: 404 });
    }

    // Already fully settled — idempotent return
    if (pre.status === "settled") {
      return pre;
    }

    // Only approved withdrawals can be settled
    if (pre.status !== "approved") {
      throw Object.assign(
        new Error(
          `Cannot settle withdrawal in status '${pre.status}'. ` +
          `Withdrawal must be in 'approved' status.`
        ),
        { status: 409, code: "INVALID_STATUS_FOR_SETTLEMENT" }
      );
    }

    // Guard against a settlement that is already submitted but not yet confirmed
    // (e.g. provider is slow, or the process crashed between submit and confirm).
    if (pre.xrpl_submitted_at !== null && pre.xrpl_confirmed_at === null) {
      throw Object.assign(
        new Error(
          "Settlement already submitted and awaiting provider confirmation. " +
          "Do not retry until the current attempt has resolved."
        ),
        { status: 409, code: "SETTLEMENT_IN_FLIGHT" }
      );
    }

    // ── 2. Mark as submitted BEFORE calling the provider ─────────────────────
    // Writing xrpl_submitted_at first is a deliberate two-phase write:
    // If the process crashes after provider.settle() returns but before the DB
    // COMMIT, the SETTLEMENT_IN_FLIGHT guard above prevents blind re-submission.
    // The admin can then inspect the withdrawal row and decide whether to check
    // the provider directly or reset the submitted_at to retry.
    //
    // ── XRPL INTEGRATION POINT ───────────────────────────────────────────────
    // In Phase 2, before re-submitting, XrplClient.getTxStatus(xrpl_tx_hash)
    // should be checked first. If the TX is already validated on-chain, call
    // settleWithdrawal() with the existing txHash rather than submitting again.
    // ─────────────────────────────────────────────────────────────────────────
    const providerName = process.env["SETTLEMENT_PROVIDER"] ?? "mock";
    await pool.query(
      `UPDATE withdrawal_requests
          SET settlement_provider = $1,
              xrpl_submitted_at   = NOW(),
              updated_at          = NOW()
        WHERE id = $2 AND status = 'approved' AND xrpl_submitted_at IS NULL`,
      [providerName, withdrawalId]
    );

    // ── 3. Fetch issuer address for the asset (needed by XRPL provider) ───────
    const { rows: assetRows } = await pool.query<{ issuer_address: string }>(
      "SELECT issuer_address FROM assets WHERE id = $1",
      [pre.asset_id]
    );
    const issuerAddress = assetRows[0]?.issuer_address ?? "";

    const net      = new Decimal(pre.net_amount);
    const currency = this.getCurrencyCode(pre.asset_id);
    const sys      = this.systemAccounts(pre.asset_id);

    // ── 4. Call the settlement provider ──────────────────────────────────────
    // Provider is responsible for delivering funds to the user's destination.
    // It must NOT throw — errors are surfaced via result.status='failed'|'timeout'.
    //
    // ── XRPL INTEGRATION POINT ───────────────────────────────────────────────
    // Phase 2: XrplSettlementService.settle() will:
    //   - Build and sign an XRPL issued-currency Payment TX
    //   - Submit to the network
    //   - Poll until the TX appears in a validated ledger (or timeout)
    //   - Return the tx_hash and actual XRP fee consumed
    // ─────────────────────────────────────────────────────────────────────────
    const settlementResult = await this.settlement.settle({
      withdrawalId,
      destinationAddress:  pre.xrpl_destination_address,
      destinationTag:      pre.xrpl_destination_tag,
      amountDecimal:       net.toFixed(6),
      assetCode:           currency,
      assetIssuerAddress:  issuerAddress,
    });

    // ── 5. Persist the result inside a serialised DB transaction ─────────────
    const settled = await withTransaction(async (client) => {
      // Re-fetch with row lock to prevent concurrent settlement writes
      const { rows: locked } = await client.query<WithdrawalRequest>(
        "SELECT * FROM withdrawal_requests WHERE id = $1 FOR UPDATE",
        [withdrawalId]
      );
      const wr = locked[0]!;

      // Concurrent call already settled — idempotent return
      if (wr.status === "settled") {
        return wr;
      }

      if (settlementResult.status !== "confirmed") {
        // Provider failed or timed out — reset xrpl_submitted_at so the admin
        // can safely retry after investigating the failure.
        await client.query(
          `UPDATE withdrawal_requests
              SET xrpl_submitted_at   = NULL,
                  settlement_provider = NULL,
                  updated_at          = NOW()
            WHERE id = $1`,
          [withdrawalId]
        );
        throw Object.assign(
          new Error(
            `Settlement provider returned status '${settlementResult.status}' ` +
            `(txHash: ${settlementResult.txHash}). xrpl_submitted_at has been reset — safe to retry.`
          ),
          { status: 502, code: "SETTLEMENT_PROVIDER_FAILED", txHash: settlementResult.txHash }
        );
      }

      // ── Ledger entry: withdrawal_escrow → FLOAT [withdrawal_settle] ──────
      // ── ACCOUNTING NOTE ──────────────────────────────────────────────────
      // Debit  withdrawalEscrow.available -= net  (escrow releases the funds)
      // Credit float.available            += net  (reserve re-credited)
      //
      // user.locked is decremented explicitly below (separate balance row update).
      // postEntry uses debitField='available' and creditField='available' (defaults).
      // ─────────────────────────────────────────────────────────────────────
      await this.postEntry(client, {
        idempotencyKey:   `withdrawal_settle:${withdrawalId}`,
        debitAccountId:   sys.withdrawalEscrow,
        creditAccountId:  sys.float,
        assetId:          wr.asset_id,
        amount:           net,
        entryType:        "withdrawal_settle",
        referenceId:      withdrawalId,
        referenceType:    "withdrawal_requests",
        metadata: {
          xrpl_tx_hash:       settlementResult.txHash,
          settlement_provider: providerName,
          xrpl_destination:   wr.xrpl_destination_address,
          xrpl_destination_tag: wr.xrpl_destination_tag ?? null,
        },
      });

      // Clear the user's locked balance — the obligation is now settled
      await client.query(
        `UPDATE balances
            SET locked     = locked - $1,
                updated_at = NOW()
          WHERE account_id = $2`,
        [net.toFixed(6), wr.account_id]
      );

      // Stamp the withdrawal row as settled
      const { rows: settledRows } = await client.query<WithdrawalRequest>(
        `UPDATE withdrawal_requests
            SET status               = 'settled',
                xrpl_tx_hash         = $1,
                xrpl_confirmed_at    = $2,
                xrpl_network_fee_xrp = $3,
                updated_at           = NOW()
          WHERE id = $4
          RETURNING *`,
        [
          settlementResult.txHash,
          settlementResult.confirmedAt.toISOString(),
          settlementResult.networkFeeCostXrp ?? null,
          withdrawalId,
        ]
      );

      return settledRows[0]!;
    });

    // ── 6. Post-commit: notifications + SSE (fire-and-forget) ─────────────────
    void notificationService
      .create({
        userId: pre.user_id,
        type: "withdrawal.settled",
        title: "Withdrawal settled",
        body:
          `Your withdrawal of ${pre.net_amount} ${currency} has been sent to ` +
          `${pre.xrpl_destination_address}. TX: ${settled.xrpl_tx_hash}`,
        metadata: {
          withdrawal_id:    withdrawalId,
          xrpl_tx_hash:     settled.xrpl_tx_hash,
          settlement_provider: providerName,
        },
      })
      .catch((e) => console.error("notification error (withdrawal.settle):", e));

    void this.publishBalancesAndActivity(pre.user_id, pre.account_id, null);
    void streamService.publishAdmin("admin.withdrawals.updated", { withdrawalId, status: "settled" });

    return settled;
  }

  // ── SSE helper ──────────────────────────────────────────────────────────────

  /**
   * Fire-and-forget: fetch updated balances for the user and publish via SSE.
   * Also publishes the ledger entry summary as `activity.new` if provided.
   */
  private async publishBalancesAndActivity(
    userId: string,
    accountId: string,
    entry: LedgerEntry | null
  ): Promise<void> {
    try {
      const { rows } = await pool.query(
        `SELECT a.id AS account_id, a.label, b.available, b.locked, ast.currency_code, ast.display_symbol
           FROM accounts a
           JOIN balances b  ON b.account_id = a.id
           JOIN assets ast  ON ast.id        = a.asset_id
          WHERE a.user_id = $1 AND a.label = 'main'`,
        [userId]
      );
      streamService.publish(userId, "balances.updated", { accounts: rows });

      if (entry) {
        streamService.publish(userId, "activity.new", {
          entry: {
            id:          entry.id,
            entry_type:  entry.entry_type,
            amount:      entry.amount,
            asset_id:    entry.asset_id,
            created_at:  entry.created_at,
            reference_type: entry.reference_type,
          },
        });
      }
    } catch {
      // SSE publish errors must never bubble up
    }
  }
}

export const ledgerService = new LedgerService();
