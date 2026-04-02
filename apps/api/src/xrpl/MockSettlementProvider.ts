import { v4 as uuidv4 } from "uuid";
import {
  SettlementProvider,
  SettlementRequest,
  SettlementResult,
} from "./SettlementProvider";

// ─────────────────────────────────────────────────────────────────────────────
// MockSettlementProvider
//
// Phase 1 implementation. Always confirms immediately without any network call.
// Mirrors the design of MockPaymentProvider (src/services/MockPaymentProvider.ts).
//
// ── XRPL INTEGRATION POINT ───────────────────────────────────────────────────
// Phase 2: replace or supplement with XrplSettlementService.
// XrplSettlementService will:
//   1. Load the hot wallet from XRPL_WALLET_SEED env var (XrplWallet.ts)
//   2. Connect to XRPL node at XRPL_NODE_URL (XrplClient.ts)
//   3. Submit an issued-currency Payment transaction
//   4. Await ledger validation (timeout = XRPL_CONFIRMATION_TIMEOUT_MS)
//   5. Return { status: 'confirmed'|'failed'|'timeout', txHash, confirmedAt, networkFeeCostXrp }
// ─────────────────────────────────────────────────────────────────────────────

export class MockSettlementProvider implements SettlementProvider {
  /**
   * Simulates a successful on-chain payment.
   * Returns a deterministic-looking mock tx hash derived from withdrawalId.
   * Adds a small artificial delay to match realistic async provider behavior.
   */
  async settle(request: SettlementRequest): Promise<SettlementResult> {
    // Simulate minimal network round-trip latency
    await new Promise((r) => setTimeout(r, 50));

    return {
      status: "confirmed",
      txHash: `mock_${uuidv4()}`,
      confirmedAt: new Date(),
      // No real XRP fee in mock mode — field populated by XRPL provider in Phase 2
      networkFeeCostXrp: null,
    };
  }
}

export const mockSettlementProvider = new MockSettlementProvider();
