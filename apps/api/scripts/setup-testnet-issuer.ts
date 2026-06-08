/**
 * setup-testnet-issuer.ts
 *
 * One-time (idempotent) script that enables DefaultRipple on the XRPL Testnet
 * issuer wallet configured in XRPL_TESTNET_ISSUER_ADDRESS / XRPL_TESTNET_ISSUER_SEED.
 *
 * DefaultRipple (asfDefaultRipple, SetFlag=8) is required so that trust-line
 * holders can ripple payments through the issuer. Without it, the issuer cannot
 * settle issued-currency payments between users.
 *
 * Usage (from apps/api/):
 *   npm run xrpl:setup-issuer
 *
 * Prerequisites:
 *   1. XRPL_TESTNET_ISSUER_ADDRESS set in .env
 *   2. XRPL_TESTNET_ISSUER_SEED  set in .env  (never committed to git)
 *   3. Issuer address funded on XRPL Testnet (use https://faucet.altnet.rippletest.net)
 *
 * Safe to re-run — setting a flag that is already set returns tesSUCCESS.
 * This script never prints the issuer seed.
 */

import http from "http";
import https from "https";
import path from "path";
import dotenv from "dotenv";
import { Wallet, ECDSA } from "xrpl";

// Load .env from repo root (2 levels up from apps/api/scripts/)
dotenv.config({ path: path.resolve(__dirname, "../../..", ".env") });
// Fallback: also try apps/api/.env
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

// ── Config ────────────────────────────────────────────────────────────────────

const ISSUER_ADDRESS = process.env["XRPL_TESTNET_ISSUER_ADDRESS"] ?? "";
const ISSUER_SEED    = process.env["XRPL_TESTNET_ISSUER_SEED"]    ?? "";
const RPC_URL        = process.env["XRPL_TESTNET_RPC_URL"]        ?? "http://s.altnet.rippletest.net:51234";

// ── Validation ────────────────────────────────────────────────────────────────

if (!ISSUER_ADDRESS || !ISSUER_ADDRESS.startsWith("r")) {
  console.error("[setup-issuer] ERROR: XRPL_TESTNET_ISSUER_ADDRESS is not set or invalid.");
  console.error("  Set it in .env or as an environment variable before running this script.");
  process.exit(1);
}

if (!ISSUER_SEED) {
  console.error("[setup-issuer] ERROR: XRPL_TESTNET_ISSUER_SEED is not set.");
  console.error("  Set it in .env (never commit this value to git).");
  process.exit(1);
}

const rpcLower = RPC_URL.toLowerCase();
if (!rpcLower.includes("altnet") && !rpcLower.includes("rippletest")) {
  console.error(
    `[setup-issuer] SAFETY GUARD: RPC_URL (${RPC_URL}) does not look like XRPL Testnet.`
  );
  console.error("  Must contain 'altnet' or 'rippletest'. Refusing to run against mainnet.");
  process.exit(1);
}

// ── HTTP utility ──────────────────────────────────────────────────────────────

