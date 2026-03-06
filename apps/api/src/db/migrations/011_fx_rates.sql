-- Migration 011: fx_rates — internal FX conversion rates

CREATE TABLE IF NOT EXISTS fx_rates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  base_asset  UUID NOT NULL REFERENCES assets(id),
  quote_asset UUID NOT NULL REFERENCES assets(id),
  rate        NUMERIC(18,6) NOT NULL CHECK (rate > 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fx_rates_pair_unique UNIQUE (base_asset, quote_asset),
  CONSTRAINT fx_rates_no_self CHECK (base_asset != quote_asset)
);

-- Seed RLUSD → EURQ  (1 RLUSD = 0.920000 EURQ)
INSERT INTO fx_rates (base_asset, quote_asset, rate)
SELECT r.id, e.id, 0.920000
FROM assets r, assets e
WHERE r.currency_code = 'RLUSD' AND e.currency_code = 'EURQ'
ON CONFLICT (base_asset, quote_asset) DO NOTHING;

-- Seed EURQ → RLUSD  (1 EURQ = 1.086957 RLUSD)
INSERT INTO fx_rates (base_asset, quote_asset, rate)
SELECT e.id, r.id, 1.086957
FROM assets r, assets e
WHERE r.currency_code = 'RLUSD' AND e.currency_code = 'EURQ'
ON CONFLICT (base_asset, quote_asset) DO NOTHING;

-- Extend ledger entry_type CHECK to include fx_conversion
ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_entry_type_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_entry_type_check CHECK (
  entry_type IN (
    'topup', 'transfer', 'fee',
    'withdrawal_lock', 'withdrawal_unlock', 'withdrawal_settle',
    'voucher', 'payment_link', 'recurring', 'fx_conversion'
  )
);
