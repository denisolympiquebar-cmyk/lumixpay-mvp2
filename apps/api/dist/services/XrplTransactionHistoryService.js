"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.xrplTransactionHistoryService = exports.XrplTransactionHistoryService = void 0;
const config_1 = require("../config");
const CustodialWalletService_1 = require("./CustodialWalletService");
const TrustLineService_1 = require("./TrustLineService");
const xrplRpc_1 = require("../xrpl/xrplRpc");
// ─────────────────────────────────────────────────────────────────────────────
// XrplTransactionHistoryService — Phase 3B (testnet only)
//
// Returns the real on-chain XRPL Testnet transaction history for a user's
// LumixPay-managed custodial wallet, read via account_tx JSON-RPC.
//
// ── ISOLATION GUARANTEES ────────────────────────────────────────────────────
//   - READ-ONLY: no DB writes, no balances, no ledger_entries, no seeds.
//   - Does NOT touch the internal LumixPay History page or LedgerService.
//   - Only Payment and TrustSet transactions are mapped; all others are ignored.
//   - Only issued-currency Payments from XRPL_TESTNET_ISSUER_ADDRESS are shown;
//     tokens from unknown issuers are silently dropped.
//
// ── TIMESTAMP NOTE ──────────────────────────────────────────────────────────
//   XRPL stores transaction close times as seconds since the Ripple epoch
//   (January 1, 2000 00:00:00 UTC). To convert to Unix: add 946684800.
// ─────────────────────────────────────────────────────────────────────────────
const EXPLORER_BASE = "https://testnet.xrpl.org/transactions";
const RIPPLE_EPOCH_OFFSET = 946684800; // seconds from Unix to Ripple epoch
// ── Helpers ───────────────────────────────────────────────────────────────────
/** Converts Ripple epoch (seconds since 2000-01-01) to ISO 8601 string. */
function rippleEpochToIso(xrplDate) {
    return new Date((xrplDate + RIPPLE_EPOCH_OFFSET) * 1000).toISOString();
}
/**
 * Maps a currency code (20-byte hex or 3-char ISO) to a display label.
 * Returns null if the code does not match any known currency.
 *
 * Comparison is case-insensitive; input may be uppercase or lowercase hex.
 *
 * Examples:
 *   "524C555344000000000000000000000000000000" → "RLUSD_TEST"
 *   "4555525100000000000000000000000000000000" → "EURQ_TEST"
 *   "XRP" (3-char ISO)                         → "XRP"
 */
