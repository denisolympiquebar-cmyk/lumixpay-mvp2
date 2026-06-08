"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.trustLineService = exports.TrustLineService = void 0;
exports.currencyToHex = currencyToHex;
const xrpl_1 = require("xrpl");
const pool_1 = require("../db/pool");
const config_1 = require("../config");
const CustodialWalletService_1 = require("./CustodialWalletService");
const AuditLogService_1 = require("./AuditLogService");
const xrplRpc_1 = require("../xrpl/xrplRpc");
/**
 * Converts a currency name to the 20-byte uppercase hex representation
 * required by ripple-binary-codec for non-standard (>3 char) currency codes.
 *
 * 3-char codes (e.g. "USD") are returned as-is — they are native XRPL ISO codes.
 * Longer codes (e.g. "RLUSD", "EURQ") are ASCII-encoded into the first N bytes
 * of a 20-byte buffer, padded with zeros, then hex-uppercased.
 *
 * Examples:
 *   "RLUSD" → "524C555344000000000000000000000000000000"
 *   "EURQ"  → "4555525100000000000000000000000000000000"
 */
function currencyToHex(currency) {
    if (currency.length === 3)
        return currency;
    const buf = Buffer.alloc(20);
    Buffer.from(currency, "ascii").copy(buf);
    return buf.toString("hex").toUpperCase();
}
// ── TrustLineService class ────────────────────────────────────────────────────
class TrustLineService {
    /**
     * Establishes XRPL Testnet trust lines for two test currencies on `userId`'s
     * custodial wallet.
     *
     * ── Flow ─────────────────────────────────────────────────────────────────
     *   1. Validate config (issuer address, RPC URL safety guard).
     *   2. Load wallet — require funded_at, skip if trust_lines_set_at already set.
     *   3. Audit log wallet.trust_line_setup_begin.
     *   4. Fetch account_info → current Sequence + LastLedgerSequence.
     *   5. Decrypt seed (ONE call, auto-logged by CustodialWalletService).
     *   6. Sign BOTH TrustSet TXs synchronously (Wallet object lives only here).
     *   7. Submit RLUSD TrustSet → poll for validation.
     *   8. Submit EURQ TrustSet  → poll for validation.
     *   9. UPDATE trust_lines_set_at = NOW().
     *  10. Audit log wallet.trust_line_setup_complete.
     *
     * ── Idempotency ──────────────────────────────────────────────────────────
     *   Returns { status: "already_set" } immediately if trust_lines_set_at is
     *   already populated, without touching the seed or submitting any TX.
     *
     * ── Safety ───────────────────────────────────────────────────────────────
     *   Never logs, stores, or returns the plaintext seed.
     *   All errors are caught and converted to a typed TrustLineResult.
     *   Failure does not affect the user's wallet balance or funded_at status.
     */
    async setupTrustLines(userId) {
        const rpcUrl = config_1.config.xrplTestnetRpcUrl;
        const issuerAddress = config_1.config.xrplTestnetIssuerAddress;
        const trustLimit = config_1.config.xrplTestnetTrustLimit;
        const rlusdCode = config_1.config.xrplTestnetRlusdCurrency;
        const eurqCode = config_1.config.xrplTestnetEurqCurrency;
        // ── Config validation ────────────────────────────────────────────────────
        if (!issuerAddress || !issuerAddress.startsWith("r")) {
            return {
                status: "config_missing",
                message: "XRPL_TESTNET_ISSUER_ADDRESS is not configured or is not a valid r-address.",
            };
        }
        try {
            (0, xrplRpc_1.assertTestnetRpc)(rpcUrl);
        }
        catch (err) {
            console.error(`[TrustLine] ${err.message}`);
            return { status: "config_missing", message: err.message };
        }
        // ── Load wallet ──────────────────────────────────────────────────────────
        const wallet = await CustodialWalletService_1.custodialWalletService.getWallet(userId);
        if (!wallet) {
            return { status: "config_missing", message: "No active custodial wallet found for this user." };
        }
        if (!wallet.funded_at) {
            return {
                status: "not_funded",
                message: "Wallet must be funded before trust lines can be established.",
            };
        }
        if (wallet.trust_lines_set_at) {
            return { status: "already_set" };
        }
        // ── Audit log: begin ─────────────────────────────────────────────────────
        void AuditLogService_1.auditLogService.log({
            actorUserId: userId,
            actionType: "wallet.trust_line_setup_begin",
            entityType: "user_wallets",
            entityId: wallet.id,
            metadata: { currencies: [rlusdCode, eurqCode], issuerAddress, user_id: userId },
        });
        // ── Fetch account sequence ────────────────────────────────────────────────
        let sequence;
        let lastLedgerSequence;
        try {
            const info = await this._getAccountInfo(wallet.classic_address, rpcUrl);
            sequence = info.sequence;
            lastLedgerSequence = info.ledger_current_index + 40; // ~2 min buffer
        }
        catch (err) {
            const msg = `Failed to fetch account info from XRPL: ${err.message}`;
            console.error(`[TrustLine] ${msg}`);
            this._auditFailed(userId, wallet.id, { error: msg });
            return { status: "failed", currency: "BOTH", error: msg };
        }
        // ── Decrypt seed + sign both TXs (synchronous, seed never crosses an await) ──
        const rlusdHex = currencyToHex(rlusdCode);
        const eurqHex = currencyToHex(eurqCode);
        let rlusdTxBlob;
        let rlusdTxHash;
        let eurqTxBlob;
        let eurqTxHash;
        try {
            // decryptSeed() is async, so we await it here. The seed arrives as a string.
            // Immediately use it to create the Wallet (derives key in memory).
            const seed = await CustodialWalletService_1.custodialWalletService.decryptSeed(userId, `trust_line_setup:${rlusdCode},${eurqCode}`);
            // Build and sign BOTH transactions before any further awaits.
            // The xrplWallet object holds privateKey in memory; it exits scope after this block.
            //
            // MUST specify ecdsa-secp256k1: custodial wallets are provisioned via
            // ripple-keypairs.generateSeed() which produces secp256k1 family seeds.
            // xrpl v4 DEFAULT_ALGORITHM is ed25519, which derives a different keypair
            // and a different classic address from the same seed → tecBAD_AUTH.
            const xrplWallet = xrpl_1.Wallet.fromSeed(seed, { algorithm: xrpl_1.ECDSA.secp256k1 });
            // Defensive guard: derived address must match the address stored in DB.
            // If this ever fires it means provisioning and signing algorithms diverged.
            if (xrplWallet.classicAddress !== wallet.classic_address) {
                throw new Error(`Derived signing address (${xrplWallet.classicAddress}) does not match ` +
                    `stored custodial wallet address (${wallet.classic_address}). ` +
                    `Algorithm mismatch between provisioning and signing.`);
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const rlusdSigned = xrplWallet.sign({
                TransactionType: "TrustSet",
                Account: wallet.classic_address,
                LimitAmount: {
                    currency: rlusdHex,
                    issuer: issuerAddress,
                    value: trustLimit,
                },
                Flags: 0x00020000, // tfSetNoRipple
                Fee: "12",
                Sequence: sequence,
                LastLedgerSequence: lastLedgerSequence,
            }); // eslint-disable-line @typescript-eslint/no-explicit-any
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const eurqSigned = xrplWallet.sign({
                TransactionType: "TrustSet",
                Account: wallet.classic_address,
                LimitAmount: {
                    currency: eurqHex,
                    issuer: issuerAddress,
                    value: trustLimit,
                },
                Flags: 0x00020000, // tfSetNoRipple
                Fee: "12",
                Sequence: sequence + 1,
                LastLedgerSequence: lastLedgerSequence,
            }); // eslint-disable-line @typescript-eslint/no-explicit-any
            rlusdTxBlob = rlusdSigned.tx_blob;
            rlusdTxHash = rlusdSigned.hash;
            eurqTxBlob = eurqSigned.tx_blob;
            eurqTxHash = eurqSigned.hash;
            // seed and xrplWallet fall out of scope here — GC collects them
        }
        catch (err) {
            const msg = `Transaction signing failed: ${err.message}`;
            console.error(`[TrustLine] ${msg}`);
            this._auditFailed(userId, wallet.id, { error: msg });
            return { status: "failed", currency: "BOTH", error: msg };
        }
        // ── Submit + verify RLUSD TrustSet ────────────────────────────────────────
        console.log(`[TrustLine] Submitting ${rlusdCode} TrustSet for ${wallet.classic_address} ` +
            `txHash=${rlusdTxHash}`);
        try {
            await this._submitTx(rlusdTxBlob, rpcUrl);
        }
        catch (err) {
            const msg = `${rlusdCode} TrustSet submit failed: ${err.message}`;
            console.error(`[TrustLine] ${msg}`);
            this._auditFailed(userId, wallet.id, { error: msg, currency: rlusdCode, txHash: rlusdTxHash });
            return { status: "failed", currency: rlusdCode, error: msg };
        }
        const rlusdValidated = await this._pollTxValidated(rlusdTxHash, rpcUrl, 45_000, 2_000);
        if (!rlusdValidated) {
            const msg = `${rlusdCode} TrustSet not confirmed within 45 s (txHash=${rlusdTxHash})`;
            console.warn(`[TrustLine] ${msg}`);
            this._auditFailed(userId, wallet.id, { error: msg, currency: rlusdCode, txHash: rlusdTxHash });
            return { status: "failed", currency: rlusdCode, error: msg };
        }
        console.log(`[TrustLine] ${rlusdCode} TrustSet validated — txHash=${rlusdTxHash}`);
        // ── Submit + verify EURQ TrustSet ─────────────────────────────────────────
        console.log(`[TrustLine] Submitting ${eurqCode} TrustSet for ${wallet.classic_address} ` +
            `txHash=${eurqTxHash}`);
        try {
            await this._submitTx(eurqTxBlob, rpcUrl);
        }
        catch (err) {
            const msg = `${eurqCode} TrustSet submit failed: ${err.message}`;
            console.error(`[TrustLine] ${msg}`);
            this._auditFailed(userId, wallet.id, { error: msg, currency: eurqCode, txHash: eurqTxHash });
            return { status: "failed", currency: eurqCode, error: msg };
        }
        const eurqValidated = await this._pollTxValidated(eurqTxHash, rpcUrl, 45_000, 2_000);
        if (!eurqValidated) {
            const msg = `${eurqCode} TrustSet not confirmed within 45 s (txHash=${eurqTxHash})`;
            console.warn(`[TrustLine] ${msg}`);
            this._auditFailed(userId, wallet.id, { error: msg, currency: eurqCode, txHash: eurqTxHash });
            return { status: "failed", currency: eurqCode, error: msg };
        }
        console.log(`[TrustLine] ${eurqCode} TrustSet validated — txHash=${eurqTxHash}`);
        // ── Persist trust_lines_set_at ────────────────────────────────────────────
        await pool_1.pool.query(`UPDATE user_wallets
          SET trust_lines_set_at = NOW()
        WHERE user_id     = $1
          AND wallet_type = 'custodial'
          AND is_active   = true`, [userId]);
        // ── Audit log: complete ───────────────────────────────────────────────────
        void AuditLogService_1.auditLogService.log({
            actorUserId: userId,
            actionType: "wallet.trust_line_setup_complete",
            entityType: "user_wallets",
            entityId: wallet.id,
            metadata: { rlusdTxHash, eurqTxHash, issuerAddress, user_id: userId },
        });
        console.log(`[TrustLine] Trust lines established for user ${userId} ` +
            `address=${wallet.classic_address} issuer=${issuerAddress}`);
        return { status: "trust_lines_set", rlusdTxHash, eurqTxHash };
    }
    /**
     * Checks whether both test currency trust lines are present on-ledger for `userId`.
     * Calls account_lines on XRPL Testnet — does NOT decrypt the seed.
     * Returns null if the wallet is not funded or config is missing.
     */
    async checkTrustLines(userId) {
        const wallet = await CustodialWalletService_1.custodialWalletService.getWallet(userId);
        if (!wallet?.funded_at)
            return null;
        const issuerAddress = config_1.config.xrplTestnetIssuerAddress;
        if (!issuerAddress)
            return null;
        const rlusdHex = currencyToHex(config_1.config.xrplTestnetRlusdCurrency);
        const eurqHex = currencyToHex(config_1.config.xrplTestnetEurqCurrency);
        try {
            const lines = await this._fetchAccountLines(wallet.classic_address, config_1.config.xrplTestnetRpcUrl);
            const hasRlusd = lines.some((l) => l.account === issuerAddress && l.currency.toUpperCase() === rlusdHex);
            const hasEurq = lines.some((l) => l.account === issuerAddress && l.currency.toUpperCase() === eurqHex);
            return { checked: true, hasRlusd, hasEurq };
        }
        catch (err) {
            console.warn(`[TrustLine] checkTrustLines error for user ${userId}:`, err.message);
            return null;
        }
    }
    // ── Private helpers ─────────────────────────────────────────────────────────
    async _getAccountInfo(address, rpcUrl) {
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
    async _submitTx(txBlob, rpcUrl) {
        const body = JSON.stringify({
            method: "submit",
            params: [{ tx_blob: txBlob }],
        });
        const { status, text } = await (0, xrplRpc_1.postJson)(rpcUrl, body, 15_000);
        if (status !== 200)
            throw new Error(`submit HTTP ${status}: ${text.slice(0, 200)}`);
        const json = JSON.parse(text);
        const engineResult = json.result?.engine_result ?? "UNKNOWN";
        // tesSUCCESS = applied to current ledger; terQUEUED = queued — both acceptable.
        if (!engineResult.startsWith("tes") && !engineResult.startsWith("ter")) {
            throw new Error(`TrustSet rejected: ${engineResult} — ` +
                (json.result?.engine_result_message ?? "no message"));
        }
    }
    async _pollTxValidated(txHash, rpcUrl, maxMs, intervalMs) {
        const deadline = Date.now() + maxMs;
        while (Date.now() < deadline) {
            if (await this._isTxValidated(txHash, rpcUrl))
                return true;
            const remaining = deadline - Date.now();
            if (remaining <= 0)
                break;
            await (0, xrplRpc_1.sleep)(Math.min(intervalMs, remaining));
        }
        return false;
    }
    async _isTxValidated(txHash, rpcUrl) {
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
    async _fetchAccountLines(address, rpcUrl) {
        const body = JSON.stringify({
            method: "account_lines",
            params: [{ account: address, ledger_index: "validated" }],
        });
        const { status, text } = await (0, xrplRpc_1.postJson)(rpcUrl, body, 10_000);
        if (status !== 200)
            throw new Error(`account_lines HTTP ${status}`);
        const json = JSON.parse(text);
        return json.result?.lines ?? [];
    }
    _auditFailed(userId, walletId, metadata) {
        void AuditLogService_1.auditLogService.log({
            actorUserId: userId,
            actionType: "wallet.trust_line_setup_failed",
            entityType: "user_wallets",
            entityId: walletId,
            metadata: { ...metadata, user_id: userId },
        });
    }
}
exports.TrustLineService = TrustLineService;
exports.trustLineService = new TrustLineService();
//# sourceMappingURL=TrustLineService.js.map