import { Wallet, ECDSA } from "xrpl";
import { pool } from "../db/pool";
import { config } from "../config";
import { custodialWalletService } from "./CustodialWalletService";
import { auditLogService } from "./AuditLogService";
import { currencyToHex } from "./TrustLineService";
import { postJson, sleep, isXrplTransientError, withRetry, assertTestnetRpc } from "../xrpl/xrplRpc";

// ─────────────────────────────────────────────────────────────────────────────
// TestTokenService — Phase 2C (testnet only)
//
// Sends XRPL Testnet issued tokens (RLUSD_TEST / EURQ_TEST) from the
// configured issuer wallet to a user's custodial wallet via XRPL Payment TX.
//
// ── ARCHITECTURE ─────────────────────────────────────────────────────────────
//   Issuer-as-dispenser: the issuer creates tokens on send (no reserve needed).
//   This service is completely separate from LedgerService and the internal
//   double-entry ledger. It does NOT create ledger_entries, does NOT credit
//   internal balances, and does NOT touch topup_transactions.
//
// ── SECURITY CONTRACT ────────────────────────────────────────────────────────
//   - Issuer seed is read from config (env var). Never logged or returned.
//   - issuerWallet.classicAddress is verified against XRPL_TESTNET_ISSUER_ADDRESS
//     before every TX — if mismatched, TX is aborted.
//   - RPC URL is validated against testnet guard before use.
//   - A pending DB row is inserted BEFORE submission so concurrent requests are
//     blocked by the cooldown check even if the API call is retried.
//
// ── TESTNET WARNING ──────────────────────────────────────────────────────────
//   All operations target XRPL Testnet. Drops have no real-world value.
//   Do NOT use mainnet issuer addresses.
// ─────────────────────────────────────────────────────────────────────────────

const EXPLORER_BASE = "https://testnet.xrpl.org/transactions";

// ── Result types ──────────────────────────────────────────────────────────────

export type DropCurrency = "RLUSD" | "EURQ";

export type DropResult =
  | { status: "sent";                        currency: DropCurrency; amount: string; xrplTxHash: string; explorerUrl: string; confirmedAt: Date }
  | { status: "already_requested_recently";  cooldownRemainingSeconds: number; lastDropAt: Date }
  | { status: "no_trust_lines";              message: string }
  | { status: "not_funded";                  message: string }
  | { status: "config_missing";              message: string }
  | { status: "disabled" }
  | { status: "xrpl_testnet_unavailable";    message: string }
  | { status: "failed";                      error: string };

export interface DropRecord {
  id: string;
  currency: string;
  amount_decimal: string;
  xrpl_tx_hash: string | null;
  status: "pending" | "confirmed" | "failed";
  error_message: string | null;
  requested_at: Date;
  confirmed_at: Date | null;
  explorerUrl: string | null;
}

// ── On-chain balance types (Phase 2D — read-only) ─────────────────────────────

export interface IssuedBalance {
  currency: string;
  label: string;
  issuer: string;
  balance: string;
}

export interface OnchainBalances {
  xrpBalance: string;
  reserveBalance: string;
  availableXrpBalance: string;
  issuedBalances: IssuedBalance[];
}

export type OnchainBalancesResult =
  | { status: "ok";                       walletAddress: string; balances: OnchainBalances }
  | { status: "not_funded";               message: string }
  | { status: "no_wallet";                message: string }
  | { status: "xrpl_testnet_unavailable"; message: string }
  | { status: "failed";                   error: string };

// ── TestTokenService class ────────────────────────────────────────────────────

