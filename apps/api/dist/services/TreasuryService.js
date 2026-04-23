"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.treasuryService = exports.TreasuryService = void 0;
const decimal_js_1 = __importDefault(require("decimal.js"));
const config_1 = require("../config");
const AdminAlertService_1 = require("./AdminAlertService");
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
class TreasuryService {
    /**
     * Verify that `amount` is available in the treasury inventory for `assetId`.
     *
     * Uses SELECT … FOR UPDATE so concurrent topups cannot both pass the check
     * against the same inventory row.
     *
     * Throws HTTP 409 / code TREASURY_EMPTY when inventory is insufficient.
     * If no treasury row exists for the asset the check is silently skipped.
     */
    async ensureCanIssue(client, assetId, amount) {
        const { rows } = await client.query("SELECT max_supply, current_supply FROM treasury_limits WHERE asset_id = $1 FOR UPDATE", [assetId]);
        if (!rows[0])
            return; // no limit configured — allow
        const available = new decimal_js_1.default(rows[0].current_supply);
        if (available.lt(amount)) {
            const err = new Error(`Treasury inventory exhausted. Available: ${available.toFixed(6)}, Requested: ${amount.toFixed(6)}`);
            err.status = 409;
            err.code = "TREASURY_EMPTY";
            err.details = {
                available: available.toFixed(6),
                requested: amount.toFixed(6),
                max_supply: rows[0].max_supply,
            };
            throw err;
        }
        const max = new decimal_js_1.default(rows[0].max_supply);
        if (max.gt(0)) {
            const remainingRatio = available.div(max).toNumber();
            if (remainingRatio <= config_1.config.treasurySafety.depletionWarnRatio) {
                void AdminAlertService_1.adminAlertService.emit({
                    type: "treasury.depletion_risk",
                    title: "Treasury depletion risk",
                    body: `Asset ${assetId} inventory is at ${(remainingRatio * 100).toFixed(2)}% of max supply`,
                    severity: remainingRatio <= config_1.config.treasurySafety.depletionWarnRatio / 2 ? "critical" : "warning",
                    metadata: {
                        asset_id: assetId,
                        current_supply: available.toFixed(6),
                        max_supply: max.toFixed(6),
                        ratio: remainingRatio,
                    },
                    dedupeKey: `treasury:${assetId}`,
                    dedupeMinutes: 15,
                });
            }
        }
    }
    /**
     * Atomically decrement `current_supply` by `amount` (consume inventory).
     * Must be called INSIDE the same transaction as ensureCanIssue.
     */
    async consume(client, assetId, amount) {
        const res = await client.query(`UPDATE treasury_limits
          SET current_supply = current_supply - $1,
              updated_at     = NOW()
        WHERE asset_id = $2`, [amount.toFixed(6), assetId]);
        if (res.rowCount === 0) {
            throw new Error(`Treasury row not found for asset ${assetId}`);
        }
    }
    /**
     * @deprecated Use consume() instead.
     * Kept for backward compat with any callers that used the old issue() name.
     */
    async issue(client, assetId, amount) {
        return this.consume(client, assetId, amount);
    }
}
exports.TreasuryService = TreasuryService;
exports.treasuryService = new TreasuryService();
//# sourceMappingURL=TreasuryService.js.map