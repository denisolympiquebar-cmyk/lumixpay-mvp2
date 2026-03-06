-- ─────────────────────────────────────────────────────────────────────────────
-- 005_payment_links.sql
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS payment_links (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_user_id UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  asset_id        UUID          NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  amount          NUMERIC(18,6),                     -- NULL = payer chooses amount
  description     VARCHAR(255),
  status          VARCHAR(20)   NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'disabled')),
  max_uses        INTEGER,                            -- NULL = unlimited
  uses_count      INTEGER       NOT NULL DEFAULT 0,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CHECK (amount IS NULL OR amount > 0),
  CHECK (uses_count >= 0),
  CHECK (max_uses IS NULL OR max_uses > 0)
);

CREATE INDEX IF NOT EXISTS idx_payment_links_creator ON payment_links(creator_user_id);
CREATE INDEX IF NOT EXISTS idx_payment_links_status  ON payment_links(status);
