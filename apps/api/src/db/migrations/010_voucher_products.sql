-- Migration 010: voucher_products — purchasable voucher catalog
-- Also adds purchased_by_user_id to vouchers for user-purchased vouchers

CREATE TABLE IF NOT EXISTS voucher_products (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id   UUID NOT NULL REFERENCES assets(id),
  amount     NUMERIC(18,6) NOT NULL CHECK (amount > 0),
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed RLUSD products: 10, 20, 50, 100
INSERT INTO voucher_products (asset_id, amount)
SELECT id, amounts.v
FROM assets
CROSS JOIN (VALUES (10), (20), (50), (100)) AS amounts(v)
WHERE currency_code = 'RLUSD'
ON CONFLICT DO NOTHING;

-- Seed EURQ products: 10, 20, 50, 100
INSERT INTO voucher_products (asset_id, amount)
SELECT id, amounts.v
FROM assets
CROSS JOIN (VALUES (10), (20), (50), (100)) AS amounts(v)
WHERE currency_code = 'EURQ'
ON CONFLICT DO NOTHING;

-- Track who purchased a voucher (nullable — admin-created vouchers have NULL)
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS purchased_by_user_id UUID REFERENCES users(id);
