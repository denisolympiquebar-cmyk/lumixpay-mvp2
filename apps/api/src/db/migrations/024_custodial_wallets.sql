-- ─────────────────────────────────────────────────────────────────────────────
-- 024_custodial_wallets.sql
-- Adds embedded custodial XRPL wallet storage for every LumixPay user.
--
-- IMPORTANT:
--   - TESTNET ONLY in the current phase.
--   - LumixPay generates and stores an encrypted seed on behalf of the user.
--   - The user never sees the seed — only the public classic_address is exposed.
--   - encrypted_seed is AES-256-GCM encrypted; plaintext seed never enters the DB.
--   - ON DELETE RESTRICT: custodial wallet rows must never be silently deleted;
--     they may hold on-chain funds that would become inaccessible.
--
-- Column semantics:
--   network           — 'xrpl_testnet' | 'xrpl_mainnet' (only testnet in Phase 1)
--   classic_address   — r... XRPL classic address (public, shown to user)
--   public_key        — hex-encoded compressed public key (public, safe to store)
--   encrypted_seed    — AES-256-GCM ciphertext: "<keyId>:<iv>:<authTag>:<ct>" base64url
--   encryption_key_id — key version tag (e.g. "v1") for future rotation
--   wallet_type       — 'custodial' (LumixPay holds key) | reserved for future types
--   is_active         — false = soft-deleted / key-rotated; never hard-delete
--   funded_at         — NULL = not yet funded on-chain; set after testnet faucet confirms
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_wallets (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  network           VARCHAR(32) NOT NULL DEFAULT 'xrpl_testnet',
  classic_address   VARCHAR(64) NOT NULL,
  public_key        VARCHAR(132) NOT NULL,
  encrypted_seed    TEXT        NOT NULL,
  encryption_key_id VARCHAR(64) NOT NULL DEFAULT 'v1',
  wallet_type       VARCHAR(20) NOT NULL DEFAULT 'custodial',
  is_active         BOOLEAN     NOT NULL DEFAULT true,
  funded_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One address per network globally (addresses are network-scoped)
  UNIQUE (network, classic_address),
  -- One active custodial wallet per user per network
  UNIQUE (user_id, network, wallet_type)
);

CREATE INDEX IF NOT EXISTS idx_user_wallets_user_id   ON user_wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_user_wallets_address   ON user_wallets(classic_address);
CREATE INDEX IF NOT EXISTS idx_user_wallets_active     ON user_wallets(user_id, is_active) WHERE is_active = true;
