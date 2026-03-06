-- ─────────────────────────────────────────────────────────────────────────────
-- 006_vouchers.sql
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS vouchers (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  code                VARCHAR(30)   NOT NULL UNIQUE,
  asset_id            UUID          NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  gross_amount        NUMERIC(18,6) NOT NULL CHECK (gross_amount > 0),
  status              VARCHAR(20)   NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'redeemed', 'disabled')),
  created_by_admin_id UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  redeemed_by_user_id UUID          REFERENCES users(id) ON DELETE SET NULL,
  redeemed_at         TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vouchers_code   ON vouchers(code);
CREATE INDEX IF NOT EXISTS idx_vouchers_status ON vouchers(status);
