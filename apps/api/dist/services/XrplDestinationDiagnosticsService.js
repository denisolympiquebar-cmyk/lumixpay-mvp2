"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.xrplDestinationDiagnosticsService = exports.XrplDestinationDiagnosticsService = void 0;
const config_1 = require("../config");
const TrustLineService_1 = require("./TrustLineService");
const xrplRpc_1 = require("../xrpl/xrplRpc");
function isValidXrplAddress(address) {
    return /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address);
}
async function fetchAccountInfo(address, rpcUrl) {
    const body = JSON.stringify({
        method: "account_info",
        params: [{ account: address, ledger_index: "validated", strict: true }],
    });
    const { status, text } = await (0, xrplRpc_1.postJson)(rpcUrl, body, 10_000);
    if (status !== 200)
        throw new Error(`account_info HTTP ${status}`);
    const json = JSON.parse(text);
    if (json.result?.status !== "success") {
        const err = json.result?.error ?? "unknown";
        // actNotFound = account doesn't exist yet (not an error for diagnostics)
        if (err === "actNotFound")
            return { exists: false, xrpBalance: null };
        throw new Error(`account_info error: ${err}`);
    }
    const balanceDrops = json.result?.account_data?.Balance;
    const xrpBalance = balanceDrops != null
        ? (parseInt(balanceDrops, 10) / 1_000_000).toFixed(6)
        : null;
    return { exists: true, xrpBalance };
}
async function fetchAccountLines(address, rpcUrl) {
    const body = JSON.stringify({
        method: "account_lines",
        params: [{ account: address, ledger_index: "validated" }],
    });
    const { status, text } = await (0, xrplRpc_1.postJson)(rpcUrl, body, 10_000);
    if (status !== 200)
        throw new Error(`account_lines HTTP ${status}`);
    const json = JSON.parse(text);
    if (json.result?.status !== "success") {
        const err = json.result?.error ?? "unknown";
        if (err === "actNotFound")
            return []; // account doesn't exist → no lines
        throw new Error(`account_lines error: ${err}`);
    }
    return json.result?.lines ?? [];
}
// ── XrplDestinationDiagnosticsService ────────────────────────────────────────
class XrplDestinationDiagnosticsService {
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
    async checkDestination(address, assetCode) {
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
        // ── Address format validation ─────────────────────────────────────────────
        if (!isValidXrplAddress(address)) {
            return {
                status: "invalid_address",
                message: `"${address}" is not a valid XRPL classic address.`,
            };
        }
        // ── Currency mapping ──────────────────────────────────────────────────────
        const currencyCode = assetCode === "RLUSD"
            ? config_1.config.xrplTestnetRlusdCurrency
            : config_1.config.xrplTestnetEurqCurrency;
        const currencyHex = (0, TrustLineService_1.currencyToHex)(currencyCode).toUpperCase();
        const currencyLabel = `${currencyCode}_TEST`;
        // ── Fetch account_info (with retry for transient errors) ──────────────────
        let accountInfo;
        try {
            accountInfo = await (0, xrplRpc_1.withRetry)(() => fetchAccountInfo(address, rpcUrl), xrplRpc_1.isXrplTransientError, 3, 2_000);
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
                message: `Failed to check destination account: ${err.message}`,
            };
        }
        // ── If account doesn't exist, skip account_lines (would error) ────────────
        if (!accountInfo.exists) {
            return {
                status: "ok",
                address,
                currency: assetCode,
                network: "xrpl_testnet",
                accountExists: false,
                xrpBalance: null,
                requiredIssuer: issuerAddress,
                requiredCurrency: currencyLabel,
                hasRequiredTrustLine: false,
                ready: false,
                message: `Destination account ${address} does not exist on XRPL Testnet. ` +
                    `The account must be funded with XRP before it can receive issued tokens.`,
            };
        }
        // ── Fetch trust lines ─────────────────────────────────────────────────────
        let lines;
        try {
            lines = await (0, xrplRpc_1.withRetry)(() => fetchAccountLines(address, rpcUrl), xrplRpc_1.isXrplTransientError, 3, 2_000);
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
                message: `Failed to check trust lines: ${err.message}`,
            };
        }
        // ── Check for matching trust line ─────────────────────────────────────────
        // A trust line matches when:
        //   line.account === issuerAddress (the peer is the configured issuer)
        //   AND line.currency === currencyHex (20-byte padded hex)
        //   AND parseFloat(line.limit) > 0 (limit must be non-zero to receive tokens)
        const hasTrustLine = lines.some((line) => line.account.toUpperCase() === issuerAddress.toUpperCase() &&
            line.currency.toUpperCase() === currencyHex &&
            parseFloat(line.limit) > 0);
        const ready = hasTrustLine; // account exists AND trust line present
        let message;
        if (ready) {
            message =
                `Destination is ready for XRPL Testnet settlement. ` +
                    `Account exists with ${accountInfo.xrpBalance ?? "?"} XRP and has a ` +
                    `trust line for ${currencyLabel} from the configured issuer.`;
        }
        else {
            message =
                `Destination account exists (${accountInfo.xrpBalance ?? "?"} XRP) but ` +
                    `does not have a trust line for ${currencyLabel} from the configured issuer ` +
                    `(${issuerAddress.slice(0, 8)}…). ` +
                    `Ask the recipient to add a trust line before settlement.`;
        }
        return {
            status: "ok",
            address,
            currency: assetCode,
            network: "xrpl_testnet",
            accountExists: true,
            xrpBalance: accountInfo.xrpBalance,
            requiredIssuer: issuerAddress,
            requiredCurrency: currencyLabel,
            hasRequiredTrustLine: hasTrustLine,
            ready,
            message,
        };
    }
}
exports.XrplDestinationDiagnosticsService = XrplDestinationDiagnosticsService;
exports.xrplDestinationDiagnosticsService = new XrplDestinationDiagnosticsService();
//# sourceMappingURL=XrplDestinationDiagnosticsService.js.map