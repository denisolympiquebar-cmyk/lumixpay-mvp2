import { v4 as uuidv4 } from "uuid";
import Decimal from "decimal.js";

export const ALLOWED_TOPUP_AMOUNTS = [10, 20, 50, 100] as const;
export type AllowedTopupAmount = (typeof ALLOWED_TOPUP_AMOUNTS)[number];

export interface MockChargeParams {
  amount: Decimal;
  currency: string; // display symbol e.g. 'RLUSD'
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
export class MockPaymentProvider {
  /**
   * Validates denomination and simulates a successful card charge.
   * Throws if amount is not one of the allowed denominations.
   */
  async charge(params: MockChargeParams): Promise<MockChargeResult> {
    const num = params.amount.toNumber();
    if (!(ALLOWED_TOPUP_AMOUNTS as readonly number[]).includes(num)) {
      throw new Error(
        `Invalid top-up amount ${num}. Allowed: ${ALLOWED_TOPUP_AMOUNTS.join(", ")}`
      );
    }

    if (!/^\d{4}$/.test(params.cardLast4)) {
      throw new Error("cardLast4 must be exactly 4 digits");
    }

    // Simulate async payment processing
    await new Promise((r) => setTimeout(r, 50));

    return {
      success: true,
      providerReference: `mock_${uuidv4()}`,
      chargedAt: new Date(),
    };
  }
}

export const mockPaymentProvider = new MockPaymentProvider();
