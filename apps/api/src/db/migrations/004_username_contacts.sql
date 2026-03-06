-- ─────────────────────────────────────────────────────────────────────────────
-- 004_username_contacts.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- Add username to users (nullable so existing rows are unaffected)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS username VARCHAR(30) UNIQUE;

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL;

-- ── contacts ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contacts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_user_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname        VARCHAR(100),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(owner_user_id, contact_user_id),
  CHECK(owner_user_id != contact_user_id)
);

CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(owner_user_id);

-- ── Extend ledger_entries entry_type for future phases ───────────────────────
-- Drop the existing named constraint and replace with an expanded set.
-- The constraint name in PostgreSQL is auto-generated as <table>_<col>_check.
ALTER TABLE ledger_entries
  DROP CONSTRAINT IF EXISTS ledger_entries_entry_type_check;

ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_entries_entry_type_check
    CHECK (entry_type IN (
      'topup', 'transfer', 'fee',
      'withdrawal_lock', 'withdrawal_unlock', 'withdrawal_settle',
      'voucher', 'payment_link', 'recurring'
    ));
