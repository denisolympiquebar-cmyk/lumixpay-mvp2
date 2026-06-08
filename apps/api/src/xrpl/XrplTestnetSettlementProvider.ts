import { Wallet, ECDSA } from "xrpl";
import { config } from "../config";
import { auditLogService } from "../services/AuditLogService";
import { currencyToHex } from "../services/TrustLineService";
import {
  SettlementProvider,
  SettlementRequest,
  SettlementResult,
} from "./SettlementProvider";
import { postJson, sleep, isXrplTransientError, withRetry, assertTestnetRpc } from "./xrplRpc";

// ─────────────────────────────────────────────────────────────────────────────
// XrplTestnetSettlementProvider — Phase 3C
//
// Implements SettlementProvider using the LumixPay XRPL Testnet
// treasury/issuer wallet to send issued-currency Payments to
// user-supplied external addresses.
//
// ── ACTIVATION ───────────────────────────────────────────────────────────────
//   Set SETTLEMENT_PROVIDER=xrpl_testnet in env.
//   Requires XRPL_TESTNET_ISSUER_ADDRESS and XRPL_TESTNET_ISSUER_SEED.
//
// ── SENDER ───────────────────────────────────────────────────────────────────
//   Account = config.xrplTestnetIssuerAddress   (treasury/issuer is the sender)
//   Signed with config.xrplTestnetIssuerSeed + ECDSA.secp256k1
//
//   When an issuer sends its own issued currency to a destination that trusts it,
//   XRPL creates the tokens at the destination. No prior balance is required.
//   The destination MUST have a trust line to the issuer for the currency.
//
// ── ASSET ISSUER OVERRIDE ────────────────────────────────────────────────────
//   request.assetIssuerAddress (from the assets table) may contain a mainnet
//   issuer address for RLUSD/EURQ (e.g. rMH4UxPrbuMa1spCBR98hLLyNJp4d8p4tM).
//   This provider IGNORES it and always uses config.xrplTestnetIssuerAddress.
//   A warning is logged if they differ (environment misconfiguration signal).
//
// ── SAFETY CONTRACT ──────────────────────────────────────────────────────────
//   1. assertTestnetRpc() called before any network operation.
//   2. Issuer seed is read from config, used to sign synchronously, and falls
//      out of scope before any subsequent await. Never logged or returned.
//   3. settle() NEVER throws — all errors surface via SettlementResult.status.
//   4. xrpl_submitted_at is stamped by LedgerService BEFORE settle() is called;
//      this provider does not write to the DB.
//
// ── TESTNET WARNING ──────────────────────────────────────────────────────────
//   All operations target XRPL Testnet. Do NOT use mainnet issuers.
//   Tokens sent have no real-world value.
// ─────────────────────────────────────────────────────────────────────────────

// ── Friendly error mapping ────────────────────────────────────────────────────
//
// Maps XRPL engine_result codes to operator-readable messages.
// The original code is always preserved in logs and audit metadata.

function friendlyXrplError(engineResult: string): string {
  if (
    engineResult === "tecNO_LINE"         ||
    engineResult === "tecPATH_DRY"        ||
    engineResult === "tecPATH_NOT_FOUND"
  ) {
    return (
      "Destination wallet does not have the required trust line for this asset. " +
      "Ask the recipient to add a trust line to the configured issuer, then retry settlement."
    );
  }
  if (engineResult === "tecUNFUNDED_PAYMENT") {
    return "Treasury wallet has insufficient funds or cannot complete this payment.";
  }
  if (engineResult === "tecNO_DST" || engineResult === "actNotFound") {
    return "Destination XRPL account does not exist or is not funded with XRP.";
  }
  if (engineResult === "tefPAST_SEQ" || engineResult === "terPRE_SEQ") {
    return "XRPL sequence conflict. Please retry settlement in a few seconds.";
  }
  if (
    engineResult.includes("noNetwork") ||
    engineResult.includes("timeout")   ||
    engineResult.includes("timed out")
  ) {
    return "XRPL Testnet is temporarily unavailable. Please retry later.";
  }
  return (
    `XRPL payment rejected (${engineResult}). ` +
    `Check the XRPL Testnet Explorer for details, then retry if appropriate.`
  );
}

const TX_FEE_DROPS          = 12;     // standard XRPL minimum fee in drops
const TX_FEE_XRP            = (TX_FEE_DROPS / 1_000_000).toFixed(6); // "0.000012"
const POLL_MAX_MS           = 60_000; // wait up to 60 s for ledger confirmation
const POLL_INTERVAL_MS      = 2_000;
const ACCOUNT_INFO_RETRIES  = 5;
const ACCOUNT_INFO_DELAY_MS = 2_000;

