import { config } from "../config";
import { currencyToHex } from "./TrustLineService";
import { postJson, sleep, isXrplTransientError, withRetry, assertTestnetRpc } from "../xrpl/xrplRpc";

// ─────────────────────────────────────────────────────────────────────────────
// XrplDestinationDiagnosticsService — Phase 3D.1
//
// Checks whether a given XRPL Testnet address can receive a specific issued
// currency (RLUSD or EURQ) from the configured testnet issuer.
//
// ── ISOLATION GUARANTEES ────────────────────────────────────────────────────
//   - READ-ONLY: no DB writes, no seed access, no balance changes.
//   - Uses only account_info and account_lines RPC calls.
//   - No transaction submission or signing.
//
// ── PURPOSE ──────────────────────────────────────────────────────────────────
//   Called by the admin diagnostics endpoint before or during settlement to
//   provide clear guidance when settlement is likely to fail due to missing
//   trust lines or unfunded destination accounts.
// ─────────────────────────────────────────────────────────────────────────────

// ── Result types ──────────────────────────────────────────────────────────────

export type DiagnosticsAssetCode = "RLUSD" | "EURQ";

export interface DiagnosticsOk {
  status:               "ok";
  address:              string;
  currency:             DiagnosticsAssetCode;
  network:              "xrpl_testnet";
  accountExists:        boolean;
  xrpBalance:           string | null;
  requiredIssuer:       string;
  requiredCurrency:     string;    // "RLUSD_TEST" | "EURQ_TEST"
  hasRequiredTrustLine: boolean;
  ready:                boolean;   // accountExists && hasRequiredTrustLine
  message:              string;    // human-readable summary
}

export type DiagnosticsResult =
  | DiagnosticsOk
  | { status: "invalid_address";           message: string }
  | { status: "xrpl_testnet_unavailable";  message: string }
  | { status: "config_missing";            message: string };

function isValidXrplAddress(address: string): boolean {
  return /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address);
}

// ── XRPL RPC helpers ─────────────────────────────────────────────────────────

interface AccountInfoResult {
  exists:     boolean;
  xrpBalance: string | null;  // XRP balance as decimal string, e.g. "100.000000"
}

async function fetchAccountInfo(
  address: string,
  rpcUrl:  string
): Promise<AccountInfoResult> {
  const body = JSON.stringify({
    method: "account_info",
    params: [{ account: address, ledger_index: "validated", strict: true }],
  });
  const { status, text } = await postJson(rpcUrl, body, 10_000);
  if (status !== 200) throw new Error(`account_info HTTP ${status}`);

  const json = JSON.parse(text) as {
    result?: {
      status?:       string;
      error?:        string;
      account_data?: { Account?: string; Balance?: string };
    };
  };

  if (json.result?.status !== "success") {
    const err = json.result?.error ?? "unknown";
    // actNotFound = account doesn't exist yet (not an error for diagnostics)
    if (err === "actNotFound") return { exists: false, xrpBalance: null };
    throw new Error(`account_info error: ${err}`);
  }

  const balanceDrops = json.result?.account_data?.Balance;
  const xrpBalance   = balanceDrops != null
    ? (parseInt(balanceDrops, 10) / 1_000_000).toFixed(6)
    : null;

  return { exists: true, xrpBalance };
}

interface TrustLineEntry {
  account:  string;  // peer (issuer) address
  currency: string;  // 20-byte hex or 3-char ISO
  balance:  string;
  limit:    string;
}

async function fetchAccountLines(
  address: string,
  rpcUrl:  string
): Promise<TrustLineEntry[]> {
  const body = JSON.stringify({
    method: "account_lines",
    params: [{ account: address, ledger_index: "validated" }],
  });
  const { status, text } = await postJson(rpcUrl, body, 10_000);
  if (status !== 200) throw new Error(`account_lines HTTP ${status}`);

  const json = JSON.parse(text) as {
    result?: {
      status?: string;
      error?:  string;
      lines?:  TrustLineEntry[];
    };
  };

  if (json.result?.status !== "success") {
    const err = json.result?.error ?? "unknown";
    if (err === "actNotFound") return []; // account doesn't exist → no lines
    throw new Error(`account_lines error: ${err}`);
  }

  return json.result?.lines ?? [];
}

