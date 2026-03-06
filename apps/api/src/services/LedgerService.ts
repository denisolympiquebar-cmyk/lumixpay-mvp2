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

// ─────────────────────────────────────────────────────────────────────────────
// LedgerService
// ─────────────────────────────────────────────────────────────────────────────

export class LedgerService {
  constructor(
    private readonly fees: FeeService = feeService,
    private readonly payments: MockPaymentProvider = mockPaymentProvider
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
    await client.query(
      `UPDATE balances
          SET ${debitField} = ${debitField} - $1, updated_at = NOW()
        WHERE account_id = $2`,
      [amount.toFixed(6), debitAccountId]
    );

    // 3. Apply credit: increase creditField on credit account
    await client.query(
      `UPDATE balances
          SET ${creditField} = ${creditField} + $1, updated_at = NOW()
        WHERE account_id = $2`,
      [amount.toFixed(6), creditAccountId]
    );

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
        const currency = this.getCurrencyCode(assetId);
        const meta = { transfer_id: result.transfer.id, amount: result.transfer.gross_amount, currency };
        const [senderRes, recipRes] = await Promise.all([
          pool.query<{ user_id: string }>("SELECT user_id FROM accounts WHERE id = $1", [fromAccountId]),
          pool.query<{ user_id: string }>("SELECT user_id FROM accounts WHERE id = $1", [toAccountId]),
        ]);
        const senderUserId    = senderRes.rows[0]?.user_id;
        const recipientUserId = recipRes.rows[0]?.user_id;
        if (senderUserId) {
          await notificationService.create({
            userId: senderUserId,
            type: "transfer.sent",
            title: "Transfer sent",
            body: `You sent ${result.transfer.gross_amount} ${currency} (recipient received ${result.transfer.net_amount})`,
            metadata: meta,
          });
          void this.publishBalancesAndActivity(senderUserId, fromAccountId, result.entries[0] ?? null);
        }
        if (recipientUserId && recipientUserId !== senderUserId) {
          await notificationService.create({
            userId: recipientUserId,
            type: "transfer.received",
            title: "Transfer received",
            body: `You received ${result.transfer.net_amount} ${currency}`,
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
