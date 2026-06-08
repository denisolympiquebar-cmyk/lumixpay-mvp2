-- 025_custodial_wallet_trust_lines.sql
-- Phase 2B: Track when XRPL Testnet trust lines are established for custodial wallets.
--
-- trust_lines_set_at is NULL until TrustLineService confirms both
-- RLUSD_TEST and EURQ_TEST TrustSet transactions are in a validated ledger.
-- It is set to NOW() only after account_lines verification passes.
-- Managed exclusively by TrustLineService — do NOT set manually.

ALTER TABLE user_wallets
  ADD COLUMN IF NOT EXISTS trust_lines_set_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN user_wallets.trust_lines_set_at IS
  'Timestamp when both RLUSD_TEST and EURQ_TEST TrustSet transactions were confirmed on XRPL Testnet.
   NULL = trust lines not yet established.
   Set only after on-ledger confirmation via account_lines — managed by TrustLineService.';