export class TestTokenService {
  /**
   * Sends test issued tokens from the XRPL Testnet issuer wallet to
   * `userId`'s custodial wallet.
   *
   * ── Pre-checks ────────────────────────────────────────────────────────────
   *   1. Feature must be enabled (XRPL_TEST_TOKEN_DROP_ENABLED=true).
   *   2. Issuer address and seed must be configured.
   *   3. RPC URL must be XRPL Testnet (altnet/rippletest guard).
   *   4. User must have an active, funded custodial wallet.
   *   5. User must have established trust lines (trust_lines_set_at set).
   *   6. No confirmed/pending drop for the same currency within cooldown window.
   *
   * ── Flow ─────────────────────────────────────────────────────────────────
   *   1. Insert pending row in xrpl_test_token_drops.
   *   2. Audit log: xrpl.test_token_drop_begin.
   *   3. Fetch issuer account_info (Sequence + current ledger index).
   *   4. Build + sign Payment TX (issuer → user custodial address).
   *      ECDSA.secp256k1, same algorithm used to generate issuer wallet.
   *   5. Defensive guard: issuerWallet.classicAddress === XRPL_TESTNET_ISSUER_ADDRESS.
   *   6. Submit TX to XRPL Testnet.
   *   7. Poll tx RPC until validated:true + tesSUCCESS (up to 45 s).
   *   8. Update DB row: status=confirmed, xrpl_tx_hash, confirmed_at.
   *   9. Audit log: xrpl.test_token_drop_confirmed.
   *
   * ── Isolation guarantees ─────────────────────────────────────────────────
   *   - Does NOT touch LedgerService, balances, ledger_entries, or topup_transactions.
   *   - Does NOT decrypt user's custodial wallet seed.
   *   - Internal LumixPay balances are unaffected.
   */
  async requestDrop(userId: string, currency: DropCurrency): Promise<DropResult> {
    const rpcUrl        = config.xrplTestnetRpcUrl;
    const issuerAddress = config.xrplTestnetIssuerAddress;
    const issuerSeed    = config.xrplTestnetIssuerSeed;

    // ── Feature flag ──────────────────────────────────────────────────────────
    if (!config.xrplTestTokenDropEnabled) {
      return { status: "disabled" };
    }

    // ── Config validation ─────────────────────────────────────────────────────
    if (!issuerAddress || !issuerAddress.startsWith("r")) {
      return { status: "config_missing", message: "XRPL_TESTNET_ISSUER_ADDRESS is not configured or invalid." };
    }
    if (!issuerSeed) {
      return { status: "config_missing", message: "XRPL_TESTNET_ISSUER_SEED is not configured." };
    }

    try {
      assertTestnetRpc(rpcUrl);
    } catch (err: any) {
      console.error(`[TestToken] ${err.message}`);
      return { status: "config_missing", message: err.message };
    }

    // ── Load custodial wallet ─────────────────────────────────────────────────
    const wallet = await custodialWalletService.getWallet(userId);
    if (!wallet) {
      return { status: "config_missing", message: "No active custodial wallet found for this user." };
    }
    if (!wallet.funded_at) {
      return { status: "not_funded", message: "Wallet must be funded before requesting test tokens." };
    }
    if (!wallet.trust_lines_set_at) {
      return {
        status:  "no_trust_lines",
        message: "Trust lines must be established before requesting test tokens. Click 'Setup test token trust lines' first.",
      };
    }

    // ── Cooldown check ────────────────────────────────────────────────────────
    const cooldownHours = config.xrplTestTokenDropCooldownHours;
    const { rows: cooldownRows } = await pool.query<{ id: string; requested_at: Date }>(
      `SELECT id, requested_at
         FROM xrpl_test_token_drops
        WHERE user_id  = $1
          AND currency = $2
          AND status  != 'failed'
          AND requested_at > NOW() - ($3 || ' hours')::INTERVAL
        ORDER BY requested_at DESC
        LIMIT 1`,
      [userId, currency, cooldownHours]
    );

    if (cooldownRows[0]) {
      const lastDropAt    = cooldownRows[0].requested_at;
      const cooldownMs    = cooldownHours * 60 * 60 * 1000;
      const elapsedMs     = Date.now() - new Date(lastDropAt).getTime();
      const remainingSecs = Math.max(0, Math.ceil((cooldownMs - elapsedMs) / 1000));
      return { status: "already_requested_recently", cooldownRemainingSeconds: remainingSecs, lastDropAt };
    }

    // ── Amount from config ────────────────────────────────────────────────────
    const amount = currency === "RLUSD"
      ? config.xrplTestTokenDropRlusdAmount
      : config.xrplTestTokenDropEurqAmount;

    const currencyName = currency === "RLUSD"
      ? config.xrplTestnetRlusdCurrency
      : config.xrplTestnetEurqCurrency;

    const currencyHex = currencyToHex(currencyName);

    // ── Fetch issuer account sequence (with retry — no DB row yet) ───────────
    // Performed BEFORE inserting the pending row so that transient XRPL Testnet
    // unavailability does not leave a stale pending row that would block the
    // per-user cooldown check.
    // Retries up to 5× with 2 s delay for known transient errors (noNetwork,
    // timeout, network-level failures, HTTP 5xx).
    // Non-transient errors (actNotFound, invalidParams, etc.) are rethrown
    // immediately on the first attempt — no retry, no DB row.
    let sequence: number;
    let lastLedgerSequence: number;
    try {
      const info = await withRetry(
        () => this._getAccountInfo(issuerAddress, rpcUrl),
        isXrplTransientError,
        5,
        2_000,
        (attempt, err) =>
          console.warn(
            `[TestToken] account_info transient error (attempt ${attempt}/5): ` +
            `${(err as Error).message} — retrying in 2 s`
          )
      );
      sequence           = info.sequence;
      lastLedgerSequence = info.ledger_current_index + 40; // ~2 min buffer
    } catch (err: any) {
      if (isXrplTransientError(err)) {
        console.warn(
          `[TestToken] account_info failed after 5 attempts (transient): ${err.message}`
        );
        return {
          status:  "xrpl_testnet_unavailable",
          message: "XRPL Testnet is temporarily unavailable. Please try again in a minute.",
        };
      }
      const msg = `Failed to fetch issuer account info: ${err.message}`;
      console.error(`[TestToken] ${msg}`);
      return { status: "failed", error: msg };
    }

    // ── Insert pending DB row (account_info confirmed reachable) ──────────────
    const { rows: insertRows } = await pool.query<{ id: string }>(
      `INSERT INTO xrpl_test_token_drops
         (user_id, wallet_id, currency, amount_decimal, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING id`,
      [userId, wallet.id, currency, amount]
    );
    const dropId = insertRows[0]!.id;

    // ── Audit log: begin ──────────────────────────────────────────────────────
    void auditLogService.log({
      actorUserId: userId,
      actionType:  "xrpl.test_token_drop_begin",
      entityType:  "xrpl_test_token_drops",
      entityId:    dropId,
      metadata:    { currency, amount, destinationAddress: wallet.classic_address, user_id: userId },
    });

    // ── Build + sign Payment TX ───────────────────────────────────────────────
    // Sign with the issuer seed using ECDSA.secp256k1 — the same algorithm used
    // when generating the issuer wallet with ripple-keypairs.generateSeed().
    let txBlob: string;
    let txHash: string;
    try {
      const issuerWallet = Wallet.fromSeed(issuerSeed, { algorithm: ECDSA.secp256k1 });

      // Defensive guard: derived address must match env config.
      // Catches seed/address mismatch in config before any TX is submitted.
      if (issuerWallet.classicAddress !== issuerAddress) {
        throw new Error(
          `Issuer wallet address mismatch: derived=${issuerWallet.classicAddress} ` +
          `config=${issuerAddress}. ` +
          `Check that XRPL_TESTNET_ISSUER_SEED matches XRPL_TESTNET_ISSUER_ADDRESS.`
        );
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const signed = issuerWallet.sign({
        TransactionType: "Payment",
        Account:         issuerAddress,
        Destination:     wallet.classic_address,
        Amount: {
          currency: currencyHex,
          issuer:   issuerAddress,  // Amount.issuer MUST equal Account for issuer-sends
          value:    amount,
        },
        Fee:                "12",
        Sequence:           sequence,
        LastLedgerSequence: lastLedgerSequence,
      } as any); // eslint-disable-line @typescript-eslint/no-explicit-any

      txBlob = signed.tx_blob;
      txHash = signed.hash;
      // issuerWallet (and its private key) fall out of scope here
    } catch (err: any) {
      const msg = `Payment TX signing failed: ${err.message}`;
      console.error(`[TestToken] ${msg}`);
      await this._markFailed(dropId, msg);
      this._auditFailed(userId, dropId, { error: msg, currency });
      return { status: "failed", error: msg };
    }

    // ── Submit TX ─────────────────────────────────────────────────────────────
    console.log(
      `[TestToken] Submitting ${currency} Payment TX for user ${userId} ` +
      `→ ${wallet.classic_address} amount=${amount} txHash=${txHash}`
    );
    try {
      const engineResult = await this._submitTx(txBlob, rpcUrl);
      console.log(`[TestToken] Submit engine_result=${engineResult} txHash=${txHash}`);
    } catch (err: any) {
      const msg = `Payment TX submit failed: ${err.message}`;
      console.error(`[TestToken] ${msg}`);
      await this._markFailed(dropId, msg, txHash);
      this._auditFailed(userId, dropId, { error: msg, currency, txHash });
      return { status: "failed", error: msg };
    }

    // ── Poll for on-ledger validation ─────────────────────────────────────────
    console.log(`[TestToken] Polling for validation (up to 45 s)… txHash=${txHash}`);
    const validated = await this._pollTxValidated(txHash, rpcUrl, 45_000, 2_000);

    if (!validated) {
      const msg = `${currency} Payment TX not confirmed within 45 s (txHash=${txHash}). ` +
                  `The tokens may still arrive — check the XRPL Testnet Explorer.`;
      console.warn(`[TestToken] ${msg}`);
      await this._markFailed(dropId, msg, txHash);
      this._auditFailed(userId, dropId, { error: msg, currency, txHash });
      return { status: "failed", error: msg };
    }

    // ── Confirmed — update DB row ─────────────────────────────────────────────
    const confirmedAt = new Date();
    await pool.query(
      `UPDATE xrpl_test_token_drops
          SET status       = 'confirmed',
              xrpl_tx_hash = $1,
              confirmed_at = $2
        WHERE id = $3`,
      [txHash, confirmedAt.toISOString(), dropId]
    );

    // ── Audit log: confirmed ──────────────────────────────────────────────────
    void auditLogService.log({
      actorUserId: userId,
      actionType:  "xrpl.test_token_drop_confirmed",
      entityType:  "xrpl_test_token_drops",
      entityId:    dropId,
      metadata:    { currency, amount, txHash, confirmedAt: confirmedAt.toISOString(), user_id: userId },
    });

    console.log(
      `[TestToken] Drop confirmed for user ${userId} currency=${currency} ` +
      `amount=${amount} txHash=${txHash}`
    );

    return {
      status:      "sent",
      currency,
      amount,
      xrplTxHash:  txHash,
      explorerUrl: `${EXPLORER_BASE}/${txHash}`,
      confirmedAt,
    };
  }

  /**
   * Returns the most recent test token drops for `userId`, newest first.
   * Includes a pre-computed explorerUrl for each confirmed drop.
   */
  async recentDrops(userId: string, limit = 10): Promise<DropRecord[]> {
    const cap = Math.min(limit, 50);
    const { rows } = await pool.query<Omit<DropRecord, "explorerUrl">>(
      `SELECT id, currency, amount_decimal, xrpl_tx_hash, status,
              error_message, requested_at, confirmed_at
         FROM xrpl_test_token_drops
        WHERE user_id = $1
        ORDER BY requested_at DESC
        LIMIT $2`,
      [userId, cap]
    );
    return rows.map((r) => ({
      ...r,
      explorerUrl: r.xrpl_tx_hash ? `${EXPLORER_BASE}/${r.xrpl_tx_hash}` : null,
    }));
  }

  // ── On-chain balance reader (Phase 2D — read-only, no seed access) ──────────

  /**
   * Returns the real on-chain XRP and issued token balances for `userId`'s
   * custodial XRPL Testnet wallet.
   *
   * Uses:
   *   - account_info  → XRP balance (drops) + OwnerCount for reserve calc
   *   - account_lines → issued token balances filtered to XRPL_TESTNET_ISSUER_ADDRESS
   *
   * Both calls use withRetry (5×, 2 s apart) for transient XRPL unavailability.
   *
   * SAFETY:
   *   - Read-only: no DB writes, no ledger_entries, no seed access.
   *   - Does NOT affect internal LumixPay balances.
   *   - Returns amounts in human-readable XRP (not drops).
   *   - Only reports balances from the configured testnet issuer.
   */
  async getOnchainBalances(userId: string): Promise<OnchainBalancesResult> {
    const rpcUrl        = config.xrplTestnetRpcUrl;
    const issuerAddress = config.xrplTestnetIssuerAddress;

    // Guard: testnet RPC URL
    try {
      assertTestnetRpc(rpcUrl);
    } catch (err: any) {
      return { status: "failed", error: err.message };
    }

    // Load wallet — no seed access needed
    const wallet = await custodialWalletService.getWallet(userId);
    if (!wallet) {
      return { status: "no_wallet", message: "No active custodial wallet found for this user." };
    }
    if (!wallet.funded_at) {
      return {
        status:  "not_funded",
        message: "Wallet has not been funded yet. Fund the testnet wallet first to view on-chain balances.",
      };
    }

    const address = wallet.classic_address;

    // ── XRP balance via account_info ─────────────────────────────────────────
    let xrpInfo: { balance_drops: number; owner_count: number };
    try {
      xrpInfo = await withRetry(
        () => this._getAccountXrpInfo(address, rpcUrl),
        isXrplTransientError,
        5,
        2_000,
        (attempt, err) =>
          console.warn(
            `[OnchainBalance] account_info retry (${attempt}/5) for ${address}: ` +
            `${(err as Error).message}`
          )
      );
    } catch (err: any) {
      if (isXrplTransientError(err)) {
        return {
          status:  "xrpl_testnet_unavailable",
          message: "XRPL Testnet is temporarily unavailable. Please try again later.",
        };
      }
      return { status: "failed", error: `Failed to fetch XRP balance: ${err.message}` };
    }

    // ── Issued token balances via account_lines ───────────────────────────────
    let lines: Array<{ account: string; currency: string; balance: string }>;
    try {
      lines = await withRetry(
        () => this._fetchAccountLines(address, rpcUrl),
        isXrplTransientError,
        5,
        2_000,
        (attempt, err) =>
          console.warn(
            `[OnchainBalance] account_lines retry (${attempt}/5) for ${address}: ` +
            `${(err as Error).message}`
          )
      );
    } catch (err: any) {
      if (isXrplTransientError(err)) {
        return {
          status:  "xrpl_testnet_unavailable",
          message: "XRPL Testnet is temporarily unavailable. Please try again later.",
        };
      }
      return { status: "failed", error: `Failed to fetch token balances: ${err.message}` };
    }

    // ── Compute XRP values ────────────────────────────────────────────────────
    // Standard XRPL reserve: 10 XRP base + 2 XRP per owner object (trust line, etc.)
    const BASE_RESERVE_DROPS  = 10_000_000; // 10 XRP
    const OWNER_RESERVE_DROPS =  2_000_000; //  2 XRP per object
    const reserveDrops        = BASE_RESERVE_DROPS + xrpInfo.owner_count * OWNER_RESERVE_DROPS;
    const availableDrops      = xrpInfo.balance_drops - reserveDrops;

    const xrpBalance          = (xrpInfo.balance_drops / 1_000_000).toFixed(6);
    const reserveBalance      = (reserveDrops          / 1_000_000).toFixed(6);
    const availableXrpBalance = (Math.max(0, availableDrops) / 1_000_000).toFixed(6);

    // ── Filter issued lines to our testnet issuer only ────────────────────────
    const rlusdCurrency = config.xrplTestnetRlusdCurrency;
    const eurqCurrency  = config.xrplTestnetEurqCurrency;
    const rlusdHex      = currencyToHex(rlusdCurrency);
    const eurqHex       = currencyToHex(eurqCurrency);

    const issuerLines = lines.filter((l) => l.account === issuerAddress);

    const rlusdLine = issuerLines.find((l) => l.currency.toUpperCase() === rlusdHex.toUpperCase());
    const eurqLine  = issuerLines.find((l) => l.currency.toUpperCase() === eurqHex.toUpperCase());

    const issuedBalances: IssuedBalance[] = [
      {
        currency: rlusdCurrency,
        label:    `${rlusdCurrency}_TEST`,
        issuer:   issuerAddress,
        balance:  rlusdLine?.balance ?? "0",
      },
      {
        currency: eurqCurrency,
        label:    `${eurqCurrency}_TEST`,
        issuer:   issuerAddress,
        balance:  eurqLine?.balance ?? "0",
      },
    ];

    return {
      status:        "ok",
      walletAddress: address,
      balances: {
        xrpBalance,
        reserveBalance,
        availableXrpBalance,
        issuedBalances,
      },
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async _getAccountInfo(
    address: string,
    rpcUrl: string
  ): Promise<{ sequence: number; ledger_current_index: number }> {
    const body = JSON.stringify({
      method: "account_info",
      params: [{ account: address, ledger_index: "current", strict: true }],
    });
    const { status, text } = await postJson(rpcUrl, body, 10_000);
    if (status !== 200) throw new Error(`account_info HTTP ${status}`);

    const json = JSON.parse(text) as {
      result?: {
        status?: string;
        account_data?: { Sequence?: number };
        ledger_current_index?: number;
        error?: string;
      };
    };

    if (json.result?.status !== "success" || !json.result?.account_data?.Sequence) {
      throw new Error(`account_info error: ${json.result?.error ?? "no sequence returned"}`);
    }

    return {
      sequence:             json.result.account_data.Sequence,
      ledger_current_index: json.result.ledger_current_index ?? 0,
    };
  }

  private async _submitTx(txBlob: string, rpcUrl: string): Promise<string> {
    const body = JSON.stringify({
      method: "submit",
      params: [{ tx_blob: txBlob }],
    });
    const { status, text } = await postJson(rpcUrl, body, 15_000);
    if (status !== 200) throw new Error(`submit HTTP ${status}: ${text.slice(0, 200)}`);

    const json = JSON.parse(text) as {
      result?: {
        engine_result?:         string;
        engine_result_message?: string;
      };
    };

    const engineResult = json.result?.engine_result ?? "UNKNOWN";
    // tesSUCCESS = applied; terQUEUED = queued — both acceptable for submission.
    if (!engineResult.startsWith("tes") && !engineResult.startsWith("ter")) {
      throw new Error(
        `Payment rejected: ${engineResult} — ${json.result?.engine_result_message ?? "no message"}`
      );
    }

    return engineResult;
  }

  private async _pollTxValidated(
    txHash: string,
    rpcUrl: string,
    maxMs: number,
    intervalMs: number
  ): Promise<boolean> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (await this._isTxValidated(txHash, rpcUrl)) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(intervalMs, remaining));
    }
    return false;
  }

