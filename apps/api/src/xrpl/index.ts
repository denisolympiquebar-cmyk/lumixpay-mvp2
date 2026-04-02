import { SettlementProvider } from "./SettlementProvider";
import { mockSettlementProvider } from "./MockSettlementProvider";

// ─────────────────────────────────────────────────────────────────────────────
// Settlement provider factory
//
// Reads SETTLEMENT_PROVIDER env var to select the active backend.
// Default: 'mock'  — safe for Phase 1, no network calls, no secrets needed.
//
// ── XRPL INTEGRATION POINT ───────────────────────────────────────────────────
// To activate real XRPL settlement:
//   1. Implement XrplSettlementService (src/xrpl/XrplSettlementService.ts)
//   2. Implement XrplClient            (src/xrpl/XrplClient.ts)
//   3. Implement XrplWallet            (src/xrpl/XrplWallet.ts)
//   4. Uncomment the dynamic import block below
//   5. Set env vars:
//        SETTLEMENT_PROVIDER=xrpl
//        XRPL_NETWORK=testnet            (or mainnet)
//        XRPL_NODE_URL=wss://...
//        XRPL_WALLET_SEED=s...           (inject via Fly.io secrets only — never commit)
//        XRPL_WALLET_CLASSIC_ADDRESS=r...
//        XRPL_CONFIRMATION_TIMEOUT_MS=30000
// ─────────────────────────────────────────────────────────────────────────────

function createSettlementProvider(): SettlementProvider {
  const provider = process.env["SETTLEMENT_PROVIDER"] ?? "mock";

  if (provider === "xrpl") {
    // ── FUTURE: uncomment when XrplSettlementService is implemented ──────────
    // const { xrplSettlementService } = require("./XrplSettlementService");
    // return xrplSettlementService;
    // ─────────────────────────────────────────────────────────────────────────
    console.warn(
      "[Settlement] SETTLEMENT_PROVIDER=xrpl is set but XrplSettlementService " +
        "is not yet implemented. Falling back to mock provider. " +
        "Phase 2 work required: implement XrplSettlementService, XrplClient, XrplWallet."
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
