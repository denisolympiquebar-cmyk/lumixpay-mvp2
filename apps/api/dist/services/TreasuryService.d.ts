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
export declare class TreasuryService {
    /**
     * Verify that `amount` is available in the treasury inventory for `assetId`.
     *
     * Uses SELECT … FOR UPDATE so concurrent topups cannot both pass the check
     * against the same inventory row.
     *
     * Throws HTTP 409 / code TREASURY_EMPTY when inventory is insufficient.
     * If no treasury row exists for the asset the check is silently skipped.
     */
    ensureCanIssue(client: PoolClient, assetId: string, amount: Decimal): Promise<void>;
    /**
     * Atomically decrement `current_supply` by `amount` (consume inventory).
     * Must be called INSIDE the same transaction as ensureCanIssue.
     */
    consume(client: PoolClient, assetId: string, amount: Decimal): Promise<void>;
    /**
     * @deprecated Use consume() instead.
     * Kept for backward compat with any callers that used the old issue() name.
     */
    issue(client: PoolClient, assetId: string, amount: Decimal): Promise<void>;
}
export declare const treasuryService: TreasuryService;
//# sourceMappingURL=TreasuryService.d.ts.map