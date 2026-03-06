-- Migration 015: Switch treasury to inventory model.
--
-- Previous model: current_supply = how much has been minted (grows from 0).
-- New model:      current_supply = available inventory (shrinks on topup/redeem).
--
-- Replenish current_supply to max_supply for all existing rows so the system
-- starts with full inventory and topups are not immediately rejected.
--
-- Admin controls inventory by editing current_supply in /admin/treasury.
-- Topups and admin-voucher redeems DECREASE current_supply.

UPDATE treasury_limits
   SET current_supply = max_supply,
       updated_at     = NOW()
 WHERE current_supply < max_supply;
