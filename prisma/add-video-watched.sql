-- Player-toggled "watched" mark on PlayerVideo, ported for feature parity
-- with the WordPress Player Portal's pp_watched_videos user meta.
-- Run this in the Supabase SQL Editor for the project's Postgres database.
-- This project's schema is managed by hand, not `prisma migrate` - see the
-- header comment in schema.prisma.

ALTER TABLE "PlayerVideo" ADD COLUMN "watchedAt" TIMESTAMP(3);
