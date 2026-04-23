-- ─────────────────────────────────────────────────────────────────────────────
-- 023_unique_username_ci.sql
-- Enforce case-insensitive uniqueness on usernames.
--
-- Context:
--   Migration 004 added `username VARCHAR(30) UNIQUE` (case-sensitive).
--   The application-layer validation enforces lowercase-only usernames
--   (regex ^[a-z0-9_]+$), so in practice the existing constraint is already
--   case-insensitively unique.  This migration adds a formal CI unique index
--   as belt-and-suspenders protection against any bypass of that constraint.
--
-- Safety:
--   1. A pre-check reports any existing CI duplicates as a WARNING before
--      attempting to create the index.
--   2. If duplicates exist the CREATE UNIQUE INDEX will fail loudly.
--      Resolve duplicates manually (e.g. rename one with UPDATE users SET
--      username = NULL WHERE id = '<id>') and re-run this migration.
--   3. The existing case-sensitive UNIQUE constraint from migration 004 is
--      kept intact — both constraints are complementary.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  conflict_count INT;
  conflict_list  TEXT;
BEGIN
  -- Count groups where two or more rows share the same lowercased username
  SELECT COUNT(*)
    INTO conflict_count
    FROM (
      SELECT LOWER(username) AS lu
        FROM users
       WHERE username IS NOT NULL
       GROUP BY LOWER(username)
      HAVING COUNT(*) > 1
    ) dupes;

  IF conflict_count > 0 THEN
    SELECT string_agg(lu || ' (' || cnt || ' rows)', ', ')
      INTO conflict_list
      FROM (
        SELECT LOWER(username) AS lu, COUNT(*) AS cnt
          FROM users
         WHERE username IS NOT NULL
         GROUP BY LOWER(username)
        HAVING COUNT(*) > 1
      ) dupes2;

    RAISE WARNING
      'DUPLICATE_USERNAME_CONFLICT: % case-insensitive duplicate username group(s) found before migration 023. '
      'The subsequent CREATE UNIQUE INDEX will fail. '
      'Resolve by running: UPDATE users SET username = NULL WHERE username = ''<dup>'' AND id = ''<id_to_clear>''; '
      'Affected groups: %',
      conflict_count, conflict_list;
  END IF;
END $$;

-- Formal case-insensitive unique index.
-- Fails if CI duplicates exist — see pre-check WARNING above.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_ci
  ON users (LOWER(username))
  WHERE username IS NOT NULL;