// ── XRPL RPC helpers ─────────────────────────────────────────────────────────

async function getAccountInfo(
  address: string,
  rpcUrl:  string
): Promise<{ sequence: number; ledger_current_index: number }> {
  const body = JSON.stringify({
    method: "account_info",
    params: [{ account: address, ledger_index: "current", strict: true }],
  });
  const { status, text } = await postJson(rpcUrl, body, 10_000);
  if (status !== 200) throw new Error(`account_info HTTP ${status}`);

  const json = JSON.parse(text) as {
    result?: {
      status?:               string;
      account_data?:         { Sequence?: number };
      ledger_current_index?: number;
      error?:                string;
    };
  };

  if (json.result?.status !== "success" || json.result?.account_data?.Sequence == null) {
    throw new Error(`account_info error: ${json.result?.error ?? "no sequence returned"}`);
  }

  return {
    sequence:             json.result.account_data.Sequence,
    ledger_current_index: json.result.ledger_current_index ?? 0,
  };
}

/**
 * Submits a signed TX blob. Returns the engine_result code and message.
 * Does NOT throw on tec/tem/tef codes — caller decides how to handle them.
 * Throws only on network errors or HTTP failures (allowing retry).
 */
async function submitTx(
  txBlob: string,
  rpcUrl: string
): Promise<{ engineResult: string; engineMessage: string }> {
  const body = JSON.stringify({
    method: "submit",
    params: [{ tx_blob: txBlob }],
  });
  const { status, text } = await postJson(rpcUrl, body, 15_000);
  if (status !== 200) throw new Error(`submit HTTP ${status}: ${text.slice(0, 200)}`);

  const json = JSON.parse(text) as {
    result?: { engine_result?: string; engine_result_message?: string };
  };

  return {
    engineResult:  json.result?.engine_result         ?? "UNKNOWN",
    engineMessage: json.result?.engine_result_message ?? "no message",
  };
}

async function isTxValidated(txHash: string, rpcUrl: string): Promise<boolean> {
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

async function pollTxValidated(
  txHash:     string,
  rpcUrl:     string,
  maxMs:      number,
  intervalMs: number
): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await isTxValidated(txHash, rpcUrl)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }
  return false;
}

// ── XrplTestnetSettlementProvider ────────────────────────────────────────────

export class XrplTestnetSettlementProvider implements SettlementProvider {
  /**
   * Executes an XRPL Testnet issued-currency Payment from the treasury/issuer
   * wallet to the withdrawal destination address.
   *
   * Contract: never throws — all errors are returned via SettlementResult.status.
   *
   * ── Flow ─────────────────────────────────────────────────────────────────
   *   1. Validate config (issuer address, seed, RPC URL, asset code).
   *   2. Log begin audit event.
   *   3. Fetch issuer account_info (Sequence, ledger index) with retry.
   *   4. Synchronously: read seed → derive Wallet(secp256k1) → sign TX → seed out of scope.
   *   5. Submit signed TX blob.
   *   6. If engine result is immediate failure (tec*, tem*, tef*, tefPAST_SEQ, etc.): return failed.
   *   7. If accepted (tes* or ter*): poll for on-ledger validation.
   *   8. Return confirmed / timeout / failed based on poll outcome.
   *
   * ── XRPL Payment TX ──────────────────────────────────────────────────────
   *   TransactionType:    "Payment"
   *   Account:            config.xrplTestnetIssuerAddress   ← treasury/issuer signs
   *   Destination:        request.destinationAddress
   *   DestinationTag:     request.destinationTag (if present)
   *   Amount.currency:    currencyToHex("RLUSD") | currencyToHex("EURQ")
   *   Amount.issuer:      config.xrplTestnetIssuerAddress   ← always testnet issuer
   *   Amount.value:       request.amountDecimal
   *   Fee:                "12" (drops)
   *   Sequence:           issuer account_info.Sequence
   *   LastLedgerSequence: ledger_current_index + 40
   *
   * Note: request.assetIssuerAddress (from the assets table) is IGNORED because
   * it may contain a mainnet issuer address. The testnet issuer from config is
   * always used instead, and a warning is logged when they differ.
   */
  async settle(request: SettlementRequest): Promise<SettlementResult> {
    try {
      return await this._settle(request);
    } catch (err: any) {
      // Should never reach here — _settle() handles all errors internally.
      // This outer catch satisfies the "never throw" contract for the edge case
      // where an unexpected exception escapes _settle().
      const msg = err?.message ?? "Unexpected internal error";
      console.error("[TreasurySettlement] Unexpected uncaught error:", msg);
      void this._audit("xrpl.treasury_settlement_failed", {
        withdrawalId: request.withdrawalId,
        assetCode:    request.assetCode,
        destination:  request.destinationAddress,
        error:        msg,
      });
      return { status: "failed", txHash: "INTERNAL_ERROR", confirmedAt: new Date(), networkFeeCostXrp: null };
    }
  }