  private async _isTxValidated(txHash: string, rpcUrl: string): Promise<boolean> {
    try {
      const body = JSON.stringify({
        method: "tx",
        params: [{ transaction: txHash, binary: false }],
      });
      const { status, text } = await postJson(rpcUrl, body, 8_000);
      if (status !== 200) return false;

      const json = JSON.parse(text) as {
        result?: {
          validated?: boolean;
          meta?:      { TransactionResult?: string };
        };
      };

      return (
        json.result?.validated === true &&
        json.result?.meta?.TransactionResult === "tesSUCCESS"
      );
    } catch {
      return false;
    }
  }

  /**
   * Fetches XRP balance (in drops) and OwnerCount for `address`.
   * Used only for balance display — does NOT decrypt or access any seed.
   * Uses `ledger_index: "validated"` for a confirmed ledger state.
   */
  private async _getAccountXrpInfo(
    address: string,
    rpcUrl: string
  ): Promise<{ balance_drops: number; owner_count: number }> {
    const body = JSON.stringify({
      method: "account_info",
      params: [{ account: address, ledger_index: "validated", strict: true }],
    });
    const { status, text } = await postJson(rpcUrl, body, 10_000);
    if (status !== 200) throw new Error(`account_info HTTP ${status}`);

    const json = JSON.parse(text) as {
      result?: {
        status?:       string;
        account_data?: { Balance?: string; OwnerCount?: number };
        error?:        string;
      };
    };

    if (json.result?.status !== "success" || !json.result?.account_data?.Balance) {
      throw new Error(`account_info error: ${json.result?.error ?? "no balance returned"}`);
    }

    return {
      balance_drops: parseInt(json.result.account_data.Balance, 10),
      owner_count:   json.result.account_data.OwnerCount ?? 0,
    };
  }

