import Decimal from "decimal.js";
import { config } from "../config";

Decimal.set({ rounding: Decimal.ROUND_HALF_UP });

export interface FeeBreakdown {
  gross: Decimal;
  fee: Decimal;
  net: Decimal;
  rateApplied: string;
}

export class FeeService {
  private readonly rate: Decimal;

  constructor(rateOverride?: number) {
    this.rate = new Decimal(rateOverride ?? config.fee.rate);
  }

  /**
   * Computes fee breakdown for a given gross amount.
   * fee  = gross × rate, rounded to 6 decimal places (ROUND_HALF_UP)
   * net  = gross − fee
   */
  compute(grossAmount: Decimal | string | number): FeeBreakdown {
    const gross = new Decimal(grossAmount);
    if (gross.lte(0)) throw new Error("grossAmount must be positive");

    const fee = gross.mul(this.rate).toDecimalPlaces(6);
    const net = gross.minus(fee);

    if (net.lte(0)) {
      throw new Error(
        `Fee (${fee}) consumes entire gross amount (${gross}). Adjust denomination.`
      );
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
  getFeeCollectorAccountId(assetId: string): string {
    const { rlusd, eurq } = config.system.accounts;
    if (assetId === rlusd.assetId) return rlusd.feeCollector;
    if (assetId === eurq.assetId) return eurq.feeCollector;
    throw new Error(`No fee collector account configured for asset ${assetId}`);
  }
}

export const feeService = new FeeService();
