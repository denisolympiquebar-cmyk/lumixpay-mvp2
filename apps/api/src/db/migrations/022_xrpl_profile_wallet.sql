-- 022_xrpl_profile_wallet.sql
-- Optional XRPL Testnet wallet link on user profile (Web2 remains primary).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS xrpl_address VARCHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS xrpl_network VARCHAR(32) NULL,
  ADD COLUMN IF NOT EXISTS xrpl_verified_at TIMESTAMPTZ NULL;

-- At most one LumixPay account per linked XRPL classic address.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_xrpl_address_unique
  ON users (xrpl_address)
  WHERE xrpl_address IS NOT NULL;

-- Short-lived signing challenges for wallet ownership verification.
CREATE TABLE IF NOT EXISTS wallet_link_challenges (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message     TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_link_challenges_user_id ON wallet_link_challenges(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_link_challenges_expires ON wallet_link_challenges(expires_at);
