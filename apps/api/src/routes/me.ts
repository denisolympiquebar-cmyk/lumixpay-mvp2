import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { mutationLimiter } from "../middleware/rate-limit";
import { pool } from "../db/pool";
import { User } from "../db/types";
import {
  createWalletChallenge,
  unlinkWallet,
  verifyAndLinkWallet,
} from "../services/XrplWalletLinkService";
import { custodialWalletService } from "../services/CustodialWalletService";
import { trustLineService } from "../services/TrustLineService";
import { testTokenService } from "../services/TestTokenService";
import type { DropCurrency } from "../services/TestTokenService";
import { xrplSettlementDryRunService } from "../services/XrplSettlementDryRunService";
import type { DryRunCurrency } from "../services/XrplSettlementDryRunService";
import { xrplTransactionHistoryService } from "../services/XrplTransactionHistoryService";

const router = Router();

const UsernameSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[a-z0-9_]+$/, "Username may only contain lowercase letters, digits and underscores"),
});

const WalletLinkSchema = z.object({
  challenge_id: z.string().uuid(),
  address: z.string().min(25).max(64),
  public_key: z.string().min(20).max(200),
  signature: z.string().min(20).max(400),
});

// GET /me/profile
router.get("/profile", authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query<User>(
      `SELECT id, email, full_name, role, username, created_at,
              xrpl_address, xrpl_network, xrpl_verified_at
       FROM users WHERE id = $1`,
      [req.user!.sub]
    );
    if (!rows[0]) return res.status(404).json({ error: "User not found" });
    return res.json({ profile: rows[0] });
  } catch (err) {
    console.error("GET /me/profile error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /me/username  — claim or update username
router.post("/username", authenticate, async (req, res) => {
  const parsed = UsernameSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
  }
  const { username } = parsed.data;

  try {
    // Case-insensitive uniqueness check excluding the requesting user.
    // LOWER() on both sides ensures no CI collision even if the DB were to
    // contain mixed-case entries (belt-and-suspenders alongside idx_users_username_ci).
    const { rows: existing } = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND id != $2",
      [username, req.user!.sub]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: "Username already taken" });
    }

    const { rows } = await pool.query<{ username: string }>(
      "UPDATE users SET username = $1 WHERE id = $2 RETURNING username",
      [username, req.user!.sub]
    );
    return res.json({ username: rows[0]!.username });
  } catch (err) {
    console.error("POST /me/username error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /me/wallet — custodial XRPL wallet public info (never returns seed)
router.get("/wallet", authenticate, async (req, res) => {
  try {
    const wallet = await custodialWalletService.getWallet(req.user!.sub);
    // Returns { wallet: {...} } when found, { wallet: null } when not provisioned.
    // encrypted_seed is NEVER included — getWallet() selects only public fields.
    return res.json({ wallet });
  } catch (err) {
    console.error("GET /me/wallet error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /me/wallet/fund-testnet — manually request XRPL Testnet XRP from faucet
// Safe to call multiple times: idempotent, returns already_funded if already done.
// Rate-limited to prevent faucet abuse.
router.post("/wallet/fund-testnet", authenticate, mutationLimiter, async (req, res) => {
  const userId = req.user!.sub;
  try {
    const result = await custodialWalletService.requestTestnetFunding(userId);

    switch (result.status) {
      case "funded":
        return res.json({ ok: true, status: "funded", wallet: result.wallet });

      case "already_funded":
        return res.json({ ok: true, status: "already_funded", wallet: result.wallet });

      case "disabled":
        return res.json({
          ok: true,
          status: "disabled",
          message: "Testnet auto-funding is disabled in this environment.",
        });

      case "no_wallet":
        return res.status(404).json({
          ok: false,
          error: "No active custodial wallet found for this account. Register to provision one.",
        });

      case "pending_confirmation":
        return res.status(202).json({
          ok: true,
          status: "pending_confirmation",
          message: result.message,
          txHash: result.txHash ?? null,
        });

      case "faucet_error":
        return res.status(502).json({
          ok: false,
          error: `XRPL faucet error (${result.code}): ${result.message}`,
        });

      default: {
        const _exhaustive: never = result;
        return res.status(500).json({ ok: false, error: "Unexpected funding result" });
      }
    }
  } catch (err) {
    console.error("POST /me/wallet/fund-testnet error:", err);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// POST /me/wallet/setup-trust-lines — manually establish XRPL Testnet trust lines
// Idempotent: returns already_set immediately if trust_lines_set_at is already populated.
// Requires funded_at to be set first.
// Never returns or logs the wallet seed.
router.post("/wallet/setup-trust-lines", authenticate, mutationLimiter, async (req, res) => {
  const userId = req.user!.sub;
  try {
    const result = await trustLineService.setupTrustLines(userId);

    switch (result.status) {
      case "trust_lines_set":
        return res.json({
          ok:           true,
          status:       "trust_lines_set",
          rlusdTxHash:  result.rlusdTxHash,
          eurqTxHash:   result.eurqTxHash,
          message:      "Trust lines for RLUSD (Testnet) and EURQ (Testnet) are now active on XRPL Testnet.",
        });

      case "already_set":
        return res.json({
          ok:      true,
          status:  "already_set",
          message: "Trust lines are already established.",
        });

      case "not_funded":
        return res.status(400).json({
          ok:      false,
          status:  "not_funded",
          error:   result.message,
        });

      case "config_missing":
        return res.status(503).json({
          ok:      false,
          status:  "config_missing",
          error:   result.message,
        });

      case "failed":
        return res.status(502).json({
          ok:       false,
          status:   "failed",
          currency: result.currency,
          message:  "Could not establish XRPL Testnet trust lines. Try again in a minute.",
        });

      default: {
        const _exhaustive: never = result;
        return res.status(500).json({ ok: false, error: "Unexpected trust line result" });
      }
    }
  } catch (err) {
    console.error("POST /me/wallet/setup-trust-lines error:", err);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// POST /me/wallet/request-test-token — request testnet issued token drop ──────
//
// Sends RLUSD_TEST or EURQ_TEST from the LumixPay testnet issuer wallet to
// the caller's custodial XRPL wallet via a real on-ledger Payment transaction.
//
// Requirements:
//   - Custodial wallet must be funded (funded_at set).
//   - Trust lines must be established (trust_lines_set_at set).
//   - Cooldown: one successful/pending drop per currency per configured period.
//
// TESTNET ONLY. Tokens have no real-world value.
// Does NOT affect internal LumixPay balances.
const TestTokenDropSchema = z.object({
  currency: z.enum(["RLUSD", "EURQ"]),
});

router.post("/wallet/request-test-token", authenticate, mutationLimiter, async (req, res) => {
  const parse = TestTokenDropSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ ok: false, error: "Invalid request body", details: parse.error.flatten() });
  }
  const { currency } = parse.data as { currency: DropCurrency };
  const userId = req.user!.sub;

  try {
    const result = await testTokenService.requestDrop(userId, currency);

    switch (result.status) {
      case "sent":
        return res.json({
          ok:          true,
          status:      "sent",
          currency:    result.currency,
          amount:      result.amount,
          xrplTxHash:  result.xrplTxHash,
          explorerUrl: result.explorerUrl,
          confirmedAt: result.confirmedAt,
        });

      case "already_requested_recently":
        return res.status(429).json({
          ok:                       false,
          status:                   "already_requested_recently",
          cooldownRemainingSeconds: result.cooldownRemainingSeconds,
          lastDropAt:               result.lastDropAt,
        });

      case "no_trust_lines":
        return res.status(400).json({ ok: false, status: "no_trust_lines",  message: result.message });

      case "not_funded":
        return res.status(400).json({ ok: false, status: "not_funded",      message: result.message });

      case "config_missing":
        return res.status(503).json({ ok: false, status: "config_missing",  message: result.message });

      case "disabled":
        return res.status(503).json({ ok: false, status: "disabled", message: "Test token drops are currently disabled." });

      case "xrpl_testnet_unavailable":
        return res.status(503).json({ ok: false, status: "xrpl_testnet_unavailable", message: result.message });

      case "failed":
        return res.status(502).json({
          ok:      false,
          status:  "failed",
          message: "Could not send test tokens on XRPL Testnet. Try again in a minute.",
        });

      default: {
        const _exhaustive: never = result;
        return res.status(500).json({ ok: false, error: "Unexpected result" });
      }
    }
  } catch (err) {
    console.error("POST /me/wallet/request-test-token error:", err);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// GET /me/wallet/transactions — Phase 3B XRPL on-chain transaction history ────
//
// Returns real on-chain transactions for the caller's LumixPay-managed custodial
// XRPL Testnet wallet, read via account_tx JSON-RPC.
//
// READ-ONLY: no seed access, no DB writes, no balance changes.
// Only Payment and TrustSet transactions from the configured testnet issuer
// are returned — all other transaction types are silently ignored.
//
// ?limit (optional): number of transactions (1–100, default 20).
router.get("/wallet/transactions", authenticate, async (req, res) => {
  const userId   = req.user!.sub;
  const limitRaw = parseInt(String(req.query["limit"] ?? "20"), 10);
  const limit    = Number.isNaN(limitRaw) ? 20 : Math.min(Math.max(limitRaw, 1), 100);

  try {
    const result = await xrplTransactionHistoryService.getTransactionHistory(userId, limit);

    switch (result.status) {
      case "ok":
        return res.json({
          ok:           true,
          walletAddress: result.walletAddress,
          network:      "xrpl_testnet",
          transactions: result.transactions,
        });

      case "not_funded":
        return res.status(400).json({ ok: false, status: "not_funded",  message: result.message });

      case "no_wallet":
        return res.status(404).json({ ok: false, status: "no_wallet",   message: result.message });

      case "xrpl_testnet_unavailable":
        return res.status(503).json({
          ok:      false,
          status:  "xrpl_testnet_unavailable",
          message: result.message,
        });

      case "failed":
        return res.status(502).json({
          ok:      false,
          status:  "failed",
          message: "Could not load XRPL Testnet transaction history. Try again in a minute.",
        });

      default: {
        const _exhaustive: never = result;
        return res.status(500).json({ ok: false, error: "Unexpected result" });
      }
    }
  } catch (err) {
    console.error("GET /me/wallet/transactions error:", err);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// POST /me/wallet/test-settlement — Phase 3A XRPL Settlement Dry Run ──────────
//
// Sends exactly 1 RLUSD_TEST or EURQ_TEST from the caller's LumixPay-managed
// custodial wallet to an external XRPL Testnet address.
//
// This is a developer / proof-of-concept endpoint only:
//   - Fixed amount (1 token)
//   - No internal balance changes
//   - No withdrawal rows
//   - No settlement provider changes
//   - MockSettlementProvider remains unchanged
//
// Prerequisites (enforced by the service):
//   - Wallet must be funded (funded_at set)
//   - Trust lines must be established (trust_lines_set_at set)
//   - Destination must be a valid XRPL Testnet address with a trust line for
//     the requested currency from the configured testnet issuer
const TestSettlementSchema = z.object({
  destination: z.string().min(25).max(35),
  currency:    z.enum(["RLUSD", "EURQ"]),
});

router.post("/wallet/test-settlement", authenticate, mutationLimiter, async (req, res) => {
  const parse = TestSettlementSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({
      ok:      false,
      error:   "Invalid request body",
      details: parse.error.flatten(),
    });
  }
  const { destination, currency } = parse.data as { destination: string; currency: DryRunCurrency };
  const userId = req.user!.sub;

  try {
    const result = await xrplSettlementDryRunService.sendTestPayment(userId, destination, currency);

    switch (result.status) {
      case "sent":
        return res.json({
          ok:          true,
          status:      "sent",
          txHash:      result.txHash,
          explorerUrl: result.explorerUrl,
          validatedAt: result.validatedAt,
        });

      case "invalid_destination":
      case "self_send":
      case "not_funded":
      case "no_trust_lines":
        return res.status(400).json({ ok: false, status: result.status, message: result.message });

      case "config_missing":
        return res.status(503).json({ ok: false, status: "config_missing",  message: result.message });

      case "xrpl_testnet_unavailable":
        return res.status(503).json({ ok: false, status: "xrpl_testnet_unavailable", message: result.message });

      case "failed":
        return res.status(502).json({
          ok:      false,
          status:  "failed",
          message: "XRPL Testnet dry-run payment failed. Check the destination trust line and try again.",
        });

      default: {
        const _exhaustive: never = result;
        return res.status(500).json({ ok: false, error: "Unexpected result" });
      }
    }
  } catch (err) {
    console.error("POST /me/wallet/test-settlement error:", err);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// GET /me/wallet/onchain-balances — real XRPL Testnet balances (read-only) ────
//
// Returns XRP balance, reserve info, and issued token balances (RLUSD_TEST /
// EURQ_TEST) read directly from the XRPL Testnet ledger for the caller's
// LumixPay-managed custodial wallet.
//
// READ-ONLY: no seed access, no DB writes, no internal balance changes.
// These balances are separate from the LumixPay internal ledger.
router.get("/wallet/onchain-balances", authenticate, async (req, res) => {
  const userId = req.user!.sub;
  try {
    const result = await testTokenService.getOnchainBalances(userId);

    switch (result.status) {
      case "ok":
        return res.json({
          ok:            true,
          walletAddress: result.walletAddress,
          network:       "xrpl_testnet",
          balances:      result.balances,
        });

      case "not_funded":
        return res.status(400).json({ ok: false, status: "not_funded",  message: result.message });

      case "no_wallet":
        return res.status(404).json({ ok: false, status: "no_wallet",   message: result.message });

      case "xrpl_testnet_unavailable":
        return res.status(503).json({
          ok:      false,
          status:  "xrpl_testnet_unavailable",
          message: result.message,
        });

      case "failed":
        return res.status(502).json({
          ok:      false,
          status:  "failed",
          message: "Could not read XRPL Testnet wallet balances. Try again in a minute.",
        });

      default: {
        const _exhaustive: never = result;
        return res.status(500).json({ ok: false, error: "Unexpected result" });
      }
    }
  } catch (err) {
    console.error("GET /me/wallet/onchain-balances error:", err);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// GET /me/wallet/drops — recent test token drops for the authenticated user ───
router.get("/wallet/drops", authenticate, async (req, res) => {
  const userId = req.user!.sub;
  const limitRaw = parseInt(String(req.query["limit"] ?? "10"), 10);
  const limit = Number.isNaN(limitRaw) ? 10 : Math.min(Math.max(limitRaw, 1), 50);

  try {
    const drops = await testTokenService.recentDrops(userId, limit);
    return res.json({ drops });
  } catch (err) {
    console.error("GET /me/wallet/drops error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /me/profile/wallet/challenge — begin XRPL Testnet ownership verification
router.post("/profile/wallet/challenge", authenticate, mutationLimiter, async (req, res) => {
  try {
    const out = await createWalletChallenge(req.user!.sub);
    return res.json(out);
  } catch (err: any) {
    if (err?.message === "USER_NOT_FOUND") return res.status(404).json({ error: "USER_NOT_FOUND" });
    console.error("POST /me/profile/wallet/challenge error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /me/profile/wallet — link verified XRPL Testnet address
router.patch("/profile/wallet", authenticate, mutationLimiter, async (req, res) => {
  const parsed = WalletLinkSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
  }
  try {
    await verifyAndLinkWallet(req.user!.sub, parsed.data);
    return res.json({ ok: true });
  } catch (err: any) {
    const code = err?.code ?? err?.message;
    const map: Record<string, number> = {
      XRPL_ADDRESS_INVALID: 400,
      WALLET_CHALLENGE_INVALID: 400,
      WALLET_CHALLENGE_EXPIRED: 400,
      XRPL_PUBLIC_KEY_INVALID: 400,
      XRPL_ADDRESS_KEY_MISMATCH: 400,
      XRPL_SIGNATURE_INVALID: 400,
      XRPL_ADDRESS_ALREADY_LINKED: 409,
    };
    const status = typeof code === "string" ? map[code] : undefined;
    if (status) return res.status(status).json({ error: code });
    console.error("PATCH /me/profile/wallet error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /me/profile/wallet — remove linked wallet
router.delete("/profile/wallet", authenticate, mutationLimiter, async (req, res) => {
  try {
    await unlinkWallet(req.user!.sub);
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /me/profile/wallet error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
