-- Player-editable "self profile" fields, ported for feature parity with the
-- WordPress Player Portal (player-profiles plugin's pp_* user meta):
--   pp_height_weight       -> "heightWeight"
--   pp_preferred_foot      -> "preferredFoot"
--   pp_player_notes        -> "improvementNotes" (distinct from the existing
--                              coach-facing "notes" column)
--   pp_favorite_team       -> "favoriteTeamName"
--   pp_favorite_team_photo_id -> "favoriteTeamPhotoUrl"
--   pp_favorite_player     -> "favoritePlayerName" (distinct from the
--                              existing "favoritePlayerPhotoUrl" column)
-- Run this in the Supabase SQL Editor for the project's Postgres database.
-- This project's schema is managed by hand, not `prisma migrate` - see the
-- header comment in schema.prisma.

ALTER TABLE "Player" ADD COLUMN "heightWeight" TEXT;
ALTER TABLE "Player" ADD COLUMN "preferredFoot" TEXT;
ALTER TABLE "Player" ADD COLUMN "improvementNotes" TEXT;
ALTER TABLE "Player" ADD COLUMN "favoriteTeamName" TEXT;
ALTER TABLE "Player" ADD COLUMN "favoriteTeamPhotoUrl" TEXT;
ALTER TABLE "Player" ADD COLUMN "favoritePlayerName" TEXT;