function mapCurrencyCode(code, rlusdHex, eurqHex, rlusdLabel, eurqLabel) {
    const upper = code.toUpperCase();
    if (upper === rlusdHex)
        return rlusdLabel;
    if (upper === eurqHex)
        return eurqLabel;
    if (code.length === 3)
        return code; // 3-char ISO code (e.g. "USD", "XRP") — pass through
    return null; // unknown hex currency — caller decides to skip
}
// ── XrplTransactionHistoryService ────────────────────────────────────────────
class XrplTransactionHistoryService {
    /**
     * Fetches and maps transaction history for `userId`'s custodial wallet.
     *
     * ── Data source ──────────────────────────────────────────────────────────
     *   XRPL JSON-RPC account_tx, `forward: false` (newest first).
     *   Transactions are read from the validated ledger only (`validated: true`).
     *
     * ── Filtering rules ──────────────────────────────────────────────────────
     *   Payment transactions:
     *     - XRP payments: included regardless of counterparty.
     *     - Issued-currency payments: included ONLY if Amount.issuer equals
     *       XRPL_TESTNET_ISSUER_ADDRESS. Unknown-issuer tokens are dropped.
     *   TrustSet transactions:
     *     - Included ONLY if Account === wallet address AND
     *       LimitAmount.issuer === XRPL_TESTNET_ISSUER_ADDRESS.
     *   All other transaction types (AccountSet, OfferCreate, etc.) are ignored.
     *
     * ── Safety ───────────────────────────────────────────────────────────────
     *   Read-only. No DB writes. No seed access. No balance changes.
     */
    async getTransactionHistory(userId, limit) {
        const rpcUrl = config_1.config.xrplTestnetRpcUrl;
        const issuerAddress = config_1.config.xrplTestnetIssuerAddress;
        try {
            (0, xrplRpc_1.assertTestnetRpc)(rpcUrl);
        }
        catch (err) {
            return { status: "failed", error: err.message };
        }
        // Load wallet — no seed access
        const wallet = await CustodialWalletService_1.custodialWalletService.getWallet(userId);
        if (!wallet) {
            return { status: "no_wallet", message: "No active custodial wallet found." };
        }
        if (!wallet.funded_at) {
            return {
                status: "not_funded",
                message: "Wallet is not funded on XRPL Testnet yet. Fund the wallet first to view transaction history.",
            };
        }
        const address = wallet.classic_address;
        const rlusdCode = config_1.config.xrplTestnetRlusdCurrency;
        const eurqCode = config_1.config.xrplTestnetEurqCurrency;
        const rlusdHex = (0, TrustLineService_1.currencyToHex)(rlusdCode).toUpperCase();
        const eurqHex = (0, TrustLineService_1.currencyToHex)(eurqCode).toUpperCase();
        const rlusdLabel = `${rlusdCode}_TEST`;
        const eurqLabel = `${eurqCode}_TEST`;
        // ── Fetch raw transactions from XRPL Testnet ──────────────────────────
        let rawEntries;
        try {
            rawEntries = await (0, xrplRpc_1.withRetry)(() => this._fetchAccountTx(address, rpcUrl, limit), xrplRpc_1.isXrplTransientError, 5, 2_000, (attempt, err) => console.warn(`[TxHistory] account_tx retry (${attempt}/5) for ${address}: ` +
                `${err.message}`));
        }
        catch (err) {
            if ((0, xrplRpc_1.isXrplTransientError)(err)) {
                return {
                    status: "xrpl_testnet_unavailable",
                    message: "XRPL Testnet is temporarily unavailable. Please try again later.",
                };
            }
            return { status: "failed", error: `Failed to fetch transaction history: ${err.message}` };
        }
        // ── Map raw entries to WalletTransaction ─────────────────────────────
        const transactions = [];
        for (const entry of rawEntries) {
            // Only show validated transactions (not just submitted/queued)
            if (entry.validated !== true)
                continue;
            const tx = entry.tx;
            const meta = entry.meta;
            if (!tx)
                continue;
            const hash = tx.hash;
            const txType = tx.TransactionType;
            const txDate = tx.date;
            const ledgerIndex = tx.ledger_index;
            const txResult = meta?.TransactionResult;
            if (!hash || !txType)
                continue;
            const status = txResult === "tesSUCCESS" ? "confirmed" : "failed";
            const timestamp = txDate != null ? rippleEpochToIso(txDate) : null;
            const explorerUrl = `${EXPLORER_BASE}/${hash}`;
            // ── Payment ────────────────────────────────────────────────────────
            if (txType === "Payment") {
                const txAccount = tx.Account;
                const txDestination = tx.Destination;
                const txAmount = tx.Amount;
                if (!txAccount || !txDestination)
                    continue;
                // Determine direction relative to the custodial wallet
                let direction;
                let counterparty;
                if (txAccount === address) {
                    direction = "OUT";
                    counterparty = txDestination;
                }
                else if (txDestination === address) {
                    direction = "IN";
                    counterparty = txAccount;
                }
                else {
                    // Transaction involves neither sender nor receiver being this wallet
                    continue;
                }
                // Map amount and currency
                let currency;
                let amount;
                if (typeof txAmount === "string") {
                    // XRP payment — Amount is a string of drops
                    const drops = parseInt(txAmount, 10);
                    currency = "XRP";
                    amount = isNaN(drops) ? txAmount : (drops / 1_000_000).toFixed(6);
                }
                else if (txAmount && typeof txAmount === "object") {
                    // Issued currency payment
                    const amtIssuer = txAmount.issuer ?? "";
                    const amtCurrency = txAmount.currency ?? "";
                    const amtValue = txAmount.value ?? "0";
                    // Only show tokens from our configured testnet issuer
                    if (amtIssuer !== issuerAddress)
                        continue;
                    const label = mapCurrencyCode(amtCurrency, rlusdHex, eurqHex, rlusdLabel, eurqLabel);
                    if (!label)
                        continue; // unknown currency — skip to avoid confusion
                    currency = label;
                    amount = amtValue;
                }
                else {
                    continue;
                }
                transactions.push({
                    hash, type: "Payment", direction, currency, amount,
                    counterparty, status, ledgerIndex, timestamp, explorerUrl,
                });
            }
            // ── TrustSet ───────────────────────────────────────────────────────
            else if (txType === "TrustSet") {
                const txAccount = tx.Account;
                const limitAmount = tx.LimitAmount;
                // Only map trust lines created by this wallet for our testnet issuer
                if (!txAccount || txAccount !== address)
                    continue;
                if (!limitAmount || typeof limitAmount !== "object")
                    continue;
                const limitIssuer = limitAmount.issuer ?? "";
                const limitCurrency = limitAmount.currency ?? "";
                if (limitIssuer !== issuerAddress)
                    continue;
                const trustLineCurrency = mapCurrencyCode(limitCurrency, rlusdHex, eurqHex, rlusdLabel, eurqLabel) ?? undefined;
                transactions.push({
                    hash,
                    type: "TrustSet",
                    direction: "SYSTEM",
                    currency: "TRUST_LINE",
                    trustLineCurrency,
                    amount: "-",
                    counterparty: issuerAddress,
                    status,
                    ledgerIndex,
                    timestamp,
                    explorerUrl,
                });
            }
            // All other transaction types are silently ignored
        }
        return { status: "ok", walletAddress: address, transactions };
    }
    // ── Private helpers ───────────────────────────────────────────────────────
    /**
     * Calls account_tx on XRPL Testnet for `address`.
     * Returns raw entries newest-first (`forward: false`).
     * Throws on HTTP errors or XRPL logical errors (noNetwork, etc.) so that
     * the withRetry wrapper above can handle transient failures.
     */
    async _fetchAccountTx(address, rpcUrl, limit) {
        const body = JSON.stringify({
            method: "account_tx",
            params: [{
                    account: address,
                    ledger_index_min: -1, // -1 = earliest available validated ledger
                    ledger_index_max: -1, // -1 = latest validated ledger
                    limit,
                    forward: false, // newest first
                }],
        });
        const { status, text } = await (0, xrplRpc_1.postJson)(rpcUrl, body, 15_000);
        if (status !== 200)
            throw new Error(`account_tx HTTP ${status}`);
        const json = JSON.parse(text);
        if (json.result?.status !== "success") {
            throw new Error(`account_tx error: ${json.result?.error ?? "unexpected response"}`);
        }
        return json.result?.transactions ?? [];
    }
}
exports.XrplTransactionHistoryService = XrplTransactionHistoryService;
exports.xrplTransactionHistoryService = new XrplTransactionHistoryService();
//# sourceMappingURL=XrplTransactionHistoryService.js.map