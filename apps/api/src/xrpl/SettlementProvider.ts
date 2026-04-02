// ─────────────────────────────────────────────────────────────────────────────
// SettlementProvider — public contract for all settlement backends.
//
// Phase 1:  MockSettlementProvider (always confirms, no network calls)
// Phase 2:  XrplSettlementService (real XRPL payment, awaits ledger validation)
//
// Nothing outside the xrpl/ module should import XRPL-specific types directly.
// All callers (LedgerService) depend only on this interface.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All the information a settlement provider needs to execute an outbound payment.
 * Populated from the withdrawal_requests row — the provider does not query the DB.
 */
export interface SettlementRequest {
  /** LumixPay withdrawal ID (UUID). Used as idempotency anchor with the provider. */
  withdrawalId: string;

  /** User's external receiving address (XRPL classic address, r... format). */
  destinationAddress: string;

  /** Optional XRPL destination tag for exchange wallets. */
  destinationTag: number | null | undefined;

  /** Net amount to send, as a decimal string to 6 decimal places (e.g. "49.500000"). */
  amountDecimal: string;

  /** ISO currency code: 'RLUSD' | 'EURQ'. Needed for XRPL issued-currency payments. */
  assetCode: string;

  /**
   * XRPL issuer account address for the stablecoin.
   * Required for XRPL issued-currency payment paths in Phase 2.
   */
  assetIssuerAddress: string;
}

/** Terminal state of a single settlement attempt. */
export type SettlementStatus = "confirmed" | "failed" | "timeout";

/** Result returned by the provider after attempting settlement. */
export interface SettlementResult {
  /** Final state of the settlement attempt. */
  status: SettlementStatus;

  /**
   * Provider-specific transaction identifier.
   * For mock: 'mock_<uuid>'.
   * For XRPL: the validated ledger tx hash (64-char hex).
   */
  txHash: string;

  /** Wall-clock time the provider considered the settlement complete. */
  confirmedAt: Date;

  /**
   * Network fee consumed by the settlement transaction (in XRP, not stablecoins).
   * Null for mock provider. Populated by XRPL provider from actual tx fee field.
   *
   * ── ACCOUNTING NOTE ────────────────────────────────────────────────────────
   * This XRP fee is paid from the hot wallet's XRP reserve, not from the
   * stablecoin balance. It is recorded in xrpl_network_fee_xrp on the
   * withdrawal_requests row for treasury monitoring purposes but does NOT
   * affect the ledger stablecoin entries. A separate reconciliation process
   * (Phase 2+) will track XRP fee burn over time.
   * ────────────────────────────────────────────────────────────────────────────
   */
  networkFeeCostXrp: string | null;
}

/**
 * All settlement backends must implement this interface.
 * The contract: given a SettlementRequest, attempt to deliver funds and
 * return a SettlementResult. Never throw — surface errors via status='failed'.
 */
export interface SettlementProvider {
  settle(request: SettlementRequest): Promise<SettlementResult>;
}
