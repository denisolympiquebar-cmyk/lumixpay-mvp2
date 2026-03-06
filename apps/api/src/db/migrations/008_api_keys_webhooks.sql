-- ─────────────────────────────────────────────────────────────────────────────
-- 008_api_keys_webhooks.sql
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS api_keys (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        VARCHAR(100) NOT NULL,
  key_hash    VARCHAR(255) NOT NULL UNIQUE,
  last4       CHAR(4)      NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  revoked_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS webhooks (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url        VARCHAR(500) NOT NULL,
  secret     VARCHAR(255) NOT NULL,
  events     JSONB        NOT NULL DEFAULT '[]',
  status     VARCHAR(20)  NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhooks_user ON webhooks(user_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id   UUID        NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_type   VARCHAR(60) NOT NULL,
  payload      JSONB       NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts     SMALLINT    NOT NULL DEFAULT 0,
  last_error   TEXT,
  delivered_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wd_webhook    ON webhook_deliveries(webhook_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wd_pending    ON webhook_deliveries(status, created_at)
  WHERE status = 'pending';
