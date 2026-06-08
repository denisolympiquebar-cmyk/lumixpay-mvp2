import { PoolClient } from "pg";
import { generateSeed, deriveKeypair, deriveAddress } from "ripple-keypairs";
import { pool } from "../db/pool";
import { config } from "../config";
import { WalletEncryptionService } from "./WalletEncryptionService";
import { auditLogService } from "./AuditLogService";
import { postJson, sleep } from "../xrpl/xrplRpc";

// ─────────────────────────────────────────────────────────────────────────────
// CustodialWalletService — Phase 1 (testnet only)
//
// Manages embedded custodial XRPL Testnet wallets.
// LumixPay generates the wallet and stores an AES-256-GCM encrypted seed.
// The user sees only the public classic_address via GET /me/wallet.
//
// ── SECURITY CONTRACT ────────────────────────────────────────────────────────
//   - provision():     generates seed in memory, encrypts immediately, inserts.
//                      Plaintext seed is never written to disk, DB, or logs.
//   - getWallet():     never returns encrypted_seed — only public fields.
//   - decryptSeed():   must only be called by internal settlement services.
//                      Every call is audit-logged.
//                      Never log the return value.
//
// ── TESTNET WARNING ──────────────────────────────────────────────────────────
//   All wallets are created on XRPL Testnet. Do NOT send real funds.
// ─────────────────────────────────────────────────────────────────────────────

// ── Faucet funding result ─────────────────────────────────────────────────────

export type FundingResult =
  | { status: "funded";               wallet: CustodialWalletPublic; txHash?: string }
  | { status: "already_funded";        wallet: CustodialWalletPublic }
  | { status: "pending_confirmation";  message: string; txHash?: string }
  | { status: "no_wallet" }
  | { status: "disabled" }
  | { status: "faucet_error";          code: string; message: string };

// ── XRPL on-ledger verification helpers ──────────────────────────────────────
// postJson and sleep are imported from xrplRpc.ts

/**
 * Calls account_info on the XRPL JSON-RPC endpoint.
 * Returns true if the account exists on-ledger (status === "success").
 * Returns false for actNotFound, network errors, or any other failure.
 * Never throws — all errors are swallowed and logged.
 */
async function verifyXrplAccount(address: string, rpcUrl: string): Promise<boolean> {
  try {
    const body = JSON.stringify({
      method: "account_info",
      params: [{ account: address, ledger_index: "current", strict: true }],
    });
    const { status, text } = await postJson(rpcUrl, body, 8_000);
    if (status !== 200) return false;

    const json = JSON.parse(text) as {
      result?: { status?: string; account_data?: { Account?: string }; error?: string };
    };
    return (
      json.result?.status === "success" &&
      json.result?.account_data?.Account === address
    );
  } catch (err: any) {
    console.warn(`[CustodialWallet] verifyXrplAccount(${address}) error: ${err.message}`);
    return false;
  }
}

/**
 * Polls XRPL Testnet until the account appears on-ledger or the deadline is reached.
 * Returns true if confirmed, false if not confirmed within maxMs.
 */
async function pollXrplAccount(
  address: string,
  rpcUrl: string,
  maxMs: number,
  intervalMs: number
): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await verifyXrplAccount(address, rpcUrl)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────

export interface CustodialWalletPublic {
  id: string;
  network: string;
  classic_address: string;
  public_key: string;
  wallet_type: string;
  is_active: boolean;
  funded_at: Date | null;
  trust_lines_set_at: Date | null;
  created_at: Date;
}

// ── Lazy singleton encryption service ────────────────────────────────────────
// Initialised on first use so start-up failures are non-fatal in development.

let _enc: WalletEncryptionService | null = null;
let _encInit = false;

