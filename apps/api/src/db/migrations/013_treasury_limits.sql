-- Migration 013: treasury_limits — admin-controlled supply caps per asset

CREATE TABLE IF NOT EXISTS treasury_limits (
  asset_id       UUID PRIMARY KEY REFERENCES assets(id),
  max_supply     NUMERIC(18,6) NOT NULL DEFAULT 1000000 CHECK (max_supply >= 0),
  current_supply NUMERIC(18,6) NOT NULL DEFAULT 0      CHECK (current_supply >= 0),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default limits for all active assets
INSERT INTO treasury_limits (asset_id, max_supply, current_supply)
SELECT id, 1000000, 0
FROM assets
WHERE is_active = TRUE
ON CONFLICT (asset_id) DO NOTHING;