  private async _settle(request: SettlementRequest): Promise<SettlementResult> {
    const rpcUrl        = config.xrplTestnetRpcUrl;
    const issuerAddress = config.xrplTestnetIssuerAddress;
    const issuerSeed    = config.xrplTestnetIssuerSeed;

    // ── Config validation ─────────────────────────────────────────────────────
    if (!issuerAddress || !issuerAddress.startsWith("r")) {
      const msg = "XRPL_TESTNET_ISSUER_ADDRESS is not configured or invalid.";
      console.error(`[TreasurySettlement] ${msg}`);
      void this._audit("xrpl.treasury_settlement_failed", {
        withdrawalId: request.withdrawalId, assetCode: request.assetCode,
        destination: request.destinationAddress, error: msg,
      });
      return { status: "failed", txHash: "CONFIG_ERROR", confirmedAt: new Date(), networkFeeCostXrp: null };
    }

    if (!issuerSeed || !issuerSeed.startsWith("s")) {
      const msg = "XRPL_TESTNET_ISSUER_SEED is not configured or invalid.";
      console.error(`[TreasurySettlement] ${msg}`);
      void this._audit("xrpl.treasury_settlement_failed", {
        withdrawalId: request.withdrawalId, assetCode: request.assetCode,
        destination: request.destinationAddress, error: msg,
      });
      return { status: "failed", txHash: "CONFIG_ERROR", confirmedAt: new Date(), networkFeeCostXrp: null };
    }

    try {
      assertTestnetRpc(rpcUrl);
    } catch (err: any) {
      console.error(`[TreasurySettlement] ${err.message}`);
      void this._audit("xrpl.treasury_settlement_failed", {
        withdrawalId: request.withdrawalId, assetCode: request.assetCode,
        destination: request.destinationAddress, error: err.message,
      });
      return { status: "failed", txHash: "CONFIG_ERROR", confirmedAt: new Date(), networkFeeCostXrp: null };
    }

    // ── Currency mapping ──────────────────────────────────────────────────────
    let currencyHex: string;
    if (request.assetCode === "RLUSD") {
      currencyHex = currencyToHex(config.xrplTestnetRlusdCurrency);
    } else if (request.assetCode === "EURQ") {
      currencyHex = currencyToHex(config.xrplTestnetEurqCurrency);
    } else {
      const msg = `Unsupported asset code for XRPL Testnet settlement: '${request.assetCode}'. Expected RLUSD or EURQ.`;
      console.error(`[TreasurySettlement] ${msg}`);
      void this._audit("xrpl.treasury_settlement_failed", {
        withdrawalId: request.withdrawalId, assetCode: request.assetCode,
        destination: request.destinationAddress, error: msg,
      });
      return { status: "failed", txHash: "UNSUPPORTED_ASSET", confirmedAt: new Date(), networkFeeCostXrp: null };
    }

    // ── Asset issuer override warning ─────────────────────────────────────────
    // request.assetIssuerAddress comes from the assets table (may be mainnet address).
    // We always use the testnet issuer from config.
    if (request.assetIssuerAddress && request.assetIssuerAddress !== issuerAddress) {
      console.warn(
        `[TreasurySettlement] request.assetIssuerAddress (${request.assetIssuerAddress}) ` +
        `differs from XRPL_TESTNET_ISSUER_ADDRESS (${issuerAddress}). ` +
        `This is expected on testnet — using config.xrplTestnetIssuerAddress.`
      );
    }

    // ── Audit: begin ──────────────────────────────────────────────────────────
    void this._audit("xrpl.treasury_settlement_begin", {
      withdrawalId:   request.withdrawalId,
      assetCode:      request.assetCode,
      amountDecimal:  request.amountDecimal,
      destination:    request.destinationAddress,
      destinationTag: request.destinationTag ?? null,
      issuerAddress,
    });

    // ── Fetch issuer account sequence (with transient error retry) ────────────
    let sequence: number;
    let lastLedgerSequence: number;
    try {
      const info = await withRetry(
        () => getAccountInfo(issuerAddress, rpcUrl),
        isXrplTransientError,
        ACCOUNT_INFO_RETRIES,
        ACCOUNT_INFO_DELAY_MS,
        (attempt, err) =>
          console.warn(
            `[TreasurySettlement] account_info retry (${attempt}/${ACCOUNT_INFO_RETRIES}) ` +
            `for issuer ${issuerAddress}: ${(err as Error).message}`
          )
      );
      sequence           = info.sequence;
      lastLedgerSequence = info.ledger_current_index + 40;
    } catch (err: any) {
      const isTransient = isXrplTransientError(err);
      const msg = `Failed to fetch issuer account_info after ${ACCOUNT_INFO_RETRIES} attempts: ${err.message}`;
      console.error(`[TreasurySettlement] ${msg}`);
      void this._audit("xrpl.treasury_settlement_failed", {
        withdrawalId: request.withdrawalId, assetCode: request.assetCode,
        destination: request.destinationAddress, error: msg,
        xrplUnavailable: isTransient,
      });
      return {
        status:            isTransient ? "timeout" : "failed",
        txHash:            "NO_SEQUENCE",
        confirmedAt:       new Date(),
        networkFeeCostXrp: null,
        friendlyError:     isTransient
          ? "XRPL Testnet is temporarily unavailable. Please retry later."
          : `Failed to fetch issuer account information: ${err.message}`,
      };
    }

    // ── Sign TX synchronously (seed does not cross await boundary) ────────────
    //
    // Pattern: seed is read from config, used to create Wallet + sign TX, then
    // both `seed` and `issuerWallet` fall out of scope at the end of this try block,
    // before any await calls (submitTx, pollTxValidated).
    //
    // Algorithm: ECDSA.secp256k1 — must match the algorithm used when the issuer
    // wallet was created (same as all custodial wallets in this codebase).
    let txBlob: string;
    let txHash: string;
    try {
      const seed         = issuerSeed;   // plaintext from env config (not DB-encrypted)
      const issuerWallet = Wallet.fromSeed(seed, { algorithm: ECDSA.secp256k1 });

      // Defensive address check — catches algorithm mismatch or wrong seed
      if (issuerWallet.classicAddress !== issuerAddress) {
        throw new Error(
          `Issuer address mismatch: derived=${issuerWallet.classicAddress} ` +
          `configured=${issuerAddress}. ` +
          `Verify XRPL_TESTNET_ISSUER_SEED matches XRPL_TESTNET_ISSUER_ADDRESS.`
        );
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const txSpec: any = {
        TransactionType:    "Payment",
        Account:            issuerAddress,
        Destination:        request.destinationAddress,
        Amount: {
          currency: currencyHex,
          issuer:   issuerAddress,           // issuer sends its own token
          value:    request.amountDecimal,
        },
        Fee:                String(TX_FEE_DROPS),
        Sequence:           sequence,
        LastLedgerSequence: lastLedgerSequence,
      };

      if (request.destinationTag != null) {
        txSpec.DestinationTag = request.destinationTag;
      }

      const signed = issuerWallet.sign(txSpec);
      txBlob = signed.tx_blob;
      txHash = signed.hash;
      // seed and issuerWallet fall out of scope here — GC collects them
    } catch (err: any) {
      const msg = `TX signing failed: ${err.message}`;
      console.error(`[TreasurySettlement] ${msg}`);
      void this._audit("xrpl.treasury_settlement_failed", {
        withdrawalId: request.withdrawalId, assetCode: request.assetCode,
        destination: request.destinationAddress, error: msg,
      });
      return {
        status: "failed", txHash: "SIGN_ERROR", confirmedAt: new Date(), networkFeeCostXrp: null,
        friendlyError:
          "Treasury signing failed. Contact the operator to verify XRPL Testnet treasury configuration.",
      };
    }

    // ── Submit TX ─────────────────────────────────────────────────────────────
    console.log(
      `[TreasurySettlement] Submitting ${request.assetCode} Payment ` +
      `${issuerAddress} → ${request.destinationAddress} ` +
      `amount=${request.amountDecimal} withdrawalId=${request.withdrawalId} txHash=${txHash}`
    );

    let engineResult: string;
    let engineMessage: string;
    try {
      ({ engineResult, engineMessage } = await submitTx(txBlob, rpcUrl));
    } catch (err: any) {
      const msg = `TX submit failed: ${err.message}`;
      console.error(`[TreasurySettlement] ${msg}`);
      void this._audit("xrpl.treasury_settlement_failed", {
        withdrawalId: request.withdrawalId, assetCode: request.assetCode,
        destination: request.destinationAddress, txHash, error: msg,
      });
      return {
        status: "failed", txHash, confirmedAt: new Date(), networkFeeCostXrp: null,
        friendlyError: isXrplTransientError(err)
          ? "XRPL Testnet is temporarily unavailable. Please retry later."
          : `Failed to submit transaction: ${err.message}`,
      };
    }

    console.log(`[TreasurySettlement] Submit engine_result=${engineResult} txHash=${txHash}`);

    // ── Check for immediate rejection (tec*, tem*, tef*, tefPAST_SEQ, etc.) ───
    //
    // tec* = XRPL error during transaction processing (e.g. tecNO_LINE, tecPATH_DRY)
    // tem* = malformed transaction (e.g. temBAD_AMOUNT)
    // tef* = failure before application (e.g. tefPAST_SEQ)
    // tel* = local node rejection (usually retryable — treat as transient)
    //
    // tes* = applied to ledger (includes tesSUCCESS)
    // ter* = queued / retry (e.g. terQUEUED)
    //
    // If the engine result is not tes* or ter*, the TX was rejected and won't
    // be found in the ledger — return failed immediately without polling.
    const isTelRetryable = engineResult.startsWith("tel"); // local node rejections are often transient
    if (
      !engineResult.startsWith("tes") &&
      !engineResult.startsWith("ter") &&
      !isTelRetryable
    ) {
      const friendly = friendlyXrplError(engineResult);
      console.error(
        `[TreasurySettlement] TX immediately rejected: ${engineResult} — ${engineMessage} ` +
        `txHash=${txHash} withdrawalId=${request.withdrawalId}`
      );
      void this._audit("xrpl.treasury_settlement_failed", {
        withdrawalId:  request.withdrawalId,
        assetCode:     request.assetCode,
        destination:   request.destinationAddress,
        txHash,
        error:         `${engineResult}: ${engineMessage}`,
        engineResult,
        friendlyError: friendly,
      });
      return {
        status: "failed", txHash, confirmedAt: new Date(), networkFeeCostXrp: null,
        friendlyError: friendly,
      };
    }

    // ── Poll for on-ledger validation ─────────────────────────────────────────
    console.log(
      `[TreasurySettlement] Polling for validation (up to ${POLL_MAX_MS / 1000} s)… txHash=${txHash}`
    );
    const validated = await pollTxValidated(txHash, rpcUrl, POLL_MAX_MS, POLL_INTERVAL_MS);

    if (!validated) {
      const msg =
        `Payment TX not confirmed within ${POLL_MAX_MS / 1000} s ` +
        `(txHash=${txHash}, engineResult=${engineResult}). ` +
        `The TX may still arrive — check the XRPL Testnet Explorer before retrying.`;
      console.warn(`[TreasurySettlement] ${msg}`);
      void this._audit("xrpl.treasury_settlement_timeout", {
        withdrawalId: request.withdrawalId, assetCode: request.assetCode,
        destination: request.destinationAddress, txHash, engineResult,
      });
      return {
        status: "timeout", txHash, confirmedAt: new Date(), networkFeeCostXrp: null,
        friendlyError:
          `Payment submitted (txHash: ${txHash.slice(0, 12)}…) but not confirmed within ` +
          `${POLL_MAX_MS / 1000} s. Check the XRPL Testnet Explorer — it may arrive shortly. ` +
          `If the TX appears as validated there, do not retry (double-settlement risk).`,
      };
    }

    // ── Confirmed ─────────────────────────────────────────────────────────────
    const confirmedAt = new Date();
    console.log(
      `[TreasurySettlement] Confirmed: withdrawalId=${request.withdrawalId} ` +
      `txHash=${txHash} amount=${request.amountDecimal} ${request.assetCode} ` +
      `→ ${request.destinationAddress}`
    );
    void this._audit("xrpl.treasury_settlement_confirmed", {
      withdrawalId:  request.withdrawalId,
      assetCode:     request.assetCode,
      amountDecimal: request.amountDecimal,
      destination:   request.destinationAddress,
      destinationTag: request.destinationTag ?? null,
      txHash,
      confirmedAt:   confirmedAt.toISOString(),
      networkFeeXrp: TX_FEE_XRP,
    });

    return {
      status:           "confirmed",
      txHash,
      confirmedAt,
      networkFeeCostXrp: TX_FEE_XRP,
    };
  }

  // ── Audit helper ─────────────────────────────────────────────────────────────

  private _audit(
    actionType: string,
    metadata:   Record<string, unknown>
  ): void {
    void auditLogService.log({
      actorUserId:  null,   // system action — no individual user actor for settlement
      actionType,
      entityType:   "withdrawal_requests",
      entityId:     metadata["withdrawalId"] as string ?? "unknown",
      metadata,
    });
  }
}

export const xrplTestnetSettlementProvider = new XrplTestnetSettlementProvider();