function postJson(
  url: string,
  body: string,
  timeoutMs = 20_000
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const parsed    = new URL(url);
    const isHttps   = parsed.protocol === "https:";
    const transport = isHttps ? https : http;
    const port      = parsed.port || (isHttps ? 443 : 80);
    const bodyBuf   = Buffer.from(body, "utf8");

    const req = transport.request(
      {
        hostname: parsed.hostname,
        port,
        path:     parsed.pathname + parsed.search,
        method:   "POST",
        headers:  {
          "Content-Type":   "application/json",
          "Content-Length": bodyBuf.length,
          "User-Agent":     "LumixPay-SetupScript/1.0",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end",  () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") })
        );
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timed out: ${url}`)));
    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── XRPL helpers ──────────────────────────────────────────────────────────────

async function getAccountInfo(address: string): Promise<{ sequence: number; ledger_current_index: number; flags: number }> {
  const body = JSON.stringify({
    method: "account_info",
    params: [{ account: address, ledger_index: "current", strict: true }],
  });
  const { status, text } = await postJson(RPC_URL, body, 10_000);
  if (status !== 200) throw new Error(`account_info HTTP ${status}: ${text.slice(0, 200)}`);

  const json = JSON.parse(text) as {
    result?: {
      status?: string;
      account_data?: { Sequence?: number; Flags?: number };
      ledger_current_index?: number;
      error?: string;
    };
  };

  if (json.result?.status !== "success" || !json.result?.account_data) {
    throw new Error(`account_info failed: ${json.result?.error ?? "unknown error"}`);
  }

  return {
    sequence:             json.result.account_data.Sequence ?? 1,
    ledger_current_index: json.result.ledger_current_index  ?? 0,
    flags:                json.result.account_data.Flags    ?? 0,
  };
}

async function isTxValidated(txHash: string): Promise<boolean> {
  try {
    const body = JSON.stringify({
      method: "tx",
      params: [{ transaction: txHash, binary: false }],
    });
    const { status, text } = await postJson(RPC_URL, body, 8_000);
    if (status !== 200) return false;
    const json = JSON.parse(text) as {
      result?: { validated?: boolean; meta?: { TransactionResult?: string } };
    };
    return (
      json.result?.validated === true &&
      json.result?.meta?.TransactionResult === "tesSUCCESS"
    );
  } catch {
    return false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("[setup-issuer] ──────────────────────────────────────────────────");
  console.log("[setup-issuer] LumixPay XRPL Testnet Issuer Setup");
  console.log(`[setup-issuer] RPC URL       : ${RPC_URL}`);
  console.log(`[setup-issuer] Issuer address: ${ISSUER_ADDRESS}`);
  console.log("[setup-issuer] ──────────────────────────────────────────────────");

  // 1. Fetch account info
  console.log("[setup-issuer] Fetching account info…");
  let accountInfo: { sequence: number; ledger_current_index: number; flags: number };
  try {
    accountInfo = await getAccountInfo(ISSUER_ADDRESS);
  } catch (err: any) {
    console.error(`[setup-issuer] ERROR: ${err.message}`);
    console.error("  Is the issuer address funded? Use https://faucet.altnet.rippletest.net");
    process.exit(1);
  }

  const { sequence, ledger_current_index, flags } = accountInfo;
  const DEFAULT_RIPPLE_FLAG = 0x00800000; // asfDefaultRipple bit in account Flags field
  const alreadySet = (flags & DEFAULT_RIPPLE_FLAG) !== 0;

  console.log(`[setup-issuer] Sequence         : ${sequence}`);
  console.log(`[setup-issuer] Current ledger   : ${ledger_current_index}`);
  console.log(`[setup-issuer] DefaultRipple set: ${alreadySet}`);

  if (alreadySet) {
    console.log("[setup-issuer] ✅ DefaultRipple is already enabled. Nothing to do.");
    console.log("[setup-issuer] (Safe to re-run — no transaction submitted)");
    process.exit(0);
  }

  // 2. Build and sign AccountSet transaction
  console.log("[setup-issuer] DefaultRipple not set. Building AccountSet transaction…");

  // MUST specify ecdsa-secp256k1: issuer seeds are generated via ripple-keypairs
  // (secp256k1). xrpl v4 DEFAULT_ALGORITHM is ed25519 and would derive a different
  // address from the same seed, causing tecBAD_AUTH on submission.
  const issuerWallet = Wallet.fromSeed(ISSUER_SEED, { algorithm: ECDSA.secp256k1 });

  if (issuerWallet.classicAddress !== ISSUER_ADDRESS) {
    console.error(
      `[setup-issuer] ERROR: Derived address (${issuerWallet.classicAddress}) ` +
      `does not match XRPL_TESTNET_ISSUER_ADDRESS (${ISSUER_ADDRESS}).`
    );
    console.error("  Check that XRPL_TESTNET_ISSUER_SEED matches XRPL_TESTNET_ISSUER_ADDRESS.");
    process.exit(1);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signed = issuerWallet.sign({
    TransactionType: "AccountSet",
    Account:         ISSUER_ADDRESS,
    SetFlag:         8, // asfDefaultRipple
    Fee:             "12",
    Sequence:        sequence,
    LastLedgerSequence: ledger_current_index + 40,
  } as any);

  console.log(`[setup-issuer] Signed. TX hash: ${signed.hash}`);

  // 3. Submit
  console.log("[setup-issuer] Submitting to XRPL Testnet…");
  const submitBody = JSON.stringify({
    method: "submit",
    params: [{ tx_blob: signed.tx_blob }],
  });
  const { status: httpStatus, text: responseText } = await postJson(RPC_URL, submitBody, 15_000);

  if (httpStatus !== 200) {
    console.error(`[setup-issuer] ERROR: Submit HTTP ${httpStatus}: ${responseText.slice(0, 300)}`);
    process.exit(1);
  }

  const submitResult = JSON.parse(responseText) as {
    result?: { engine_result?: string; engine_result_message?: string };
  };

  const engineResult = submitResult.result?.engine_result ?? "UNKNOWN";
  console.log(`[setup-issuer] Engine result: ${engineResult} — ${submitResult.result?.engine_result_message ?? ""}`);

  if (!engineResult.startsWith("tes") && !engineResult.startsWith("ter")) {
    console.error(`[setup-issuer] ERROR: Transaction rejected (${engineResult}).`);
    process.exit(1);
  }

  // 4. Poll for validation
  console.log("[setup-issuer] Polling for on-ledger validation (up to 60 s)…");
  const deadline = Date.now() + 60_000;
  let validated  = false;
  while (Date.now() < deadline) {
    validated = await isTxValidated(signed.hash);
    if (validated) break;
    process.stdout.write(".");
    await sleep(2_000);
  }
  process.stdout.write("\n");

  if (!validated) {
    console.warn("[setup-issuer] ⚠️  Transaction not confirmed within 60 s.");
    console.warn(`  TX hash: ${signed.hash}`);
    console.warn("  It may still succeed. Check the explorer: https://testnet.xrpl.org/transactions/" + signed.hash);
    process.exit(0);
  }

  console.log("[setup-issuer] ──────────────────────────────────────────────────");
  console.log("[setup-issuer] ✅ SUCCESS: DefaultRipple enabled on issuer wallet.");
  console.log(`[setup-issuer] TX hash: ${signed.hash}`);
  console.log(`[setup-issuer] Explorer: https://testnet.xrpl.org/transactions/${signed.hash}`);
  console.log("[setup-issuer] ──────────────────────────────────────────────────");
  console.log("[setup-issuer] Next steps:");
  console.log("  1. Set XRPL_TESTNET_ISSUER_ADDRESS and XRPL_TESTNET_ISSUER_SEED in .env");
  console.log("  2. Set XRPL_AUTO_SETUP_TRUST_LINES=true (enabled by default)");
  console.log("  3. New users will get trust lines automatically after wallet funding.");
  console.log("  4. Existing funded users can call POST /me/wallet/setup-trust-lines manually.");
}

main().catch((err: unknown) => {
  console.error("[setup-issuer] Unhandled error:", (err as Error).message ?? err);
  process.exit(1);
});
