import Decimal from "decimal.js";
export declare const ALLOWED_TOPUP_AMOUNTS: readonly [10, 20, 50, 100];
export type AllowedTopupAmount = (typeof ALLOWED_TOPUP_AMOUNTS)[number];
export interface MockChargeParams {
    amount: Decimal;
    currency: string;
    cardLast4: string;
    idempotencyKey: string;
}
export interface MockChargeResult {
    success: true;
    providerReference: string;
    chargedAt: Date;
}
/**
 * Simulated payment provider. Always succeeds.
 * In Phase 2 this interface will be implemented by a real acquirer adapter.
 */
export declare class MockPaymentProvider {
    /**
     * Validates denomination and simulates a successful card charge.
     * Throws if amount is not one of the allowed denominations.
     */
    charge(params: MockChargeParams): Promise<MockChargeResult>;
}
export declare const mockPaymentProvider: MockPaymentProvider;
//# sourceMappingURL=MockPaymentProvider.d.ts.map