import { PoolClient } from "pg";
import Decimal from "decimal.js";

/**
 * TreasuryService — governs the available inventory of each asset.
 *
 * INVENTORY MODEL
 * ───────────────
 * treasury_limits.current_supply  = remaining inventory (available to distribute)
 * treasury_limits.max_supply      = total capacity (for admin reference / restocking)
 *
 * Example:
 *   max_supply     = 100,000  (total stock capacity)
 *   current_supply =   5,000  (currently available for topups / voucher redeems)
 *
 * When a topup or admin-voucher redeem happens:
 *   1. ensureCanIssue — checks current_supply >= amount (FOR UPDATE, serialised)
 *   2. consume        — decrements current_supply -= amount
 *
 * Admin replenishes stock by increasing current_supply via PUT /admin/treasury/:asset_id.
 *
 * Operations that DO consume inventory:
 *   - topUp (card → FLOAT → user)
 *   - admin-created voucher redeem (FLOAT → user)
 *
 * Operations that do NOT touch inventory (just move circulating funds):
 *   - transfers, withdrawals, payment-link claims, FX conversions
 *   - user-purchased voucher redemption (buyer already paid from circulating balance)
 *
 * All mutating methods MUST be called inside an open DB transaction.
 */
export class TreasuryService {
  /**
   * Verify that `amount` is available in the treasury inventory for `assetId`.
   *
   * Uses SELECT … FOR UPDATE so concurrent topups cannot both pass the check
   * against the same inventory row.
   *
   * Throws HTTP 409 / code TREASURY_EMPTY when inventory is insufficient.
   * If no treasury row exists for the asset the check is silently skipped.
   */
  async ensureCanIssue(
    client: PoolClient,
    assetId: string,
    amount: Decimal
  ): Promise<void> {
    const { rows } = await client.query<{
      max_supply: string;
      current_supply: string;
    }>(
      "SELECT max_supply, current_supply FROM treasury_limits WHERE asset_id = $1 FOR UPDATE",
      [assetId]
    );
    if (!rows[0]) return; // no limit configured — allow

    const available = new Decimal(rows[0].current_supply);

    if (available.lt(amount)) {
      const err = new Error(
        `Treasury inventory exhausted. Available: ${available.toFixed(6)}, Requested: ${amount.toFixed(6)}`
      ) as any;
      err.status  = 409;
      err.code    = "TREASURY_EMPTY";
      err.details = {
        available:  available.toFixed(6),
        requested:  amount.toFixed(6),
        max_supply: rows[0].max_supply,
      };
      throw err;
    }
  }

  /**
   * Atomically decrement `current_supply` by `amount` (consume inventory).
   * Must be called INSIDE the same transaction as ensureCanIssue.
   */
  async consume(
    client: PoolClient,
    assetId: string,
    amount: Decimal
  ): Promise<void> {
    await client.query(
      `UPDATE treasury_limits
          SET current_supply = current_supply - $1,
              updated_at     = NOW()
        WHERE asset_id = $2`,
      [amount.toFixed(6), assetId]
    );
  }

  /**
   * @deprecated Use consume() instead.
   * Kept for backward compat with any callers that used the old issue() name.
   */
  async issue(client: PoolClient, assetId: string, amount: Decimal): Promise<void> {
    return this.consume(client, assetId, amount);
  }
}

export const treasuryService = new TreasuryService();
