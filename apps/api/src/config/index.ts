import dotenv from "dotenv";
import path from "path";

// Uvijek učitaj .env iz repo root-a (2 nivoa iznad src/)
dotenv.config({ path: path.resolve(process.cwd(), "../..", ".env") });

function require_env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const config = {
  port: parseInt(process.env["PORT"] ?? "4000", 10),
  nodeEnv: process.env["NODE_ENV"] ?? "development",

  db: {
    connectionString:
      process.env["DATABASE_URL"] ??
      `postgresql://${process.env["POSTGRES_USER"] ?? "lumixpay"}:${process.env["POSTGRES_PASSWORD"] ?? "lumixpay_secret"}@${process.env["POSTGRES_HOST"] ?? "localhost"}:${process.env["POSTGRES_PORT"] ?? "5432"}/${process.env["POSTGRES_DB"] ?? "lumixpay"}`,
  },

  jwt: {
    secret: process.env["JWT_SECRET"] ?? "change_this_secret",
    expiresIn: process.env["JWT_EXPIRES_IN"] ?? "24h",
  },
  refreshToken: {
    // Architecture placeholder for Phase 2 token refresh rollout.
    // Not used for auth decisions yet (non-breaking).
    enabled: (process.env["REFRESH_TOKEN_ENABLED"] ?? "false").toLowerCase() === "true",
    expiresIn: process.env["REFRESH_TOKEN_EXPIRES_IN"] ?? "30d",
  },

  fee: {
    rate: parseFloat(process.env["PLATFORM_FEE_RATE"] ?? "0.01"),
  },

  treasurySafety: {
    // Alert when remaining inventory falls below this ratio of max_supply.
    depletionWarnRatio: parseFloat(process.env["TREASURY_DEPLETION_WARN_RATIO"] ?? "0.10"),
  },

  // ── XRPL Testnet faucet + RPC ─────────────────────────────────────────────
  // Faucet: POST { "destination": "r..." } to fund an existing address.
  // RPC:    JSON-RPC HTTP endpoint for account_info verification.
  //         Confirmed working on http://s.altnet.rippletest.net:51234 (plain HTTP, port 51234).
  // Set XRPL_AUTO_FUND_CUSTODIAL_WALLETS=false to disable automatic funding on signup.
  xrplTestnetFaucetUrl:          process.env["XRPL_TESTNET_FAUCET_URL"] ?? "https://faucet.altnet.rippletest.net/accounts",
  xrplTestnetRpcUrl:             process.env["XRPL_TESTNET_RPC_URL"]    ?? "http://s.altnet.rippletest.net:51234",
  xrplAutoFundCustodialWallets:  process.env["XRPL_AUTO_FUND_CUSTODIAL_WALLETS"] !== "false",

  // ── XRPL Testnet issued currency / trust lines (Phase 2B) ────────────────
  // ONE issuer wallet issues both RLUSD_TEST and EURQ_TEST on XRPL Testnet.
  //
  // TESTNET ONLY — these are test tokens with no real-world value.
  // NEVER use mainnet RLUSD/EURQ issuers here.
  //
  // Safety guards (enforced at runtime by TrustLineService):
  //   1. XRPL_TESTNET_ISSUER_ADDRESS must start with 'r'
  //   2. XRPL_TESTNET_RPC_URL must contain 'altnet' or 'rippletest'
  //
  // How to create the issuer wallet:
  //   node -e "const k=require('ripple-keypairs');const s=k.generateSeed();
  //            const {publicKey}=k.deriveKeypair(s);
  //            const a=k.deriveAddress(publicKey);
  //            console.log('address:',a,'\\nseed:',s)"
  // Then fund it via: https://faucet.altnet.rippletest.net
  // Then run: npm run xrpl:setup-issuer   (enables DefaultRipple on the issuer)
  //
  // XRPL_TESTNET_RLUSD_CURRENCY / XRPL_TESTNET_EURQ_CURRENCY:
  //   Human-readable names (e.g. "RLUSD", "EURQ"). TrustLineService converts them
  //   to 20-byte hex as required by ripple-binary-codec when building TrustSet TXs.
  //
  // XRPL_TESTNET_TRUST_LIMIT:
  //   Maximum amount of each issued token the user's wallet will trust.
  //   Expressed as a string decimal (e.g. "1000000000" = 1 billion test tokens).
  //
  // XRPL_AUTO_SETUP_TRUST_LINES:
  //   When true, TrustLineService.setupTrustLines() is called automatically
  //   (fire-and-forget) after CustodialWalletService confirms funding.
  //   Set to false to disable automatic trust line setup.
  xrplTestnetIssuerAddress:   process.env["XRPL_TESTNET_ISSUER_ADDRESS"]    ?? "",
  xrplTestnetIssuerSeed:      process.env["XRPL_TESTNET_ISSUER_SEED"]       ?? "",
  xrplTestnetRlusdCurrency:   process.env["XRPL_TESTNET_RLUSD_CURRENCY"]    ?? "RLUSD",
  xrplTestnetEurqCurrency:    process.env["XRPL_TESTNET_EURQ_CURRENCY"]     ?? "EURQ",
  xrplTestnetTrustLimit:      process.env["XRPL_TESTNET_TRUST_LIMIT"]       ?? "1000000000",
  xrplAutoSetupTrustLines:    process.env["XRPL_AUTO_SETUP_TRUST_LINES"]    !== "false",

  // ── XRPL Testnet issued token drops (Phase 2C) ────────────────────────────
  // Allows users with funded + trust-lined custodial wallets to receive test
  // issued tokens (RLUSD_TEST / EURQ_TEST) directly from the testnet issuer.
  //
  // TESTNET ONLY. These drops do NOT affect internal LumixPay balances.
  // They do NOT represent official RLUSD or EURQ.
  //
  // XRPL_TEST_TOKEN_DROP_ENABLED:
  //   Set to 'false' to disable the feature globally.
  //
  // XRPL_TEST_TOKEN_DROP_RLUSD_AMOUNT / XRPL_TEST_TOKEN_DROP_EURQ_AMOUNT:
  //   Number of tokens sent per drop request (string decimal, e.g. "100").
  //   Users cannot override this — the endpoint always uses the configured value.
  //
  // XRPL_TEST_TOKEN_DROP_COOLDOWN_HOURS:
  //   Minimum hours between drop requests per user per currency.
  //   Prevents faucet abuse. Default: 24 h.
  xrplTestTokenDropEnabled:       process.env["XRPL_TEST_TOKEN_DROP_ENABLED"]        !== "false",
  xrplTestTokenDropRlusdAmount:   process.env["XRPL_TEST_TOKEN_DROP_RLUSD_AMOUNT"]   ?? "100",
  xrplTestTokenDropEurqAmount:    process.env["XRPL_TEST_TOKEN_DROP_EURQ_AMOUNT"]    ?? "100",
  xrplTestTokenDropCooldownHours: parseInt(
    process.env["XRPL_TEST_TOKEN_DROP_COOLDOWN_HOURS"] ?? "24", 10
  ),

  // ── Custodial wallet encryption ──────────────────────────────────────────
  // walletMasterKey: 32-byte random value, base64url-encoded.
  // Generate: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  //
  // In development: if empty, wallet provisioning is skipped with a warning.
  // In production: wallet provisioning will fail if this is not set.
  //
  // NEVER commit this value. Set via Fly.io secrets: fly secrets set WALLET_MASTER_KEY=...
  walletMasterKey:      process.env["WALLET_MASTER_KEY"]       ?? "",
  walletEncryptionKeyId: process.env["WALLET_ENCRYPTION_KEY_ID"] ?? "v1",

  system: {
    userId: "00000000-0000-0000-0001-000000000000",
    accounts: {
      rlusd: {
        assetId: "00000000-0000-0000-0000-000000000001",
        // FLOAT_RLUSD — on-chain reserve; debited on top-up, credited on withdrawal settlement
        float: "00000000-0001-0000-0000-000000000001",
        feeCollector: "00000000-0001-0000-0000-000000000002",
        withdrawalEscrow: "00000000-0001-0000-0000-000000000003",
      },
      eurq: {
        assetId: "00000000-0000-0000-0000-000000000002",
        // FLOAT_EURQ — on-chain reserve; debited on top-up, credited on withdrawal settlement
        float: "00000000-0002-0000-0000-000000000001",
        feeCollector: "00000000-0002-0000-0000-000000000002",
        withdrawalEscrow: "00000000-0002-0000-0000-000000000003",
      },
    },
  },
} as const;

const INSECURE_JWT_SECRETS = new Set(["change_this_secret", "devsecret", ""]);

/** Throws at startup if production is configured with a default or missing JWT secret. */
export function assertProductionSecrets(): void {
  if (config.nodeEnv !== "production") return;
  const secret = process.env["JWT_SECRET"] ?? "";
  if (INSECURE_JWT_SECRETS.has(secret)) {
    throw new Error(
      "JWT_SECRET must be set to a strong random value in production. " +
      "Generate one and set it via your deployment secrets manager."
    );
  }
}

export type Config = typeof config;
