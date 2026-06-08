"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.xrplSettlementDryRunService = exports.XrplSettlementDryRunService = void 0;
const xrpl_1 = require("xrpl");
const config_1 = require("../config");
const CustodialWalletService_1 = require("./CustodialWalletService");
const AuditLogService_1 = require("./AuditLogService");
const TrustLineService_1 = require("./TrustLineService");
const xrplRpc_1 = require("../xrpl/xrplRpc");
// ─────────────────────────────────────────────────────────────────────────────
// XrplSettlementDryRunService — Phase 3A (testnet only)
//
// Sends 1 RLUSD_TEST or EURQ_TEST from the user's LumixPay-managed custodial
// wallet to an external XRPL Testnet address.
//
// ── PURPOSE ──────────────────────────────────────────────────────────────────
//   Proves that LumixPay custodial wallets can sign and submit on-chain Payment
//   transactions as the SENDER — i.e. the custodial wallet pays, not the issuer.
//   This is the foundation for real withdrawal settlement (Phase 3B+).
//
// ── ISOLATION GUARANTEES ────────────────────────────────────────────────────
//   - Does NOT change internal LumixPay balances or ledger_entries.
//   - Does NOT create withdrawal rows or touch any settlement provider.
//   - MockSettlementProvider remains unchanged.
//   - The existing Withdraw flow is untouched.
//
// ── SECURITY CONTRACT ────────────────────────────────────────────────────────
//   - decryptSeed() is called ONCE, immediately used to create Wallet and sign
//     the TX synchronously, then the seed falls out of scope before any await.
//   - The plaintext seed is never logged, returned, or stored across an await.
//   - Destination address is validated (format + self-send) before any
//     decryption occurs.
//   - Derived address is verified against stored address (algorithm guard).
//   - RPC URL is checked against testnet guard before any network call.
//
// ── TESTNET WARNING ──────────────────────────────────────────────────────────
//   All operations target XRPL Testnet. The amount is fixed at 1 token.
//   Recipient must have a trust line for the currency from the same issuer.
// ─────────────────────────────────────────────────────────────────────────────
const FIXED_AMOUNT = "1";
const EXPLORER_BASE = "https://testnet.xrpl.org/transactions";
// ── Address validation ────────────────────────────────────────────────────────
/**
 * Validates that `address` looks like a syntactically correct XRPL classic
 * address (base58 alphabet, starts with 'r', 25-35 chars).
 * Does NOT check ledger existence or trust-line presence — those are caught
 * by TX submission (tecNO_LINE, tecPATH_NOT_FOUND, etc.).
 */
