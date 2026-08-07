-- Player/parent-submitted "skill video" review queue (trick-video feature).
-- See PlayerSkillVideo in schema.prisma for the full comment/rationale.

CREATE TABLE "PlayerSkillVideo" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "title" TEXT,
    "videoUrl" TEXT NOT NULL,
    "submittedByMembershipId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "coachNotes" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayerSkillVideo_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PlayerSkillVideo"
    ADD CONSTRAINT "PlayerSkillVideo_teamId_fkey"
    FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PlayerSkillVideo"
    ADD CONSTRAINT "PlayerSkillVideo_playerId_fkey"
    FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "PlayerSkillVideo_teamId_idx" ON "PlayerSkillVideo"("teamId");
CREATE INDEX "PlayerSkillVideo_playerId_idx" ON "PlayerSkillVideo"("playerId");
CREATE INDEX "PlayerSkillVideo_status_idx" ON "PlayerSkillVideo"("status");
