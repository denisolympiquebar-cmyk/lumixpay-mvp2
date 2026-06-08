-- ─────────────────────────────────────────────────────────────────────────────
-- 026_xrpl_test_token_drops.sql — Phase 2C: XRPL Testnet issued token drops
--
-- Records each request to receive test issued tokens (RLUSD_TEST / EURQ_TEST)
-- from the configured XRPL Testnet issuer wallet to a user's custodial wallet.
--
-- IMPORTANT:
--   - TESTNET ONLY. These are test tokens with no real-world value.
--   - This table is completely separate from the internal ledger (balances,
--     ledger_entries, topup_transactions). No internal balance is credited.
--   - xrpl_tx_hash is set only after on-ledger confirmation.
--   - status transitions: pending → confirmed | failed
--   - ON DELETE RESTRICT on user_id / wallet_id prevents orphaned rows.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS xrpl_test_token_drops (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID          NOT NULL REFERENCES users(id)         ON DELETE RESTRICT,
  wallet_id      UUID          NOT NULL REFERENCES user_wallets(id)  ON DELETE RESTRICT,
  currency       VARCHAR(10)   NOT NULL
                   CHECK (currency IN ('RLUSD', 'EURQ')),
  amount_decimal NUMERIC(18,6) NOT NULL
                   CHECK (amount_decimal > 0),
  xrpl_tx_hash   VARCHAR(70),
  status         VARCHAR(20)   NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'confirmed', 'failed')),
  error_message  TEXT,
  requested_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  confirmed_at   TIMESTAMPTZ
);

-- For cooldown check + history per user
CREATE INDEX IF NOT EXISTS idx_test_drops_user_currency
  ON xrpl_test_token_drops(user_id, currency, requested_at DESC);

-- For tx hash lookups / reconciliation
CREATE INDEX IF NOT EXISTS idx_test_drops_tx_hash
  ON xrpl_test_token_drops(xrpl_tx_hash)
  WHERE xrpl_tx_hash IS NOT NULL;
