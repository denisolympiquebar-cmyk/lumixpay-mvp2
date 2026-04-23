"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mockSettlementProvider = exports.MockSettlementProvider = void 0;
const uuid_1 = require("uuid");
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
class MockSettlementProvider {
    /**
     * Simulates a successful on-chain payment.
     * Returns a deterministic-looking mock tx hash derived from withdrawalId.
     * Adds a small artificial delay to match realistic async provider behavior.
     */
    async settle(request) {
        // Simulate minimal network round-trip latency
        await new Promise((r) => setTimeout(r, 50));
        return {
            status: "confirmed",
            txHash: `mock_${(0, uuid_1.v4)()}`,
            confirmedAt: new Date(),
            // No real XRP fee in mock mode — field populated by XRPL provider in Phase 2
            networkFeeCostXrp: null,
        };
    }
}
exports.MockSettlementProvider = MockSettlementProvider;
exports.mockSettlementProvider = new MockSettlementProvider();
//# sourceMappingURL=MockSettlementProvider.js.map