-- ─────────────────────────────────────────────────────────────────────────────
-- 002_seed_system.sql — Assets registry + system user + system accounts
-- ─────────────────────────────────────────────────────────────────────────────
-- Idempotent: uses ON CONFLICT DO NOTHING throughout.

-- ── Assets ───────────────────────────────────────────────────────────────────
-- RLUSD — Ripple USD stablecoin on XRPL
INSERT INTO assets (id, currency_code, issuer_address, decimals, display_name, display_symbol)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'RLUSD',
  'rMH4UxPrbuMa1spCBR98hLLyNJp4d8p4tM',
  6,
  'Ripple USD',
  'RLUSD'
)
ON CONFLICT (currency_code, issuer_address) DO NOTHING;

-- EURQ — Euro stablecoin on XRPL
INSERT INTO assets (id, currency_code, issuer_address, decimals, display_name, display_symbol)
VALUES (
  '00000000-0000-0000-0000-000000000002',
  'EURQ',
  'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
  6,
  'Quantoz Euro',
  'EURQ'
)
ON CONFLICT (currency_code, issuer_address) DO NOTHING;

-- ── System user ──────────────────────────────────────────────────────────────
-- Single system actor that owns all platform-side accounts.
-- password_hash is a deliberately invalid bcrypt hash — system user never logs in.
INSERT INTO users (id, email, password_hash, full_name, role)
VALUES (
  '00000000-0000-0000-0001-000000000000',
  'system@lumixpay.internal',
  '$2a$12$SYSTEM_ACCOUNT_NO_LOGIN_POSSIBLE_XXXXXXXXXXXXXXXXXXXXXXXX',
  'LumixPay System',
  'system'
)
ON CONFLICT (email) DO NOTHING;

-- ── System accounts: RLUSD ───────────────────────────────────────────────────
-- float           — LumixPay's on-chain reserve for RLUSD.
--                   Debited on every top-up (reserve pays user).
--                   Credited on every withdrawal settlement (escrow → float).
-- fee_collector   — Accumulates platform fees.
-- withdrawal_escrow — Holds net withdrawal amounts pending admin approval.
INSERT INTO accounts (id, user_id, asset_id, label) VALUES
  ('00000000-0001-0000-0000-000000000001',
   '00000000-0000-0000-0001-000000000000',
   '00000000-0000-0000-0000-000000000001',
   'float'),
  ('00000000-0001-0000-0000-000000000002',
   '00000000-0000-0000-0001-000000000000',
   '00000000-0000-0000-0000-000000000001',
   'fee_collector'),
  ('00000000-0001-0000-0000-000000000003',
   '00000000-0000-0000-0001-000000000000',
   '00000000-0000-0000-0000-000000000001',
   'withdrawal_escrow')
ON CONFLICT (user_id, asset_id, label) DO NOTHING;

-- ── System accounts: EURQ ────────────────────────────────────────────────────
INSERT INTO accounts (id, user_id, asset_id, label) VALUES
  ('00000000-0002-0000-0000-000000000001',
   '00000000-0000-0000-0001-000000000000',
   '00000000-0000-0000-0000-000000000002',
   'float'),
  ('00000000-0002-0000-0000-000000000002',
   '00000000-0000-0000-0001-000000000000',
   '00000000-0000-0000-0000-000000000002',
   'fee_collector'),
  ('00000000-0002-0000-0000-000000000003',
   '00000000-0000-0000-0001-000000000000',
   '00000000-0000-0000-0000-000000000002',
   'withdrawal_escrow')
ON CONFLICT (user_id, asset_id, label) DO NOTHING;

-- ── System balances ───────────────────────────────────────────────────────────
-- FLOAT_RLUSD / FLOAT_EURQ seeded with the platform's initial on-chain reserve.
-- The seed value represents the real stablecoin holdings on XRPL (Phase 2 will
-- sync this from chain). fee_collector and withdrawal_escrow start at 0.
INSERT INTO balances (account_id, available, locked) VALUES
  -- RLUSD
  ('00000000-0001-0000-0000-000000000001', 1000000.000000, 0),  -- FLOAT_RLUSD
  ('00000000-0001-0000-0000-000000000002', 0, 0),               -- fee_collector
  ('00000000-0001-0000-0000-000000000003', 0, 0),               -- withdrawal_escrow
  -- EURQ
  ('00000000-0002-0000-0000-000000000001', 1000000.000000, 0),  -- FLOAT_EURQ
  ('00000000-0002-0000-0000-000000000002', 0, 0),               -- fee_collector
  ('00000000-0002-0000-0000-000000000003', 0, 0)                -- withdrawal_escrow
ON CONFLICT (account_id) DO NOTHING;
