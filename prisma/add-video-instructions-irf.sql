-- Optional "instructions for player" and In-Real-Futbol (IRF) drill link
-- fields on PlayerVideo, ported from the WordPress Player Portal's pp_videos
-- entry shape so nothing is lost in the 2026-09-05 unification (the
-- player-profiles WP plugin's Training Videos section now reads/writes
-- PlayerVideo directly over the shared-secret bridge instead of keeping its
-- own separate copy in pp_videos user meta - see routes/sync.js's
-- /player-videos endpoints and the player-profiles plugin's
-- class-pp-shortcode.php / class-pp-admin-fields.php).
-- Run this in the Supabase SQL Editor for the project's Postgres database.
-- This project's schema is managed by hand, not `prisma migrate` - see the
-- header comment in schema.prisma.

ALTER TABLE "PlayerVideo" ADD COLUMN "instructions" TEXT;
ALTER TABLE "PlayerVideo" ADD COLUMN "irfUrl" TEXT;
