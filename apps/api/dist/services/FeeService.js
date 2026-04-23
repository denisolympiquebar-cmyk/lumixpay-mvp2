"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.feeService = exports.FeeService = void 0;
const decimal_js_1 = __importDefault(require("decimal.js"));
const config_1 = require("../config");
decimal_js_1.default.set({ rounding: decimal_js_1.default.ROUND_HALF_UP });
class FeeService {
    rate;
    constructor(rateOverride) {
        this.rate = new decimal_js_1.default(rateOverride ?? config_1.config.fee.rate);
    }
    /**
     * Computes fee breakdown for a given gross amount.
     * fee  = gross × rate, rounded to 6 decimal places (ROUND_HALF_UP)
     * net  = gross − fee
     */
    compute(grossAmount) {
        const gross = new decimal_js_1.default(grossAmount);
        if (gross.lte(0))
            throw new Error("grossAmount must be positive");
        const fee = gross.mul(this.rate).toDecimalPlaces(6);
        const net = gross.minus(fee);
        if (net.lte(0)) {
            throw new Error(`Fee (${fee}) consumes entire gross amount (${gross}). Adjust denomination.`);
        }
        return {
            gross,
            fee,
            net,
            rateApplied: this.rate.toFixed(),
        };
    }
    /**
     * Returns the system account IDs for fee collection, indexed by asset_id.
     * Used by LedgerService to credit fees to the right account.
     */
    getFeeCollectorAccountId(assetId) {
        const { rlusd, eurq } = config_1.config.system.accounts;
        if (assetId === rlusd.assetId)
            return rlusd.feeCollector;
        if (assetId === eurq.assetId)
            return eurq.feeCollector;
        throw new Error(`No fee collector account configured for asset ${assetId}`);
    }
}
exports.FeeService = FeeService;
exports.feeService = new FeeService();
//# sourceMappingURL=FeeService.js.map