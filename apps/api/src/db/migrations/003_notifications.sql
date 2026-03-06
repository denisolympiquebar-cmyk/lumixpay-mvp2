-- ─────────────────────────────────────────────────────────────────────────────
-- 003_notifications.sql — per-user notification inbox
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE notifications (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       VARCHAR(60)  NOT NULL,
  -- Known types: topup.completed, transfer.sent, transfer.received,
  --   withdrawal.requested, withdrawal.approved, withdrawal.rejected,
  --   withdrawal.settled, voucher.redeemed, payment_link.paid, recurring.executed
  title      VARCHAR(255) NOT NULL,
  body       TEXT,
  metadata   JSONB,
  is_read    BOOLEAN      NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_user   ON notifications(user_id, created_at DESC);
CREATE INDEX idx_notifications_unread ON notifications(user_id, is_read)
  WHERE is_read = false;