function isValidXrplAddress(address) {
    return /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address);
}
// ── XRPL RPC helpers ─────────────────────────────────────────────────────────
async function getAccountInfo(address, rpcUrl) {
    const body = JSON.stringify({
        method: "account_info",
        params: [{ account: address, ledger_index: "current", strict: true }],
    });
    const { status, text } = await (0, xrplRpc_1.postJson)(rpcUrl, body, 10_000);
    if (status !== 200)
        throw new Error(`account_info HTTP ${status}`);
    const json = JSON.parse(text);
    if (json.result?.status !== "success" || !json.result?.account_data?.Sequence) {
        throw new Error(`account_info error: ${json.result?.error ?? "no sequence returned"}`);
    }
    return {
        sequence: json.result.account_data.Sequence,
        ledger_current_index: json.result.ledger_current_index ?? 0,
    };
}
async function submitTx(txBlob, rpcUrl) {
    const body = JSON.stringify({
        method: "submit",
        params: [{ tx_blob: txBlob }],
    });
    const { status, text } = await (0, xrplRpc_1.postJson)(rpcUrl, body, 15_000);
    if (status !== 200)
        throw new Error(`submit HTTP ${status}: ${text.slice(0, 200)}`);
    const json = JSON.parse(text);
    const engineResult = json.result?.engine_result ?? "UNKNOWN";
    // tesSUCCESS = applied; terQUEUED = queued — both acceptable on submission.
    if (!engineResult.startsWith("tes") && !engineResult.startsWith("ter")) {
        throw new Error(`Payment rejected: ${engineResult} — ${json.result?.engine_result_message ?? "no message"}`);
    }
    return engineResult;
}
async function pollTxValidated(txHash, rpcUrl, maxMs, intervalMs) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        if (await isTxValidated(txHash, rpcUrl))
            return true;
        const remaining = deadline - Date.now();
        if (remaining <= 0)
            break;
        await (0, xrplRpc_1.sleep)(Math.min(intervalMs, remaining));
    }
    return false;
}
async function isTxValidated(txHash, rpcUrl) {
    try {
        const body = JSON.stringify({
            method: "tx",
            params: [{ transaction: txHash, binary: false }],
        });
        const { status, text } = await (0, xrplRpc_1.postJson)(rpcUrl, body, 8_000);
        if (status !== 200)
            return false;
        const json = JSON.parse(text);
        return (json.result?.validated === true &&
            json.result?.meta?.TransactionResult === "tesSUCCESS");
    }
    catch {
        return false;
    }
}
// ── XrplSettlementDryRunService ───────────────────────────────────────────────
class XrplSettlementDryRunService {
    /**
     * Sends exactly 1 token of `currency` from the caller's LumixPay-managed
     * custodial XRPL Testnet wallet to `destinationAddress`.
     *
     * ── Pre-checks (all before seed decryption) ────────────────────────────────
     *   1. Config: issuer address set, RPC URL is testnet.
     *   2. Destination: valid XRPL address format.
     *   3. No self-send (destination ≠ own custodial address).
     *   4. Wallet funded (funded_at set).
     *   5. Trust lines established (trust_lines_set_at set).
     *
     * ── Flow ──────────────────────────────────────────────────────────────────
     *   1. Fetch account_info for the SENDER (custodial wallet).
     *      Retries 5× for transient errors before returning xrpl_testnet_unavailable.
     *   2. Audit log: xrpl.settlement_test_begin.
     *   3. Decrypt seed → derive Wallet(secp256k1) → sign Payment TX synchronously.
     *      Seed does NOT cross the `await submitTx` boundary.
     *   4. Defensive guard: derived address matches stored address.
     *   5. Submit TX to XRPL Testnet.
     *   6. Poll for validation (up to 45 s).
     *   7. Audit log: xrpl.settlement_test_confirmed / xrpl.settlement_test_failed.
     *
     * ── XRPL Payment TX ──────────────────────────────────────────────────────
     *   TransactionType: "Payment"
     *   Account:         <custodial_wallet.classic_address>        ← SENDER
     *   Destination:     <destinationAddress>
     *   Amount:
     *     currency:      <currencyToHex("RLUSD") | currencyToHex("EURQ")>
     *     issuer:        <XRPL_TESTNET_ISSUER_ADDRESS>
     *     value:         "1"
     *   Fee:             "12"
     *   Sequence:        <account_info.Sequence>
     *   LastLedgerSequence: <ledger_current_index + 40>
     */
    async sendTestPayment(userId, destinationAddress, currency) {
        const rpcUrl = config_1.config.xrplTestnetRpcUrl;
        const issuerAddress = config_1.config.xrplTestnetIssuerAddress;
        // ── Config guards ─────────────────────────────────────────────────────────
        if (!issuerAddress || !issuerAddress.startsWith("r")) {
            return { status: "config_missing", message: "XRPL_TESTNET_ISSUER_ADDRESS is not configured or invalid." };
        }
        try {
            (0, xrplRpc_1.assertTestnetRpc)(rpcUrl);
        }
        catch (err) {
            console.error(`[DryRun] ${err.message}`);
            return { status: "config_missing", message: err.message };
        }
        // ── Destination validation (before any wallet or seed access) ─────────────
        if (!isValidXrplAddress(destinationAddress)) {
            return {
                status: "invalid_destination",
                message: "Invalid XRPL destination address. Must start with 'r' and be 25–35 characters (base58).",
            };
        }
        // ── Load custodial wallet (no seed access) ────────────────────────────────
        const wallet = await CustodialWalletService_1.custodialWalletService.getWallet(userId);
        if (!wallet) {
            return { status: "config_missing", message: "No active custodial wallet found for this user." };
        }
        if (!wallet.funded_at) {
            return {
                status: "not_funded",
                message: "Custodial wallet must be funded before sending test payments. Fund it on the Profile page first.",
            };
        }
        if (!wallet.trust_lines_set_at) {
            return {
                status: "no_trust_lines",
                message: "Trust lines must be established before sending test payments. Set up trust lines on the Profile page first.",
            };
        }
        // ── Self-send guard ───────────────────────────────────────────────────────
        if (destinationAddress === wallet.classic_address) {
            return {
                status: "self_send",
                message: "Cannot send to your own custodial wallet address.",
            };
        }
        const currencyName = currency === "RLUSD"
            ? config_1.config.xrplTestnetRlusdCurrency
            : config_1.config.xrplTestnetEurqCurrency;
        const currencyHex = (0, TrustLineService_1.currencyToHex)(currencyName);
        // ── Audit log: begin ──────────────────────────────────────────────────────
        void AuditLogService_1.auditLogService.log({
            actorUserId: userId,
            actionType: "xrpl.settlement_test_begin",
            entityType: "user_wallets",
            entityId: wallet.id,
            metadata: {
                currency,
                destination: destinationAddress,
                amount: FIXED_AMOUNT,
                senderAddress: wallet.classic_address,
                user_id: userId,
            },
        });
        // ── Fetch sender account sequence (with retry) ────────────────────────────
        let sequence;
        let lastLedgerSequence;
        try {
            const info = await (0, xrplRpc_1.withRetry)(() => getAccountInfo(wallet.classic_address, rpcUrl), xrplRpc_1.isXrplTransientError, 5, 2_000, (attempt, err) => console.warn(`[DryRun] account_info retry (${attempt}/5) for ${wallet.classic_address}: ` +
                `${err.message}`));
            sequence = info.sequence;
            lastLedgerSequence = info.ledger_current_index + 40;
        }
        catch (err) {
            if ((0, xrplRpc_1.isXrplTransientError)(err)) {
                console.warn(`[DryRun] account_info failed after 5 attempts: ${err.message}`);
                this._auditFailed(userId, wallet.id, {
                    error: err.message, currency, destination: destinationAddress,
                });
                return {
                    status: "xrpl_testnet_unavailable",
                    message: "XRPL Testnet is temporarily unavailable. Please try again in a minute.",
                };
            }
            const msg = `Failed to fetch account info: ${err.message}`;
            console.error(`[DryRun] ${msg}`);
            this._auditFailed(userId, wallet.id, {
                error: msg, currency, destination: destinationAddress,
            });
            return { status: "failed", error: msg };
        }
        // ── Decrypt seed + sign TX synchronously (seed never crosses an await) ────
        //
        // The seed is decrypted, immediately used to derive the xrpl Wallet and sign
        // the TX, then the try block ends and both `seed` and `xrplWallet` fall out
        // of scope before the next `await submitTx`.
        //
        // Algorithm: ECDSA.secp256k1 — the same algorithm used by generateSeed()
        // (via ripple-keypairs) during provisioning. Using ed25519 here would derive
        // a different public key → tecBAD_AUTH on the XRPL ledger.
        let txBlob;
        let txHash;
        try {
            const seed = await CustodialWalletService_1.custodialWalletService.decryptSeed(userId, `settlement_dry_run:${currencyName}→${destinationAddress}`);
            const xrplWallet = xrpl_1.Wallet.fromSeed(seed, { algorithm: xrpl_1.ECDSA.secp256k1 });
            // Defensive guard: derived address must match stored address.
            // Catches any future algorithm or seed mismatch before TX submission.
            if (xrplWallet.classicAddress !== wallet.classic_address) {
                throw new Error(`Address mismatch: derived=${xrplWallet.classicAddress} ` +
                    `stored=${wallet.classic_address}. ` +
                    `Algorithm mismatch between provisioning (secp256k1) and signing.`);
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const signed = xrplWallet.sign({
                TransactionType: "Payment",
                Account: wallet.classic_address,
                Destination: destinationAddress,
                Amount: {
                    currency: currencyHex,
                    issuer: issuerAddress,
                    value: FIXED_AMOUNT,
                },
                Fee: "12",
                Sequence: sequence,
                LastLedgerSequence: lastLedgerSequence,
            }); // eslint-disable-line @typescript-eslint/no-explicit-any
            txBlob = signed.tx_blob;
            txHash = signed.hash;
            // seed and xrplWallet go out of scope here — GC collects them
        }
        catch (err) {
            const msg = `TX signing failed: ${err.message}`;
            console.error(`[DryRun] ${msg}`);
            this._auditFailed(userId, wallet.id, {
                error: msg, currency, destination: destinationAddress,
            });
            return { status: "failed", error: msg };
        }
        // ── Submit TX ─────────────────────────────────────────────────────────────
        console.log(`[DryRun] Submitting ${currency} Payment TX ` +
            `${wallet.classic_address} → ${destinationAddress} ` +
            `amount=${FIXED_AMOUNT} txHash=${txHash}`);
        try {
            const engineResult = await submitTx(txBlob, rpcUrl);
            console.log(`[DryRun] Submit engine_result=${engineResult} txHash=${txHash}`);
        }
        catch (err) {
            const msg = `TX submit failed: ${err.message}`;
            console.error(`[DryRun] ${msg}`);
            this._auditFailed(userId, wallet.id, {
                error: msg, currency, destination: destinationAddress, txHash,
            });
            return { status: "failed", error: msg };
        }
        // ── Poll for on-ledger validation (up to 45 s) ────────────────────────────
        // Poll loop silently retries every 2 s; transient XRPL issues do not abort.
        console.log(`[DryRun] Polling for validation (up to 45 s)… txHash=${txHash}`);
        const validated = await pollTxValidated(txHash, rpcUrl, 45_000, 2_000);
        if (!validated) {
            const msg = `Payment TX not confirmed within 45 s (txHash=${txHash}). ` +
                `Check the XRPL Testnet Explorer — it may arrive shortly.`;
            console.warn(`[DryRun] ${msg}`);
            this._auditFailed(userId, wallet.id, {
                error: msg, currency, destination: destinationAddress, txHash,
            });
            return { status: "failed", error: msg };
        }
        const validatedAt = new Date();
        // ── Audit log: confirmed ──────────────────────────────────────────────────
        void AuditLogService_1.auditLogService.log({
            actorUserId: userId,
            actionType: "xrpl.settlement_test_confirmed",
            entityType: "user_wallets",
            entityId: wallet.id,
            metadata: {
                currency,
                destination: destinationAddress,
                amount: FIXED_AMOUNT,
                senderAddress: wallet.classic_address,
                txHash,
                validatedAt: validatedAt.toISOString(),
                user_id: userId,
            },
        });
        console.log(`[DryRun] Settlement test confirmed: user=${userId} ` +
            `${wallet.classic_address} → ${destinationAddress} ` +
            `txHash=${txHash}`);
        return {
            status: "sent",
            txHash,
            explorerUrl: `${EXPLORER_BASE}/${txHash}`,
            validatedAt,
        };
    }
    _auditFailed(userId, walletId, metadata) {
        void AuditLogService_1.auditLogService.log({
            actorUserId: userId,
            actionType: "xrpl.settlement_test_failed",
            entityType: "user_wallets",
            entityId: walletId,
            metadata: { ...metadata, user_id: userId },
        });
    }
}
exports.XrplSettlementDryRunService = XrplSettlementDryRunService;
exports.xrplSettlementDryRunService = new XrplSettlementDryRunService();
//# sourceMappingURL=XrplSettlementDryRunService.js.map