import { config } from "../config";
import { pool } from "../db/pool";
import { currencyToHex } from "./TrustLineService";
import type { QueueStatus } from "./XrplSettlementQueueService";
import { postJson, sleep, isXrplTransientError, withRetry, assertTestnetRpc } from "../xrpl/xrplRpc";

// ─────────────────────────────────────────────────────────────────────────────
// XrplTreasuryService — Phase 3D.2
//
// Provides read-only analytics for the XRPL Testnet treasury/issuer wallet
// and withdrawal settlement activity.
//
// ── ISOLATION GUARANTEES ────────────────────────────────────────────────────
//   - READ-ONLY: no DB writes, no seed access, no transaction signing.
//   - On-chain data read via account_info + account_lines only.
//   - Settlement stats aggregated from withdrawal_requests (read-only SELECT).
// ─────────────────────────────────────────────────────────────────────────────

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TreasuryWalletState {
  address:              string;
  accountExists:        boolean;
  /** Raw XRP balance string e.g. "123.456000". Null if account not found. */
  xrpBalance:           string | null;
  ownerCount:           number | null;
  /**
   * Tokens currently in circulation (issued by this wallet).
   *
   * XRPL issuer mechanic: when the issuer calls account_lines, each line
   * represents an obligation — i.e. another account holding the issuer's
   * tokens. The line.balance is NEGATIVE from the issuer's perspective.
   * Summing abs(line.balance) per currency gives total tokens outstanding.
   *
   * This is different from a normal account's balance view.
   */
  totalIssuedRLUSD:     string | null;
  totalIssuedEURQ:      string | null;
}

export interface SettlementStats {
  pendingWithdrawals:    number;
  approvedWithdrawals:   number;
  settledWithdrawals:    number;
  rejectedWithdrawals:   number;
  /** Rows stuck with xrpl_submitted_at set but unconfirmed (legacy bug / crash). */
  stuckWithdrawals:      number;
  totalSettledRLUSD:     string;
  totalSettledEURQ:      string;
  totalFeesRLUSD:        string;
  totalFeesEURQ:         string;
  totalNetworkFeesXRP:   string;
  lastSettlementAt:      string | null;
}

export interface RecentSettlement {
  id:                  string;
  userEmail:           string;
  currencyCode:        string;
  grossAmount:         string;
  netAmount:           string;
  feeAmount:           string;
  status:              string;
  destinationAddress:  string;
  xrplTxHash:          string | null;
  xrplConfirmedAt:     string | null;
  xrplNetworkFeeXrp:   string | null;
  explorerUrl:         string | null;
}

// ── New types for Phase 3E.2 ──────────────────────────────────────────────────

export type TreasuryHealthStatus = "healthy" | "warning" | "critical";

export interface TreasuryHealth {
  status:             TreasuryHealthStatus;
  message:            string;
  xrpBalance:         string;
  thresholdWarning:   string;
  thresholdCritical:  string;
}

export interface SettlementMetrics {
  totalSettlements:              number;
  successfulSettlements:         number;
  /**
   * Count of unique withdrawal IDs that have at least one failure recorded in
   * audit_logs (xrpl.queue.failed / xrpl.treasury_settlement_failed) and are
   * not yet settled. Excludes retries — each withdrawal counts once.
   */
  failedSettlements:             number;
  settlementSuccessRate:         string;   // "98.40" (percentage, 2 dp)
  averageConfirmationSeconds:    string | null;  // null if no confirmed settlements
  totalSettledRLUSD:             string;
  totalSettledEURQ:              string;
  totalSettlementVolume:         string;   // RLUSD + EURQ combined
  totalNetworkFeesXRP:           string;
  lastSuccessfulSettlementAt:    string | null;
  lastFailedSettlementAt:        string | null;
}

export interface QueueMetrics {
  workerEnabled:          boolean;
  queued:                 number;
  processing:             number;
  lastRunAt:              string | null;
  nextRunAt:              string | null;
  lastSuccessfulQueueRun: string | null;
  lastFailedQueueRun:     string | null;
}

