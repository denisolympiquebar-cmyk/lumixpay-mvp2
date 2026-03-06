-- Migration 016: Fix voucher creator constraint.
--
-- The original schema required created_by_admin_id NOT NULL, but
-- user-purchased vouchers are not created by an admin — they are created
-- by the user themselves.
--
-- New rule: at least ONE of created_by_admin_id or purchased_by_user_id
-- must be set.  Either column may be NULL individually.

-- 1. Drop the NOT NULL constraint on created_by_admin_id
ALTER TABLE vouchers ALTER COLUMN created_by_admin_id DROP NOT NULL;

-- 2. Add the mutual-exclusivity check (idempotent: only add if not already present)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name = 'vouchers'
       AND constraint_name = 'vouchers_creator_check'
  ) THEN
    ALTER TABLE vouchers
      ADD CONSTRAINT vouchers_creator_check CHECK (
        created_by_admin_id IS NOT NULL OR purchased_by_user_id IS NOT NULL
      );
  END IF;
END;
$$;
