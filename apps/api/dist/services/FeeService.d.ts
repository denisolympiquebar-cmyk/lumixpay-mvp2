import Decimal from "decimal.js";
export interface FeeBreakdown {
    gross: Decimal;
    fee: Decimal;
    net: Decimal;
    rateApplied: string;
}
export declare class FeeService {
    private readonly rate;
    constructor(rateOverride?: number);
    /**
     * Computes fee breakdown for a given gross amount.
     * fee  = gross × rate, rounded to 6 decimal places (ROUND_HALF_UP)
     * net  = gross − fee
     */
    compute(grossAmount: Decimal | string | number): FeeBreakdown;
    /**
     * Returns the system account IDs for fee collection, indexed by asset_id.
     * Used by LedgerService to credit fees to the right account.
     */
    getFeeCollectorAccountId(assetId: string): string;
}
export declare const feeService: FeeService;
//# sourceMappingURL=FeeService.d.ts.map