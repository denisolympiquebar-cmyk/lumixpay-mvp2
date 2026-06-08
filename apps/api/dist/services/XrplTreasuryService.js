"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.xrplTreasuryService = exports.XrplTreasuryService = void 0;
const config_1 = require("../config");
const pool_1 = require("../db/pool");
const TrustLineService_1 = require("./TrustLineService");
const xrplRpc_1 = require("../xrpl/xrplRpc");
async function fetchAccountInfo(address, rpcUrl) {
    const body = JSON.stringify({
        method: "account_info",
        params: [{ account: address, ledger_index: "validated", strict: true }],
    });
    const { status, text } = await (0, xrplRpc_1.postJson)(rpcUrl, body, 12_000);
    if (status !== 200)
        throw new Error(`account_info HTTP ${status}`);
    const json = JSON.parse(text);
    if (json.result?.status !== "success") {
        const err = json.result?.error ?? "unknown";
        if (err === "actNotFound")
            return { exists: false, balance: null, ownerCount: null };
        throw new Error(`account_info error: ${err}`);
    }
    return {
        exists: true,
        balance: json.result?.account_data?.Balance ?? null,
        ownerCount: json.result?.account_data?.OwnerCount ?? null,
    };
}
async function fetchAccountLines(address, rpcUrl) {
    const body = JSON.stringify({
        method: "account_lines",
        params: [{ account: address, ledger_index: "validated" }],
    });
    const { status, text } = await (0, xrplRpc_1.postJson)(rpcUrl, body, 12_000);
    if (status !== 200)
        throw new Error(`account_lines HTTP ${status}`);
    const json = JSON.parse(text);
    if (json.result?.status !== "success") {
        const err = json.result?.error ?? "unknown";
        if (err === "actNotFound")
            return [];
        throw new Error(`account_lines error: ${err}`);
    }
    return json.result?.lines ?? [];
}
// ── DB helpers ────────────────────────────────────────────────────────────────
async function querySettlementStats() {
    const { rows } = await pool_1.pool.query(`
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
    const r = rows[0];
    return {
        pendingWithdrawals: parseInt(r.pending ?? "0", 10),
        approvedWithdrawals: parseInt(r.approved ?? "0", 10),
        settledWithdrawals: parseInt(r.settled ?? "0", 10),
        rejectedWithdrawals: parseInt(r.rejected ?? "0", 10),
        stuckWithdrawals: parseInt(r.stuck ?? "0", 10),
        totalSettledRLUSD: r.settled_rlusd != null ? parseFloat(r.settled_rlusd).toFixed(6) : "0.000000",
        totalSettledEURQ: r.settled_eurq != null ? parseFloat(r.settled_eurq).toFixed(6) : "0.000000",
        totalFeesRLUSD: r.fees_rlusd != null ? parseFloat(r.fees_rlusd).toFixed(6) : "0.000000",
        totalFeesEURQ: r.fees_eurq != null ? parseFloat(r.fees_eurq).toFixed(6) : "0.000000",
        totalNetworkFeesXRP: r.network_fees_xrp != null ? parseFloat(r.network_fees_xrp).toFixed(6) : "0.000000",
        lastSettlementAt: r.last_settlement_at ?? null,
    };
}
async function queryRecentSettlements(limit) {
    const { rows } = await pool_1.pool.query(`SELECT
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
    LIMIT $1`, [limit]);
    return rows.map((r) => ({
        id: r.id,
        userEmail: r.user_email,
        currencyCode: r.currency_code,
        grossAmount: parseFloat(r.gross_amount).toFixed(6),
        netAmount: parseFloat(r.net_amount).toFixed(6),
        feeAmount: parseFloat(r.fee_amount).toFixed(6),
        status: r.status,
        destinationAddress: r.xrpl_destination_address,
        xrplTxHash: r.xrpl_tx_hash ?? null,
        xrplConfirmedAt: r.xrpl_confirmed_at ?? null,
        xrplNetworkFeeXrp: r.xrpl_network_fee_xrp != null
            ? parseFloat(r.xrpl_network_fee_xrp).toFixed(6) : null,
        explorerUrl: r.xrpl_tx_hash && !r.xrpl_tx_hash.startsWith("mock_")
            ? `https://testnet.xrpl.org/transactions/${r.xrpl_tx_hash}`
            : null,
    }));
}
// ── XrplTreasuryService ───────────────────────────────────────────────────────
// ── Health calculation ────────────────────────────────────────────────────────
const THRESHOLD_WARNING = 50; // XRP — below this: warning
const THRESHOLD_CRITICAL = 20; // XRP — below this: critical
function computeHealth(treasury) {
    const balance = treasury.xrpBalance != null ? parseFloat(treasury.xrpBalance) : 0;
    if (!treasury.accountExists) {
        return {
            status: "critical",
            message: "Treasury wallet is not funded on XRPL Testnet. Settlement operations are unavailable.",
            xrpBalance: "0.000000",
            thresholdWarning: String(THRESHOLD_WARNING),
            thresholdCritical: String(THRESHOLD_CRITICAL),
        };
    }
    let status;
    let message;
    if (balance >= THRESHOLD_WARNING) {
        status = "healthy";
        message = "Treasury XRP balance is healthy.";
    }
    else if (balance >= THRESHOLD_CRITICAL) {
        status = "warning";
        message = "Treasury XRP balance is below the recommended reserve. Consider topping up.";
    }
    else {
        status = "critical";
        message = "Treasury XRP balance is critically low. Settlement operations may be impacted.";
    }
    return {
        status,
        message,
        xrpBalance: treasury.xrpBalance ?? "0.000000",
        thresholdWarning: String(THRESHOLD_WARNING),
        thresholdCritical: String(THRESHOLD_CRITICAL),
    };
}
// ── Metrics DB queries ─────────────────────────────────────────────────────────
async function querySettlementMetrics() {
    // Single query: successful settlements + confirmation time
    const { rows: wr } = await pool_1.pool.query(`
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
    const { rows: al } = await pool_1.pool.query(`
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
    const failed = parseInt(al[0]?.failed_count ?? "0", 10);
    const total = successful + failed;
    const successRate = total > 0 ? ((successful / total) * 100).toFixed(2) : "0.00";
    const avgSecs = wr[0]?.avg_confirm_secs != null
        ? parseFloat(wr[0].avg_confirm_secs).toFixed(1)
        : null;
    const rlusd = parseFloat(wr[0]?.settled_rlusd ?? "0");
    const eurq = parseFloat(wr[0]?.settled_eurq ?? "0");
    const volume = (rlusd + eurq).toFixed(6);
    return {
        totalSettlements: total,
        successfulSettlements: successful,
        failedSettlements: failed,
        settlementSuccessRate: successRate,
        averageConfirmationSeconds: avgSecs,
        totalSettledRLUSD: rlusd.toFixed(6),
        totalSettledEURQ: eurq.toFixed(6),
        totalSettlementVolume: volume,
        totalNetworkFeesXRP: parseFloat(wr[0]?.network_fees ?? "0").toFixed(6),
        lastSuccessfulSettlementAt: wr[0]?.last_success_at ?? null,
        lastFailedSettlementAt: al[0]?.last_failed_at ?? null,
    };
}
async function queryQueueTimestamps() {
    const { rows } = await pool_1.pool.query(`
    SELECT
      MAX(created_at) FILTER (WHERE action_type = 'xrpl.queue.success')::text AS last_success,
      MAX(created_at) FILTER (WHERE action_type = 'xrpl.queue.failed')::text  AS last_failed
    FROM audit_logs
    WHERE action_type IN ('xrpl.queue.success', 'xrpl.queue.failed')
  `);
    return {
        lastSuccessfulQueueRun: rows[0]?.last_success ?? null,
        lastFailedQueueRun: rows[0]?.last_failed ?? null,
    };
}
class XrplTreasuryService {
    /**
     * Returns the full treasury dashboard snapshot:
     *   - On-chain wallet state from XRPL Testnet (account_info + account_lines)
     *   - Settlement stats aggregated from withdrawal_requests
     *   - Last 20 xrpl_testnet settlements
     *
     * READ-ONLY: no seeds, no signing, no DB writes.
     */
    async getDashboard() {
        const rpcUrl = config_1.config.xrplTestnetRpcUrl;
        const issuerAddress = config_1.config.xrplTestnetIssuerAddress;
        // ── Config guard ─────────────────────────────────────────────────────────
        if (!issuerAddress || !issuerAddress.startsWith("r")) {
            return {
                status: "config_missing",
                message: "XRPL_TESTNET_ISSUER_ADDRESS is not configured.",
            };
        }
        try {
            (0, xrplRpc_1.assertTestnetRpc)(rpcUrl);
        }
        catch (err) {
            return { status: "config_missing", message: err.message };
        }
        // ── Derive currency hex codes ─────────────────────────────────────────────
        const rlusdHex = (0, TrustLineService_1.currencyToHex)(config_1.config.xrplTestnetRlusdCurrency).toUpperCase();
        const eurqHex = (0, TrustLineService_1.currencyToHex)(config_1.config.xrplTestnetEurqCurrency).toUpperCase();
        // ── Fetch on-chain data (with retry) ─────────────────────────────────────
        let accountInfo;
        try {
            accountInfo = await (0, xrplRpc_1.withRetry)(() => fetchAccountInfo(issuerAddress, rpcUrl), xrplRpc_1.isXrplTransientError, 3, 2_000);
        }
        catch (err) {
            if ((0, xrplRpc_1.isXrplTransientError)(err)) {
                return {
                    status: "xrpl_testnet_unavailable",
                    message: "XRPL Testnet is temporarily unavailable. Please try again later.",
                };
            }
            return {
                status: "xrpl_testnet_unavailable",
                message: `Failed to fetch treasury account info: ${err.message}`,
            };
        }
        // ── Build treasury wallet state ───────────────────────────────────────────
        let totalIssuedRLUSD = null;
        let totalIssuedEURQ = null;
        if (accountInfo.exists) {
            // Fetch account_lines to compute outstanding obligations.
            //
            // For an XRPL issuer, account_lines lists trust lines opened BY other
            // accounts TO the issuer. From the issuer's perspective, each line.balance
            // is NEGATIVE (it's a liability — tokens they've issued and that are
            // held elsewhere). We sum abs(balance) per currency to get total in
            // circulation.
            try {
                const lines = await (0, xrplRpc_1.withRetry)(() => fetchAccountLines(issuerAddress, rpcUrl), xrplRpc_1.isXrplTransientError, 3, 2_000);
                let rlusdTotal = 0;
                let eurqTotal = 0;
                for (const line of lines) {
                    const ccy = line.currency.toUpperCase();
                    // balance is negative for issuer obligations — take absolute value
                    const abs = Math.abs(parseFloat(line.balance ?? "0"));
                    if (ccy === rlusdHex)
                        rlusdTotal += abs;
                    if (ccy === eurqHex)
                        eurqTotal += abs;
                }
                totalIssuedRLUSD = rlusdTotal.toFixed(6);
                totalIssuedEURQ = eurqTotal.toFixed(6);
            }
            catch {
                // Non-fatal — dashboard still useful without obligations data
            }
        }
        const xrpBalance = accountInfo.balance != null
            ? (parseInt(accountInfo.balance, 10) / 1_000_000).toFixed(6)
            : null;
        const treasury = {
            address: issuerAddress,
            accountExists: accountInfo.exists,
            xrpBalance,
            ownerCount: accountInfo.ownerCount,
            totalIssuedRLUSD,
            totalIssuedEURQ,
        };
        // ── Health, metrics, queue, stats, settlements — all in parallel ─────────
        const [settlementStats, recentSettlements, metrics, queueTimestamps,] = await Promise.all([
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
        const queueSvc = require("./XrplSettlementQueueService").xrplSettlementQueueService;
        const queueStatus = queueSvc.getStatus();
        const queuedCount = await queueSvc.getQueuedCount();
        const queueMetrics = {
            workerEnabled: queueStatus.workerEnabled,
            queued: queuedCount,
            processing: queueStatus.processing,
            lastRunAt: queueStatus.lastRunAt,
            nextRunAt: queueStatus.nextRunAt,
            lastSuccessfulQueueRun: queueTimestamps.lastSuccessfulQueueRun,
            lastFailedQueueRun: queueTimestamps.lastFailedQueueRun,
        };
        return {
            status: "ok",
            network: "xrpl_testnet",
            treasury,
            health,
            metrics,
            queueMetrics,
            settlementStats,
            recentSettlements,
        };
    }
}
exports.XrplTreasuryService = XrplTreasuryService;
exports.xrplTreasuryService = new XrplTreasuryService();
//# sourceMappingURL=XrplTreasuryService.js.map