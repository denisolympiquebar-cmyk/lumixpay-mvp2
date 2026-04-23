"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mockPaymentProvider = exports.MockPaymentProvider = exports.ALLOWED_TOPUP_AMOUNTS = void 0;
const uuid_1 = require("uuid");
exports.ALLOWED_TOPUP_AMOUNTS = [10, 20, 50, 100];
/**
 * Simulated payment provider. Always succeeds.
 * In Phase 2 this interface will be implemented by a real acquirer adapter.
 */
class MockPaymentProvider {
    /**
     * Validates denomination and simulates a successful card charge.
     * Throws if amount is not one of the allowed denominations.
     */
    async charge(params) {
        const num = params.amount.toNumber();
        if (!exports.ALLOWED_TOPUP_AMOUNTS.includes(num)) {
            throw new Error(`Invalid top-up amount ${num}. Allowed: ${exports.ALLOWED_TOPUP_AMOUNTS.join(", ")}`);
        }
        if (!/^\d{4}$/.test(params.cardLast4)) {
            throw new Error("cardLast4 must be exactly 4 digits");
        }
        // Simulate async payment processing
        await new Promise((r) => setTimeout(r, 50));
        return {
            success: true,
            providerReference: `mock_${(0, uuid_1.v4)()}`,
            chargedAt: new Date(),
        };
    }
}
exports.MockPaymentProvider = MockPaymentProvider;
exports.mockPaymentProvider = new MockPaymentProvider();
//# sourceMappingURL=MockPaymentProvider.js.map