// ── XrplDestinationDiagnosticsService ────────────────────────────────────────

export class XrplDestinationDiagnosticsService {
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
  async checkDestination(
    address:   string,
    assetCode: DiagnosticsAssetCode
  ): Promise<DiagnosticsResult> {
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

    // ── Address format validation ─────────────────────────────────────────────
    if (!isValidXrplAddress(address)) {
      return {
        status:  "invalid_address",
        message: `"${address}" is not a valid XRPL classic address.`,
      };
    }

    // ── Currency mapping ──────────────────────────────────────────────────────
    const currencyCode = assetCode === "RLUSD"
      ? config.xrplTestnetRlusdCurrency
      : config.xrplTestnetEurqCurrency;
    const currencyHex      = currencyToHex(currencyCode).toUpperCase();
    const currencyLabel    = `${currencyCode}_TEST`;

    // ── Fetch account_info (with retry for transient errors) ──────────────────
    let accountInfo: AccountInfoResult;
    try {
      accountInfo = await withRetry(
        () => fetchAccountInfo(address, rpcUrl),
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
        message: `Failed to check destination account: ${err.message}`,
      };
    }

    // ── If account doesn't exist, skip account_lines (would error) ────────────
    if (!accountInfo.exists) {
      return {
        status:               "ok",
        address,
        currency:             assetCode,
        network:              "xrpl_testnet",
        accountExists:        false,
        xrpBalance:           null,
        requiredIssuer:       issuerAddress,
        requiredCurrency:     currencyLabel,
        hasRequiredTrustLine: false,
        ready:                false,
        message:
          `Destination account ${address} does not exist on XRPL Testnet. ` +
          `The account must be funded with XRP before it can receive issued tokens.`,
      };
    }

    // ── Fetch trust lines ─────────────────────────────────────────────────────
    let lines: TrustLineEntry[];
    try {
      lines = await withRetry(
        () => fetchAccountLines(address, rpcUrl),
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
        message: `Failed to check trust lines: ${err.message}`,
      };
    }

    // ── Check for matching trust line ─────────────────────────────────────────
    // A trust line matches when:
    //   line.account === issuerAddress (the peer is the configured issuer)
    //   AND line.currency === currencyHex (20-byte padded hex)
    //   AND parseFloat(line.limit) > 0 (limit must be non-zero to receive tokens)
    const hasTrustLine = lines.some(
      (line) =>
        line.account.toUpperCase()  === issuerAddress.toUpperCase() &&
        line.currency.toUpperCase() === currencyHex &&
        parseFloat(line.limit) > 0
    );

    const ready = hasTrustLine; // account exists AND trust line present

    let message: string;
    if (ready) {
      message =
        `Destination is ready for XRPL Testnet settlement. ` +
        `Account exists with ${accountInfo.xrpBalance ?? "?"} XRP and has a ` +
        `trust line for ${currencyLabel} from the configured issuer.`;
    } else {
      message =
        `Destination account exists (${accountInfo.xrpBalance ?? "?"} XRP) but ` +
        `does not have a trust line for ${currencyLabel} from the configured issuer ` +
        `(${issuerAddress.slice(0, 8)}…). ` +
        `Ask the recipient to add a trust line before settlement.`;
    }

    return {
      status:               "ok",
      address,
      currency:             assetCode,
      network:              "xrpl_testnet",
      accountExists:        true,
      xrpBalance:           accountInfo.xrpBalance,
      requiredIssuer:       issuerAddress,
      requiredCurrency:     currencyLabel,
      hasRequiredTrustLine: hasTrustLine,
      ready,
      message,
    };
  }
}

export const xrplDestinationDiagnosticsService = new XrplDestinationDiagnosticsService();
