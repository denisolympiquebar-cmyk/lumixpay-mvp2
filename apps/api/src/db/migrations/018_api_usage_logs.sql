-- Migration 018: api_usage_logs — track API usage per request.

CREATE TABLE IF NOT EXISTS api_usage_logs (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        REFERENCES users(id) ON DELETE SET NULL,
  api_key_id       UUID        REFERENCES api_keys(id) ON DELETE SET NULL,
  route            TEXT        NOT NULL,
  method           TEXT        NOT NULL,
  status_code      INTEGER,
  response_time_ms INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_usage_logs_user_id    ON api_usage_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_api_usage_logs_api_key_id ON api_usage_logs (api_key_id);
CREATE INDEX IF NOT EXISTS idx_api_usage_logs_created_at ON api_usage_logs (created_at DESC);
