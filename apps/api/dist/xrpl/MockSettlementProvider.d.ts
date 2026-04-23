import { SettlementProvider, SettlementRequest, SettlementResult } from "./SettlementProvider";
export declare class MockSettlementProvider implements SettlementProvider {
    /**
     * Simulates a successful on-chain payment.
     * Returns a deterministic-looking mock tx hash derived from withdrawalId.
     * Adds a small artificial delay to match realistic async provider behavior.
     */
    settle(request: SettlementRequest): Promise<SettlementResult>;
}
export declare const mockSettlementProvider: MockSettlementProvider;
//# sourceMappingURL=MockSettlementProvider.d.ts.map