export type XrplTreasuryResult =
  | {
      status:             "ok";
      network:            "xrpl_testnet";
      treasury:           TreasuryWalletState;
      health:             TreasuryHealth;
      metrics:            SettlementMetrics;
      queueMetrics:       QueueMetrics;
      settlementStats:    SettlementStats;
      recentSettlements:  RecentSettlement[];
    }
  | { status: "config_missing";           message: string }
  | { status: "xrpl_testnet_unavailable"; message: string };

// ── XRPL RPC helpers ─────────────────────────────────────────────────────────

interface AccountInfoData {
  exists:     boolean;
  balance:    string | null;   // drops
  ownerCount: number | null;
}

async function fetchAccountInfo(address: string, rpcUrl: string): Promise<AccountInfoData> {
  const body = JSON.stringify({
    method: "account_info",
    params: [{ account: address, ledger_index: "validated", strict: true }],
  });
  const { status, text } = await postJson(rpcUrl, body, 12_000);
  if (status !== 200) throw new Error(`account_info HTTP ${status}`);

  const json = JSON.parse(text) as {
    result?: {
      status?:       string;
      error?:        string;
      account_data?: { Balance?: string; OwnerCount?: number };
    };
  };

  if (json.result?.status !== "success") {
    const err = json.result?.error ?? "unknown";
    if (err === "actNotFound") return { exists: false, balance: null, ownerCount: null };
    throw new Error(`account_info error: ${err}`);
  }

  return {
    exists:     true,
    balance:    json.result?.account_data?.Balance ?? null,
    ownerCount: json.result?.account_data?.OwnerCount ?? null,
  };
}

interface TrustLine {
  account:  string;
  currency: string;
  balance:  string;
  limit:    string;
}

