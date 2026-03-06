-- ─────────────────────────────────────────────────────────────────────────────
-- 009_admin_alerts.sql
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS admin_alerts (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  type        VARCHAR(60) NOT NULL,
  title       VARCHAR(255) NOT NULL,
  body        TEXT,
  metadata    JSONB,
  severity    VARCHAR(20) NOT NULL DEFAULT 'info'
                CHECK (severity IN ('info', 'warning', 'critical')),
  is_resolved BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_created     ON admin_alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_unresolved  ON admin_alerts(is_resolved, created_at DESC)
  WHERE is_resolved = false;
