-- Run this in the Supabase SQL Editor (after add-player-training-log.sql
-- has already been run). Adds Phase 2-5 of the Techne integration: the
-- coach-uploaded TrainingVideo library, PlayerSkillTest self-recorded
-- scores, and the opt-in leaderboard flag. See
-- techne-integration-research.md for the full plan.

-- 1. Shared, coach-uploaded weekly drill video library (team-scoped).
CREATE TABLE "TrainingVideo" (
  "id"          TEXT PRIMARY KEY,
  "teamId"      TEXT NOT NULL REFERENCES "Team"("id") ON DELETE CASCADE,
  "title"       TEXT NOT NULL,
  "description" TEXT,
  "category"    TEXT,
  "difficulty"  TEXT,
  "videoUrl"    TEXT NOT NULL,
  "weekOf"      TIMESTAMP(3),
  "uploadedByMembershipId" TEXT,
  "position"    INTEGER NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX "TrainingVideo_teamId_idx" ON "TrainingVideo"("teamId");

-- 2. Player-self-recorded skill test scores (distinct from the coach-only
-- PlayerEvaluation QDE ratings).
CREATE TABLE "PlayerSkillTest" (
  "id"         TEXT PRIMARY KEY,
  "playerId"   TEXT NOT NULL REFERENCES "Player"("id") ON DELETE CASCADE,
  "testName"   TEXT NOT NULL,
  "score"      DOUBLE PRECISION NOT NULL,
  "unit"       TEXT NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "note"       TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX "PlayerSkillTest_playerId_idx" ON "PlayerSkillTest"("playerId");
CREATE INDEX "PlayerSkillTest_playerId_testName_idx" ON "PlayerSkillTest"("playerId", "testName");

-- 3. Let a PlayerTrainingLog entry optionally point at a TrainingVideo
-- (in addition to the existing optional pointer at a per-player
-- PlayerVideo) - this table already exists from add-player-training-log.sql.
ALTER TABLE "PlayerTrainingLog"
  ADD COLUMN "trainingVideoId" TEXT REFERENCES "TrainingVideo"("id") ON DELETE SET NULL;
CREATE INDEX "PlayerTrainingLog_trainingVideoId_idx" ON "PlayerTrainingLog"("trainingVideoId");

-- 4. Opt-in flag for the team-scoped leaderboard - off by default, a
-- player/guardian must explicitly turn it on from their own profile.
ALTER TABLE "Player"
  ADD COLUMN "leaderboardOptIn" BOOLEAN NOT NULL DEFAULT false;
