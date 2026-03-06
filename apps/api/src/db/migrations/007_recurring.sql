-- ─────────────────────────────────────────────────────────────────────────────
-- 007_recurring.sql
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS recurring_plans (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_user_id  UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  asset_id         UUID          NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  amount           NUMERIC(18,6) NOT NULL CHECK (amount > 0),
  interval         VARCHAR(20)   NOT NULL CHECK (interval IN ('weekly', 'monthly')),
  day_of_week      SMALLINT      CHECK (day_of_week BETWEEN 0 AND 6),  -- 0=Sun (weekly)
  day_of_month     SMALLINT      CHECK (day_of_month BETWEEN 1 AND 28), -- (monthly)
  status           VARCHAR(20)   NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'paused', 'deleted')),
  description      VARCHAR(255),
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recurring_plans_creator ON recurring_plans(creator_user_id);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id             UUID          NOT NULL REFERENCES recurring_plans(id) ON DELETE RESTRICT,
  subscriber_user_id  UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status              VARCHAR(20)   NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'canceled')),
  next_run_at         TIMESTAMPTZ   NOT NULL,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE(plan_id, subscriber_user_id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_subscriber ON subscriptions(subscriber_user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_next_run
  ON subscriptions(next_run_at) WHERE status = 'active';
