-- Relax Membership's one-row-per-user-per-team rule so a guardian can hold
-- MULTIPLE role:"parent" memberships on the SAME team (one per linked
-- child), while every other role (admin/coach/player) keeps the old
-- one-membership-per-team rule. Run in Supabase SQL Editor - this project's
-- schema is applied by hand rather than via `prisma migrate` / `db push`
-- (see the note at the top of schema.prisma).

ALTER TABLE "Membership" DROP CONSTRAINT IF EXISTS "Membership_userId_teamId_key";

-- admin/coach/player: still exactly one membership per user+team.
CREATE UNIQUE INDEX IF NOT EXISTS "Membership_userId_teamId_nonparent_key"
  ON "Membership" ("userId", "teamId")
  WHERE role <> 'parent';

-- parent: one membership per user+team+child, so a guardian can hold
-- several parent memberships on the same team (one per linked child there).
CREATE UNIQUE INDEX IF NOT EXISTS "Membership_userId_teamId_viewPlayerId_parent_key"
  ON "Membership" ("userId", "teamId", "viewPlayerId")
  WHERE role = 'parent';