async function fetchAccountLines(address: string, rpcUrl: string): Promise<TrustLine[]> {
  const body = JSON.stringify({
    method: "account_lines",
    params: [{ account: address, ledger_index: "validated" }],
  });
  const { status, text } = await postJson(rpcUrl, body, 12_000);
  if (status !== 200) throw new Error(`account_lines HTTP ${status}`);

  const json = JSON.parse(text) as {
    result?: { status?: string; error?: string; lines?: TrustLine[] };
  };

  if (json.result?.status !== "success") {
    const err = json.result?.error ?? "unknown";
    if (err === "actNotFound") return [];
    throw new Error(`account_lines error: ${err}`);
  }

  return json.result?.lines ?? [];
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function querySettlementStats(): Promise<SettlementStats> {
  const { rows } = await pool.query<{
    pending:             string;
    approved:            string;
    settled:             string;
    rejected:            string;
    stuck:               string;
    settled_rlusd:       string | null;
    settled_eurq:        string | null;
    fees_rlusd:          string | null;
    fees_eurq:           string | null;
    network_fees_xrp:    string | null;
    last_settlement_at:  string | null;
  }>(`
    SELECT
      COUNT(*) FILTER (WHERE wr.status = 'pending')                                                              AS pending,
      COUNT(*) FILTER (WHERE wr.status = 'approved')                                                             AS approved,
      COUNT(*) FILTER (WHERE wr.status = 'settled')                                                              AS settled,
      COUNT(*) FILTER (WHERE wr.status = 'rejected')                                                             AS rejected,
      COUNT(*) FILTER (WHERE wr.status = 'approved'
                         AND wr.xrpl_submitted_at IS NOT NULL
                         AND wr.xrpl_confirmed_at IS NULL)                                                       AS stuck,
      SUM(wr.net_amount)          FILTER (WHERE wr.status = 'settled'
                                            AND wr.settlement_provider = 'xrpl_testnet'
                                            AND a.currency_code = 'RLUSD')::text                                 AS settled_rlusd,
      SUM(wr.net_amount)          FILTER (WHERE wr.status = 'settled'
                                            AND wr.settlement_provider = 'xrpl_testnet'
                                            AND a.currency_code = 'EURQ')::text                                  AS settled_eurq,
      SUM(wr.fee_amount)          FILTER (WHERE wr.status = 'settled'
                                            AND wr.settlement_provider = 'xrpl_testnet'
                                            AND a.currency_code = 'RLUSD')::text                                 AS fees_rlusd,
      SUM(wr.fee_amount)          FILTER (WHERE wr.status = 'settled'
                                            AND wr.settlement_provider = 'xrpl_testnet'
                                            AND a.currency_code = 'EURQ')::text                                  AS fees_eurq,
      SUM(wr.xrpl_network_fee_xrp) FILTER (WHERE wr.status = 'settled'
                                             AND wr.settlement_provider = 'xrpl_testnet')::text                  AS network_fees_xrp,
      MAX(wr.xrpl_confirmed_at)   FILTER (WHERE wr.status = 'settled'
                                            AND wr.settlement_provider = 'xrpl_testnet')::text                   AS last_settlement_at
    FROM withdrawal_requests wr
    JOIN assets a ON a.id = wr.asset_id
  `);

  const r = rows[0]!;
  return {
    pendingWithdrawals:  parseInt(r.pending  ?? "0", 10),
    approvedWithdrawals: parseInt(r.approved ?? "0", 10),
    settledWithdrawals:  parseInt(r.settled  ?? "0", 10),
    rejectedWithdrawals: parseInt(r.rejected ?? "0", 10),
    stuckWithdrawals:    parseInt(r.stuck    ?? "0", 10),
    totalSettledRLUSD:   r.settled_rlusd    != null ? parseFloat(r.settled_rlusd).toFixed(6)    : "0.000000",
    totalSettledEURQ:    r.settled_eurq     != null ? parseFloat(r.settled_eurq).toFixed(6)     : "0.000000",
    totalFeesRLUSD:      r.fees_rlusd       != null ? parseFloat(r.fees_rlusd).toFixed(6)       : "0.000000",
    totalFeesEURQ:       r.fees_eurq        != null ? parseFloat(r.fees_eurq).toFixed(6)        : "0.000000",
    totalNetworkFeesXRP: r.network_fees_xrp != null ? parseFloat(r.network_fees_xrp).toFixed(6) : "0.000000",
    lastSettlementAt:    r.last_settlement_at ?? null,
  };
}

async function queryRecentSettlements(limit: number): Promise<RecentSettlement[]> {
  const { rows } = await pool.query<{
    id:                    string;
    user_email:            string;
    currency_code:         string;
    gross_amount:          string;
    net_amount:            string;
    fee_amount:            string;
    status:                string;
    xrpl_destination_address: string;
    xrpl_tx_hash:          string | null;
    xrpl_confirmed_at:     string | null;
    xrpl_network_fee_xrp:  string | null;
  }>(
    `SELECT
       wr.id,
       u.email           AS user_email,
       a.currency_code,
       wr.gross_amount,
       wr.net_amount,
       wr.fee_amount,
       wr.status,
       wr.xrpl_destination_address,
       wr.xrpl_tx_hash,
       wr.xrpl_confirmed_at::text  AS xrpl_confirmed_at,
       wr.xrpl_network_fee_xrp
     FROM withdrawal_requests wr
     JOIN users  u ON u.id  = wr.user_id
     JOIN assets a ON a.id  = wr.asset_id
    WHERE wr.settlement_provider = 'xrpl_testnet'
    ORDER BY wr.created_at DESC
    LIMIT $1`,
    [limit]
  );

  return rows.map((r) => ({
    id:                 r.id,
    userEmail:          r.user_email,
    currencyCode:       r.currency_code,
    grossAmount:        parseFloat(r.gross_amount).toFixed(6),
    netAmount:          parseFloat(r.net_amount).toFixed(6),
    feeAmount:          parseFloat(r.fee_amount).toFixed(6),
    status:             r.status,
    destinationAddress: r.xrpl_destination_address,
    xrplTxHash:         r.xrpl_tx_hash ?? null,
    xrplConfirmedAt:    r.xrpl_confirmed_at ?? null,
    xrplNetworkFeeXrp:  r.xrpl_network_fee_xrp != null
      ? parseFloat(r.xrpl_network_fee_xrp).toFixed(6) : null,
    explorerUrl:        r.xrpl_tx_hash && !r.xrpl_tx_hash.startsWith("mock_")
      ? `https://testnet.xrpl.org/transactions/${r.xrpl_tx_hash}`
      : null,
  }));
}

// ── XrplTreasuryService ───────────────────────────────────────────────────────

// ── Health calculation ────────────────────────────────────────────────────────

const THRESHOLD_WARNING  = 50;   // XRP — below this: warning
const THRESHOLD_CRITICAL = 20;   // XRP — below this: critical

function computeHealth(treasury: TreasuryWalletState): TreasuryHealth {
  const balance = treasury.xrpBalance != null ? parseFloat(treasury.xrpBalance) : 0;

  if (!treasury.accountExists) {
    return {
      status:            "critical",
      message:           "Treasury wallet is not funded on XRPL Testnet. Settlement operations are unavailable.",
      xrpBalance:        "0.000000",
      thresholdWarning:  String(THRESHOLD_WARNING),
      thresholdCritical: String(THRESHOLD_CRITICAL),
    };
  }

  let status: TreasuryHealthStatus;
  let message: string;
  if (balance >= THRESHOLD_WARNING) {
    status  = "healthy";
    message = "Treasury XRP balance is healthy.";
  } else if (balance >= THRESHOLD_CRITICAL) {
    status  = "warning";
    message = "Treasury XRP balance is below the recommended reserve. Consider topping up.";
  } else {
    status  = "critical";
    message = "Treasury XRP balance is critically low. Settlement operations may be impacted.";
  }

  return {
    status,
    message,
    xrpBalance:        treasury.xrpBalance ?? "0.000000",
    thresholdWarning:  String(THRESHOLD_WARNING),
    thresholdCritical: String(THRESHOLD_CRITICAL),
  };
}

// ── Metrics DB queries ─────────────────────────────────────────────────────────

async function querySettlementMetrics(): Promise<SettlementMetrics> {
  // Single query: successful settlements + confirmation time
  const { rows: wr } = await pool.query<{
    successful:         string;
    avg_confirm_secs:   string | null;
    settled_rlusd:      string | null;
    settled_eurq:       string | null;
    network_fees:       string | null;
    last_success_at:    string | null;
  }>(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'settled')::text                              AS successful,
      AVG(
        EXTRACT(EPOCH FROM (xrpl_confirmed_at - xrpl_submitted_at))
      ) FILTER (WHERE status = 'settled'
                  AND xrpl_confirmed_at IS NOT NULL
                  AND xrpl_submitted_at IS NOT NULL)::text                           AS avg_confirm_secs,
      SUM(net_amount) FILTER (WHERE status = 'settled' AND a.currency_code = 'RLUSD')::text AS settled_rlusd,
      SUM(net_amount) FILTER (WHERE status = 'settled' AND a.currency_code = 'EURQ')::text  AS settled_eurq,
      SUM(xrpl_network_fee_xrp) FILTER (WHERE status = 'settled')::text             AS network_fees,
      MAX(xrpl_confirmed_at) FILTER (WHERE status = 'settled')::text                AS last_success_at
    FROM withdrawal_requests wr
    JOIN assets a ON a.id = wr.asset_id
    WHERE wr.settlement_provider = 'xrpl_testnet'
  `);

  // Count unique withdrawal IDs that have failed at least once and aren't settled
  const { rows: al } = await pool.query<{ failed_count: string; last_failed_at: string | null }>(`
    SELECT
      COUNT(DISTINCT al.entity_id)::text  AS failed_count,
      MAX(al.created_at)::text            AS last_failed_at
    FROM audit_logs al
    WHERE al.action_type IN ('xrpl.queue.failed', 'xrpl.treasury_settlement_failed')
      AND NOT EXISTS (
        SELECT 1 FROM withdrawal_requests wr
        WHERE wr.id::text = al.entity_id AND wr.status = 'settled'
      )
  `);

  const successful = parseInt(wr[0]?.successful ?? "0", 10);
  const failed     = parseInt(al[0]?.failed_count ?? "0", 10);
  const total      = successful + failed;

  const successRate =
    total > 0 ? ((successful / total) * 100).toFixed(2) : "0.00";

  const avgSecs = wr[0]?.avg_confirm_secs != null
    ? parseFloat(wr[0].avg_confirm_secs).toFixed(1)
    : null;

  const rlusd  = parseFloat(wr[0]?.settled_rlusd ?? "0");
  const eurq   = parseFloat(wr[0]?.settled_eurq  ?? "0");
  const volume = (rlusd + eurq).toFixed(6);

  return {
    totalSettlements:           total,
    successfulSettlements:      successful,
    failedSettlements:          failed,
    settlementSuccessRate:      successRate,
    averageConfirmationSeconds: avgSecs,
    totalSettledRLUSD:          rlusd.toFixed(6),
    totalSettledEURQ:           eurq.toFixed(6),
    totalSettlementVolume:      volume,
    totalNetworkFeesXRP:        parseFloat(wr[0]?.network_fees ?? "0").toFixed(6),
    lastSuccessfulSettlementAt: wr[0]?.last_success_at ?? null,
    lastFailedSettlementAt:     al[0]?.last_failed_at  ?? null,
  };
}

async function queryQueueTimestamps(): Promise<{
  lastSuccessfulQueueRun: string | null;
  lastFailedQueueRun:     string | null;
}> {
  const { rows } = await pool.query<{
    last_success: string | null;
    last_failed:  string | null;
  }>(`
    SELECT
      MAX(created_at) FILTER (WHERE action_type = 'xrpl.queue.success')::text AS last_success,
      MAX(created_at) FILTER (WHERE action_type = 'xrpl.queue.failed')::text  AS last_failed
    FROM audit_logs
    WHERE action_type IN ('xrpl.queue.success', 'xrpl.queue.failed')
  `);
  return {
    lastSuccessfulQueueRun: rows[0]?.last_success ?? null,
    lastFailedQueueRun:     rows[0]?.last_failed  ?? null,
  };
}

export class XrplTreasuryService {
  /**
   * Returns the full treasury dashboard snapshot:
   *   - On-chain wallet state from XRPL Testnet (account_info + account_lines)
   *   - Settlement stats aggregated from withdrawal_requests
   *   - Last 20 xrpl_testnet settlements
   *
   * READ-ONLY: no seeds, no signing, no DB writes.
   */
  async getDashboard(): Promise<XrplTreasuryResult> {
    const rpcUrl        = config.xrplTestnetRpcUrl;
    const issuerAddress = config.xrplTestnetIssuerAddress;

    // ── Config guard ─────────────────────────────────────────────────────────
    if (!issuerAddress || !issuerAddress.startsWith("r")) {
      return {
        status:  "config_missing",
        message: "XRPL_TESTNET_ISSUER_ADDRESS is not configured.",
      };
    }
    try {
      assertTestnetRpc(rpcUrl);
    } catch (err: any) {
      return { status: "config_missing", message: err.message };
    }

    // ── Derive currency hex codes ─────────────────────────────────────────────
    const rlusdHex = currencyToHex(config.xrplTestnetRlusdCurrency).toUpperCase();
    const eurqHex  = currencyToHex(config.xrplTestnetEurqCurrency).toUpperCase();

    // ── Fetch on-chain data (with retry) ─────────────────────────────────────
    let accountInfo: AccountInfoData;
    try {
      accountInfo = await withRetry(
        () => fetchAccountInfo(issuerAddress, rpcUrl),
        isXrplTransientError,
        3,
        2_000
      );
    } catch (err: any) {
      if (isXrplTransientError(err)) {
        return {
          status:  "xrpl_testnet_unavailable",
          message: "XRPL Testnet is temporarily unavailable. Please try again later.",
        };
      }
      return {
        status:  "xrpl_testnet_unavailable",
        message: `Failed to fetch treasury account info: ${err.message}`,
      };
    }

    // ── Build treasury wallet state ───────────────────────────────────────────
    let totalIssuedRLUSD: string | null = null;
    let totalIssuedEURQ:  string | null = null;

    if (accountInfo.exists) {
      // Fetch account_lines to compute outstanding obligations.
      //
      // For an XRPL issuer, account_lines lists trust lines opened BY other
      // accounts TO the issuer. From the issuer's perspective, each line.balance
      // is NEGATIVE (it's a liability — tokens they've issued and that are
      // held elsewhere). We sum abs(balance) per currency to get total in
      // circulation.
      try {
        const lines = await withRetry(
          () => fetchAccountLines(issuerAddress, rpcUrl),
          isXrplTransientError,
          3,
          2_000
        );

        let rlusdTotal = 0;
        let eurqTotal  = 0;
        for (const line of lines) {
          const ccy = line.currency.toUpperCase();
          // balance is negative for issuer obligations — take absolute value
          const abs = Math.abs(parseFloat(line.balance ?? "0"));
          if (ccy === rlusdHex) rlusdTotal += abs;
          if (ccy === eurqHex)  eurqTotal  += abs;
        }

        totalIssuedRLUSD = rlusdTotal.toFixed(6);
        totalIssuedEURQ  = eurqTotal.toFixed(6);
      } catch {
        // Non-fatal — dashboard still useful without obligations data
      }
    }

    const xrpBalance = accountInfo.balance != null
      ? (parseInt(accountInfo.balance, 10) / 1_000_000).toFixed(6)
      : null;

    const treasury: TreasuryWalletState = {
      address:         issuerAddress,
      accountExists:   accountInfo.exists,
      xrpBalance,
      ownerCount:      accountInfo.ownerCount,
      totalIssuedRLUSD,
      totalIssuedEURQ,
    };

    // ── Health, metrics, queue, stats, settlements — all in parallel ─────────
    const [
      settlementStats,
      recentSettlements,
      metrics,
      queueTimestamps,
    ] = await Promise.all([
      querySettlementStats(),
      queryRecentSettlements(20),
      querySettlementMetrics(),
      queryQueueTimestamps(),
    ]);

    // ── Health ────────────────────────────────────────────────────────────────
    const health = computeHealth(treasury);

    // ── Queue metrics (in-memory state + DB timestamps) ───────────────────────
    // Lazy-load the queue service to avoid circular deps at module load time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const queueSvc = require("./XrplSettlementQueueService").xrplSettlementQueueService as
      import("./XrplSettlementQueueService").XrplSettlementQueueService;

    const queueStatus  = queueSvc.getStatus();
    const queuedCount  = await queueSvc.getQueuedCount();

    const queueMetrics: QueueMetrics = {
      workerEnabled:           queueStatus.workerEnabled,
      queued:                  queuedCount,
      processing:              queueStatus.processing,
      lastRunAt:               queueStatus.lastRunAt,
      nextRunAt:               queueStatus.nextRunAt,
      lastSuccessfulQueueRun:  queueTimestamps.lastSuccessfulQueueRun,
      lastFailedQueueRun:      queueTimestamps.lastFailedQueueRun,
    };

    return {
      status:            "ok",
      network:           "xrpl_testnet",
      treasury,
      health,
      metrics,
      queueMetrics,
      settlementStats,
      recentSettlements,
    };
  }
}

export const xrplTreasuryService = new XrplTreasuryService();
