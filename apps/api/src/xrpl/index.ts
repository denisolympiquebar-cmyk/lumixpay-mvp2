import { SettlementProvider } from "./SettlementProvider";
import { mockSettlementProvider } from "./MockSettlementProvider";

// ─────────────────────────────────────────────────────────────────────────────
// Settlement provider factory
//
// Reads SETTLEMENT_PROVIDER env var to select the active backend.
// Default: 'mock'  — safe for Phase 1, no network calls, no secrets needed.
//
// ── Available providers ───────────────────────────────────────────────────────
//   mock         (default) — confirms immediately, no network calls, no secrets.
//   xrpl_testnet (Phase 3C) — issues XRPL Testnet tokens from the configured
//                             treasury/issuer wallet. Requires:
//                               XRPL_TESTNET_ISSUER_ADDRESS=r...
//                               XRPL_TESTNET_ISSUER_SEED=s...
//                               XRPL_TESTNET_RPC_URL=http://s.altnet.rippletest.net:51234
//                             TESTNET ONLY — do NOT use real funds or mainnet issuers.
//   xrpl         (FUTURE)   — mainnet production settlement (not yet implemented).
//
// ── XRPL mainnet integration point ───────────────────────────────────────────
// To implement future mainnet settlement:
//   1. Implement XrplSettlementService (src/xrpl/XrplSettlementService.ts)
//   2. Implement XrplClient            (src/xrpl/XrplClient.ts)
//   3. Implement XrplWallet            (src/xrpl/XrplWallet.ts)
//   4. Uncomment the 'xrpl' branch below
//   5. Set env vars:
//        SETTLEMENT_PROVIDER=xrpl
//        XRPL_NETWORK=mainnet
//        XRPL_NODE_URL=wss://...
//        XRPL_WALLET_SEED=s...           (inject via Fly.io secrets only — never commit)
//        XRPL_WALLET_CLASSIC_ADDRESS=r...
//        XRPL_CONFIRMATION_TIMEOUT_MS=30000
// ─────────────────────────────────────────────────────────────────────────────

function createSettlementProvider(): SettlementProvider {
  const provider = process.env["SETTLEMENT_PROVIDER"] ?? "mock";

  // ── Phase 3C: XRPL Testnet treasury/issuer settlement ────────────────────
  if (provider === "xrpl_testnet") {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { xrplTestnetSettlementProvider } =
      require("./XrplTestnetSettlementProvider") as typeof import("./XrplTestnetSettlementProvider");
    console.info(
      "[Settlement] SETTLEMENT_PROVIDER=xrpl_testnet — real XRPL Testnet settlement active. " +
      "Treasury/issuer wallet will sign Payment transactions."
    );
    return xrplTestnetSettlementProvider;
  }

  // ── FUTURE: mainnet production settlement (not yet implemented) ───────────
  if (provider === "xrpl") {
    // When XrplSettlementService is implemented, uncomment:
    // const { xrplSettlementService } = require("./XrplSettlementService");
    // return xrplSettlementService;
    console.warn(
      "[Settlement] SETTLEMENT_PROVIDER=xrpl is set but XrplSettlementService " +
        "is not yet implemented. Falling back to mock provider. " +
        "Phase 4+ work required: implement XrplSettlementService, XrplClient, XrplWallet."
    );
  }

  if (provider !== "mock") {
    console.warn(
      `[Settlement] Unknown SETTLEMENT_PROVIDER value: '${provider}'. ` +
      "Falling back to mock provider. Valid values: mock, xrpl_testnet."
    );
  }

  return mockSettlementProvider;
}

export const settlementProvider: SettlementProvider = createSettlementProvider();

// Re-export types for use across the codebase without reaching into sub-files
export type {
  SettlementProvider,
  SettlementRequest,
  SettlementResult,
  SettlementStatus,
} from "./SettlementProvider";
