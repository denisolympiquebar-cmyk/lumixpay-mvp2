-- ─────────────────────────────────────────────────────────────────────────────
-- 019_xrpl_settlement.sql
-- Adds settlement tracking columns to withdrawal_requests.
--
-- IMPORTANT: This migration is fully non-destructive.
--   - All new columns are nullable with no DEFAULT constraint.
--   - xrpl_tx_hash already exists from 001_schema.sql — NOT modified here.
--   - status column already supports 'settled' value from 001_schema.sql — NOT modified.
--   - No existing columns, constraints, or indexes are altered.
--   - Safe to apply to a live production database with zero downtime.
--
-- Column semantics:
--   settlement_provider  — Which backend executed the settlement ('mock' | 'xrpl').
--                          NULL = settlement not yet attempted.
--   xrpl_submitted_at    — Wall-clock timestamp when the settlement was handed off
--                          to the provider. Set BEFORE the provider call to protect
--                          against crash-between-submit-and-confirm scenarios.
--                          NULL = not yet submitted.
--   xrpl_confirmed_at    — Wall-clock timestamp when the provider confirmed the TX.
--                          NULL = not yet confirmed (or failed).
--   xrpl_network_fee_xrp — XRP consumed as network fee by the XRPL transaction.
--                          NULL for mock provider. Populated by XRPL provider in Phase 2.
--                          NOT a stablecoin amount — paid from hot wallet XRP reserve.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE withdrawal_requests
  ADD COLUMN IF NOT EXISTS settlement_provider    VARCHAR(20),
  ADD COLUMN IF NOT EXISTS xrpl_submitted_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS xrpl_confirmed_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS xrpl_network_fee_xrp   NUMERIC(18,8);
