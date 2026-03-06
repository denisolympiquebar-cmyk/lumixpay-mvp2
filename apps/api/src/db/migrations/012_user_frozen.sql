-- Migration 012: user_frozen — allow admin to freeze/unfreeze accounts

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_frozen BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_users_is_frozen ON users(is_frozen) WHERE is_frozen = TRUE;
