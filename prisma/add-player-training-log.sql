-- Run this in the Supabase SQL Editor to add the new PlayerTrainingLog
-- table (Techne-style self-training log: Phase 1 of the Player Profile
-- integration - see techne-integration-research.md). This project's
-- schema is applied by hand rather than via `prisma migrate` / `db push`,
-- so nothing here can diff against the other apps' tables sharing this
-- Supabase project (see the note at the top of schema.prisma).

CREATE TABLE "PlayerTrainingLog" (
  "id"        TEXT PRIMARY KEY,
  "playerId"  TEXT NOT NULL REFERENCES "Player"("id") ON DELETE CASCADE,
  "videoId"   TEXT REFERENCES "PlayerVideo"("id") ON DELETE SET NULL,
  "minutes"   INTEGER NOT NULL,
  "loggedAt"  TIMESTAMP(3) NOT NULL DEFAULT now(),
  "note"      TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);

CREATE INDEX "PlayerTrainingLog_playerId_idx" ON "PlayerTrainingLog"("playerId");
CREATE INDEX "PlayerTrainingLog_videoId_idx" ON "PlayerTrainingLog"("videoId");
