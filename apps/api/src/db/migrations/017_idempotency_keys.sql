-- Migration 017: idempotency_keys — prevent duplicate mutations on retry.
--
-- When a client sends the same Idempotency-Key header to the same route,
-- the server returns the original response instead of executing again.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route            TEXT NOT NULL,
  method           TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  response_status  INTEGER NOT NULL,
  response_body    JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT idempotency_keys_unique UNIQUE (user_id, route, method, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_lookup
  ON idempotency_keys (user_id, route, method, idempotency_key);

-- Auto-expire records after 24 hours (cleanup job can use this column)
-- (No background job needed; old rows are harmless and cheap to keep for a day)