function getEncryptionService(): WalletEncryptionService | null {
  if (_encInit) return _enc;
  _encInit = true;

  const key = config.walletMasterKey;
  const keyId = config.walletEncryptionKeyId;

  if (!key) {
    if (config.nodeEnv === "production") {
      console.error(
        "[CustodialWallet] FATAL: WALLET_MASTER_KEY is required in production. " +
        "Set it via: fly secrets set WALLET_MASTER_KEY=<32-byte-base64url>"
      );
    } else {
      console.warn(
        "[CustodialWallet] WALLET_MASTER_KEY is not set — custodial wallet " +
        "provisioning is DISABLED. Set it to enable wallet creation on signup."
      );
    }
    return null;
  }

  try {
    _enc = new WalletEncryptionService(key, keyId);
    console.log(`[CustodialWallet] Encryption service ready (keyId=${keyId})`);
    return _enc;
  } catch (err: any) {
    console.error("[CustodialWallet] Failed to initialise WalletEncryptionService:", err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export class CustodialWalletService {
  /**
   * Generates a new XRPL Testnet wallet for `userId` and persists the encrypted
   * seed inside the caller's open DB transaction.
   *
   * Must be called INSIDE a BEGIN ... COMMIT block so that a registration
   * failure rolls back the wallet row together with the user row.
   *
   * Returns the public wallet fields on success.
   * Returns null in development when WALLET_MASTER_KEY is not set (skips silently).
   * Throws in production when WALLET_MASTER_KEY is not set.
   */
  async provision(
    userId: string,
    client: PoolClient
  ): Promise<CustodialWalletPublic | null> {
    const enc = getEncryptionService();

    if (!enc) {
      if (config.nodeEnv === "production") {
        throw new Error(
          "Custodial wallet provisioning failed: WALLET_MASTER_KEY is not configured. " +
          "Registration cannot complete without a valid encryption key in production."
        );
      }
      // Development: allow registration to succeed without a wallet
      console.warn(
        `[CustodialWallet] Skipping wallet provisioning for user ${userId} ` +
        "(WALLET_MASTER_KEY not set — development mode only)"
      );
      return null;
    }

    // Generate wallet using ripple-keypairs (already a dependency)
    // generateSeed() uses crypto.randomBytes internally — cryptographically secure
    const seed      = generateSeed();               // s... family seed
    const { publicKey } = deriveKeypair(seed);      // hex public key
    const classicAddress = deriveAddress(publicKey); // r... classic address

    // Encrypt immediately — plaintext seed must not leave this scope unencrypted
    const encryptedSeed = enc.encrypt(seed);

    // seed and derived private key are now out of scope after this point
    // (JS GC will collect them; no explicit zeroing since Buffer/string are immutable)

    const { rows } = await client.query<CustodialWalletPublic>(
      `INSERT INTO user_wallets
         (user_id, network, classic_address, public_key, encrypted_seed,
          encryption_key_id, wallet_type, is_active)
       VALUES ($1, 'xrpl_testnet', $2, $3, $4, $5, 'custodial', true)
       RETURNING id, network, classic_address, public_key, wallet_type,
                 is_active, funded_at, created_at`,
      [
        userId,
        classicAddress,
        publicKey,
        encryptedSeed,
        config.walletEncryptionKeyId,
      ]
    );

    return rows[0]!;
  }

  /**
   * Returns public custodial wallet fields for `userId`.
   * Never includes encrypted_seed — that column is excluded by the SELECT.
   * Returns null if the user has no active custodial wallet (e.g. old account
   * created before Phase 1, or provisioning was skipped in dev).
   */
  async getWallet(userId: string): Promise<CustodialWalletPublic | null> {
    const { rows } = await pool.query<CustodialWalletPublic>(
      `SELECT id, network, classic_address, public_key,
              wallet_type, is_active, funded_at, trust_lines_set_at, created_at
         FROM user_wallets
        WHERE user_id = $1
          AND wallet_type = 'custodial'
          AND is_active   = true
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId]
    );
    return rows[0] ?? null;
  }

  /**
   * Requests XRPL Testnet XRP from the official faucet for `userId`'s
   * custodial wallet, then verifies the account exists on-ledger before
   * setting funded_at. Safe to call fire-and-forget after registration commits.
   *
   * ── Flow ─────────────────────────────────────────────────────────────────
   *   1. Pre-check:  call account_info — if already on-ledger, set funded_at + return.
   *   2. Faucet:     POST { "destination": address } to faucet.altnet.rippletest.net.
   *   3. Poll:       retry account_info every 2 s for up to 30 s.
   *      a. Confirmed → UPDATE funded_at = NOW() → return "funded".
   *      b. Timeout   → return "pending_confirmation" (funded_at left NULL).
   *
   * ── Safety guarantees ─────────────────────────────────────────────────────
   *   - funded_at is set ONLY after account_info returns status=success.
   *   - Never creates a new wallet or modifies the encrypted seed.
   *   - Is idempotent: if funded_at is already set, returns "already_funded".
   *   - If XRPL_AUTO_FUND_CUSTODIAL_WALLETS=false, returns "disabled".
   */
  async requestTestnetFunding(userId: string): Promise<FundingResult> {
    if (!config.xrplAutoFundCustodialWallets) {
      console.info(
        `[CustodialWallet] Auto-funding disabled (XRPL_AUTO_FUND_CUSTODIAL_WALLETS=false). ` +
        `User ${userId} wallet will remain unfunded.`
      );
      return { status: "disabled" };
    }

    const wallet = await this.getWallet(userId);
    if (!wallet) {
      console.warn(`[CustodialWallet] requestTestnetFunding: no active wallet for user ${userId}`);
      return { status: "no_wallet" };
    }

    if (wallet.funded_at !== null) {
      return { status: "already_funded", wallet };
    }

    const address  = wallet.classic_address;
    const rpcUrl   = config.xrplTestnetRpcUrl;
    const faucetUrl = config.xrplTestnetFaucetUrl;

    // ── Step 1: Pre-check ────────────────────────────────────────────────────
    // The faucet may have been called previously (e.g. auto-funding ran, timed out,
    // then the user manually retries). Check if the account is already on-ledger
    // before hitting the faucet again (which has rate limits).
    const alreadyOnLedger = await verifyXrplAccount(address, rpcUrl);
    if (alreadyOnLedger) {
      console.log(`[CustodialWallet] ${address} already on XRPL Testnet — setting funded_at without calling faucet`);
      await this._setFundedAt(userId);

      if (config.xrplAutoSetupTrustLines) {
        void (async () => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { trustLineService } = require("./TrustLineService") as typeof import("./TrustLineService");
            const r = await trustLineService.setupTrustLines(userId);
            console.log(`[CustodialWallet] Trust line setup for user ${userId}: ${r.status}`);
          } catch (err: unknown) {
            console.error(
              `[CustodialWallet] Trust line setup error for user ${userId}:`,
              (err as Error).message ?? err
            );
          }
        })();
      }

      return { status: "funded", wallet: (await this.getWallet(userId)) ?? wallet };
    }

    // ── Step 2: Call faucet ──────────────────────────────────────────────────
    console.log(`[CustodialWallet] Requesting testnet XRP from ${faucetUrl} for ${address}`);

    let txHash: string | undefined;
    try {
      const { status: httpStatus, text } = await postJson(
        faucetUrl,
        JSON.stringify({ destination: address }),
        20_000
      );

      if (httpStatus < 200 || httpStatus >= 300) {
        console.error(`[CustodialWallet] Faucet HTTP ${httpStatus} for ${address}: ${text.slice(0, 300)}`);
        return { status: "faucet_error", code: `HTTP_${httpStatus}`, message: text.slice(0, 200) };
      }

      // Extract txHash from faucet response for logging (never stored in DB)
      try {
        const parsed = JSON.parse(text) as { transactionHash?: string };
        txHash = parsed.transactionHash;
      } catch { /* response not JSON-parseable — ignore */ }

      console.log(
        `[CustodialWallet] Faucet accepted for ${address} (HTTP ${httpStatus})` +
        (txHash ? ` txHash=${txHash}` : "")
      );
    } catch (err: any) {
      const msg = (err as Error).message ?? "Network error";
      console.error(`[CustodialWallet] Faucet network error for ${address}:`, msg);
      return { status: "faucet_error", code: "NETWORK_ERROR", message: msg };
    }

    // ── Step 3: Poll XRPL Testnet for on-ledger confirmation ─────────────────
    // Retry account_info every 2 s for up to 30 s.
    // funded_at is NOT touched until this confirms.
    console.log(`[CustodialWallet] Polling XRPL Testnet for ${address} (up to 30 s, every 2 s)…`);

    const confirmed = await pollXrplAccount(address, rpcUrl, 30_000, 2_000);

    if (!confirmed) {
      console.warn(
        `[CustodialWallet] ${address} not confirmed on XRPL Testnet after 30 s. ` +
        `funded_at left NULL. txHash=${txHash ?? "unknown"}`
      );
      return {
        status:  "pending_confirmation",
        message: "Faucet request was accepted, but the account was not confirmed on XRPL Testnet yet. " +
                 "Try the 'Fund testnet wallet' button again in a minute.",
        txHash,
      };
    }

    // ── Step 4: Confirmed — set funded_at ────────────────────────────────────
    console.log(`[CustodialWallet] ${address} confirmed on XRPL Testnet. Setting funded_at. txHash=${txHash ?? "unknown"}`);
    await this._setFundedAt(userId);

    // ── Step 5: Fire-and-forget trust line setup ──────────────────────────────
    // Lazy require() breaks the CustodialWalletService ↔ TrustLineService
    // circular import. By call time, both modules are fully initialised.
    if (config.xrplAutoSetupTrustLines) {
      void (async () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { trustLineService } = require("./TrustLineService") as typeof import("./TrustLineService");
          const r = await trustLineService.setupTrustLines(userId);
          console.log(`[CustodialWallet] Trust line setup for user ${userId}: ${r.status}`);
        } catch (err: unknown) {
          console.error(
            `[CustodialWallet] Trust line setup error for user ${userId}:`,
            (err as Error).message ?? err
          );
        }
      })();
    }

    return { status: "funded", wallet: (await this.getWallet(userId)) ?? wallet, txHash };
  }

  /** Internal helper: atomically set funded_at = NOW() for active unfunded wallet. */
  private async _setFundedAt(userId: string): Promise<void> {
    await pool.query(
      `UPDATE user_wallets
          SET funded_at = NOW()
        WHERE user_id     = $1
          AND wallet_type = 'custodial'
          AND is_active   = true
          AND funded_at IS NULL`,
      [userId]
    );
  }

  /**
   * Decrypts and returns the plaintext seed for `userId`'s custodial wallet.
   *
   * ── DO NOT CALL FROM HTTP ROUTE HANDLERS ─────────────────────────────────
   * This method is reserved for internal settlement / signing services only.
   * Every call is written to audit_logs for traceability.
   *
   * Phase 1: implemented but not yet called by any route.
   * Phase 2: called by XrplSettlementService to sign on-chain transactions.
   *
   * NEVER log, expose in API responses, or store the return value.
   */
  async decryptSeed(userId: string, reason: string): Promise<string> {
    const enc = getEncryptionService();
    if (!enc) {
      throw new Error(
        "CustodialWalletService.decryptSeed: encryption service is not configured."
      );
    }

    const { rows } = await pool.query<{ id: string; encrypted_seed: string }>(
      `SELECT id, encrypted_seed
         FROM user_wallets
        WHERE user_id   = $1
          AND wallet_type = 'custodial'
          AND is_active   = true
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId]
    );

    if (!rows[0]) {
      throw new Error(
        `CustodialWalletService.decryptSeed: no active custodial wallet found for user ${userId}`
      );
    }

    // Audit every decryption — must be fire-and-forget so a log failure
    // does not block the settlement critical path.
    void auditLogService.log({
      actorUserId: userId,
      actionType:  "wallet.seed_decrypt",
      entityType:  "user_wallets",
      entityId:    rows[0].id,
      metadata:    { reason, user_id: userId },
    });

    // decrypt() throws if the auth tag check fails (tampered data / wrong key)
    return enc.decrypt(rows[0].encrypted_seed);
  }
}

export const custodialWalletService = new CustodialWalletService();