  /**
   * Fetches all trust-line entries for `address` from the validated ledger.
   * Used only for balance display — does NOT decrypt or access any seed.
   * Caller filters the returned lines by issuer address.
   */
  private async _fetchAccountLines(
    address: string,
    rpcUrl: string
  ): Promise<Array<{ account: string; currency: string; balance: string }>> {
    const body = JSON.stringify({
      method: "account_lines",
      params: [{ account: address, ledger_index: "validated" }],
    });
    const { status, text } = await postJson(rpcUrl, body, 10_000);
    if (status !== 200) throw new Error(`account_lines HTTP ${status}`);

    const json = JSON.parse(text) as {
      result?: {
        status?: string;
        lines?:  Array<{ account: string; currency: string; balance: string }>;
        error?:  string;
      };
    };

    if (json.result?.status !== "success") {
      throw new Error(`account_lines error: ${json.result?.error ?? "unexpected response"}`);
    }

    return json.result?.lines ?? [];
  }

  private async _markFailed(dropId: string, errorMessage: string, txHash?: string): Promise<void> {
    await pool.query(
      `UPDATE xrpl_test_token_drops
          SET status        = 'failed',
              error_message = $1,
              xrpl_tx_hash  = COALESCE($2, xrpl_tx_hash)
        WHERE id = $3`,
      [errorMessage.slice(0, 500), txHash ?? null, dropId]
    );
  }

  private _auditFailed(
    userId: string,
    dropId: string,
    metadata: Record<string, unknown>
  ): void {
    void auditLogService.log({
      actorUserId: userId,
      actionType:  "xrpl.test_token_drop_failed",
      entityType:  "xrpl_test_token_drops",
      entityId:    dropId,
      metadata:    { ...metadata, user_id: userId },
    });
  }
}

export const testTokenService = new TestTokenService();
