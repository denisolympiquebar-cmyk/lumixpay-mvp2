-- ─────────────────────────────────────────────────────────────────────────────
-- 001_schema.sql — LumixPay full ledger schema
-- ─────────────────────────────────────────────────────────────────────────────

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── assets ───────────────────────────────────────────────────────────────────
-- Registry of supported stablecoins. Every monetary row references an asset_id.
-- currency_code + issuer_address together form the canonical identity.
CREATE TABLE assets (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  currency_code   VARCHAR(10) NOT NULL,
  issuer_address  VARCHAR(60) NOT NULL,       -- XRPL issuer (used in Phase 2)
  decimals        SMALLINT    NOT NULL DEFAULT 6,
  display_name    VARCHAR(50) NOT NULL,
  display_symbol  VARCHAR(10) NOT NULL,
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (currency_code, issuer_address)
);

-- ── users ────────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  full_name     VARCHAR(255) NOT NULL,
  role          VARCHAR(20)  NOT NULL DEFAULT 'user'
                  CHECK (role IN ('user', 'admin', 'system')),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── accounts ─────────────────────────────────────────────────────────────────
-- One account per (user, asset, label). System has: float, fee_collector,
-- withdrawal_escrow per asset. Users have: main per asset.
CREATE TABLE accounts (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  asset_id   UUID        NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  label      VARCHAR(30) NOT NULL DEFAULT 'main',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, asset_id, label)
);

-- ── balances ─────────────────────────────────────────────────────────────────
-- Denormalized read model. Maintained atomically alongside ledger_entries writes.
-- available: freely spendable. locked: reserved for pending withdrawal (net amount).
-- The CHECK constraints are the last line of defence; the application enforces them first.
CREATE TABLE balances (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID         NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE RESTRICT,
  available  NUMERIC(18,6) NOT NULL DEFAULT 0,
  locked     NUMERIC(18,6) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CHECK (available >= 0),
  CHECK (locked >= 0)
);

-- ── ledger_entries ───────────────────────────────────────────────────────────
-- Immutable double-entry journal. Single row per entry.
-- debit_account loses `amount` from available; credit_account gains `amount`.
-- idempotency_key prevents double-posting across retries.
CREATE TABLE ledger_entries (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key   VARCHAR(255) NOT NULL UNIQUE,
  debit_account_id  UUID         NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  credit_account_id UUID         NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  asset_id          UUID         NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  amount            NUMERIC(18,6) NOT NULL,
  entry_type        VARCHAR(30)  NOT NULL
                      CHECK (entry_type IN (
                        'topup',
                        'transfer',
                        'fee',
                        'withdrawal_lock',
                        'withdrawal_unlock',
                        'withdrawal_settle'
                      )),
  reference_id      UUID,
  reference_type    VARCHAR(30),
  metadata          JSONB,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CHECK (debit_account_id != credit_account_id),
  CHECK (amount > 0)
);

-- ── topup_transactions ───────────────────────────────────────────────────────
-- Records each MockPaymentProvider charge. Linked to two ledger_entries (topup + fee).
CREATE TABLE topup_transactions (
  id                   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  account_id           UUID          NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  asset_id             UUID          NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  gross_amount         NUMERIC(18,6) NOT NULL,
  fee_amount           NUMERIC(18,6) NOT NULL,
  net_amount           NUMERIC(18,6) NOT NULL,
  provider             VARCHAR(50)   NOT NULL DEFAULT 'mock',
  provider_reference   VARCHAR(255),
  simulated_card_last4 CHAR(4),
  status               VARCHAR(20)   NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'completed', 'failed')),
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CHECK (gross_amount IN (10, 20, 50, 100)),
  CHECK (fee_amount > 0),
  CHECK (net_amount > 0),
  CHECK (net_amount = gross_amount - fee_amount)
);

-- ── transfers ────────────────────────────────────────────────────────────────
-- Internal P2P transfer records. Linked to two ledger_entries (transfer + fee).
CREATE TABLE transfers (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  from_account_id UUID          NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  to_account_id   UUID          NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  asset_id        UUID          NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  gross_amount    NUMERIC(18,6) NOT NULL,
  fee_amount      NUMERIC(18,6) NOT NULL,
  net_amount      NUMERIC(18,6) NOT NULL,
  status          VARCHAR(20)   NOT NULL DEFAULT 'completed'
                    CHECK (status IN ('pending', 'completed', 'failed')),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CHECK (from_account_id != to_account_id),
  CHECK (gross_amount > 0),
  CHECK (net_amount = gross_amount - fee_amount)
);

-- ── withdrawal_requests ──────────────────────────────────────────────────────
-- Admin approval queue. On creation: user.available -= gross, user.locked += net.
-- On rejection: user.locked -= net, user.available += net (fee kept).
-- On settlement (Phase 2): user.locked -= net, on-chain TX submitted.
CREATE TABLE withdrawal_requests (
  id                       UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  account_id               UUID          NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  asset_id                 UUID          NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  gross_amount             NUMERIC(18,6) NOT NULL,
  fee_amount               NUMERIC(18,6) NOT NULL,
  net_amount               NUMERIC(18,6) NOT NULL,
  xrpl_destination_address VARCHAR(60)   NOT NULL,
  xrpl_destination_tag     INTEGER,
  status                   VARCHAR(20)   NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'approved', 'rejected', 'settled')),
  reviewed_by              UUID          REFERENCES users(id),
  reviewed_at              TIMESTAMPTZ,
  admin_note               TEXT,
  xrpl_tx_hash             VARCHAR(70),  -- populated in Phase 2
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CHECK (gross_amount > 0),
  CHECK (net_amount = gross_amount - fee_amount)
);

-- ── indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX idx_accounts_user_id         ON accounts(user_id);
CREATE INDEX idx_accounts_asset_id        ON accounts(asset_id);

CREATE INDEX idx_ledger_debit_account     ON ledger_entries(debit_account_id, created_at DESC);
CREATE INDEX idx_ledger_credit_account    ON ledger_entries(credit_account_id, created_at DESC);
CREATE INDEX idx_ledger_reference         ON ledger_entries(reference_id);
CREATE INDEX idx_ledger_entry_type        ON ledger_entries(entry_type);

CREATE INDEX idx_topup_user_id            ON topup_transactions(user_id);
CREATE INDEX idx_topup_status             ON topup_transactions(status);

CREATE INDEX idx_transfers_from_account   ON transfers(from_account_id);
CREATE INDEX idx_transfers_to_account     ON transfers(to_account_id);

CREATE INDEX idx_withdrawal_user_id       ON withdrawal_requests(user_id);
CREATE INDEX idx_withdrawal_status        ON withdrawal_requests(status);
CREATE INDEX idx_withdrawal_account_id    ON withdrawal_requests(account_id);
