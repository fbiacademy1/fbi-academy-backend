const express = require("express");
const prisma = require("../db");
const { requireAuth, requireTeamMembership, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { sendEmail } = require("../services/outboundNotifications");
const { sendUserNotification } = require("../services/pushNotifications");

const router = express.Router();

// ---------------------------------------------------------------------
// Public: the fbiacademy.org website's showcase of approved + featured
// trick videos. No auth, not team-scoped - this is a single site-wide
// gallery, same pattern as the FBI Family media feature.
// ---------------------------------------------------------------------

// GET /api/skill-videos/featured
router.get("/featured", asyncHandler(async (req, res) => {
  const videos = await prisma.playerSkillVideo.findMany({
    where: { status: "approved", featured: true },
    include: { player: { select: { firstName: true, lastName: true, teamId: true, team: { select: { name: true } } } } },
    orderBy: { reviewedAt: "desc" },
  });
  res.json(
    videos.map((v) => ({
      id: v.id,
      title: v.title,
      videoUrl: v.videoUrl,
      playerName: `${v.player.firstName} ${v.player.lastName}`,
      teamName: v.player.team.name,
    }))
  );
}));

// ---------------------------------------------------------------------
// Everything below is team-scoped and requires login - a player/parent
// submitting their own kid's clip, or a coach/admin running the review
// queue for their team.
// ---------------------------------------------------------------------
router.use(requireAuth, requireTeamMembership);

// Resolves which playerId the caller is allowed to submit/view for
// themselves: a player submits for themselves, a parent for whichever
// child that specific Membership is linked to (viewPlayerId - see the
// comment on Membership.viewPlayerId), admin/coach aren't tied to one.
function ownPlayerId(membership) {
  if (membership.role === "player") return membership.playerId;
  if (membership.role === "parent") return membership.viewPlayerId;
  return null;
}

// POST /api/skill-videos - submit a new trick video for review.
// body: { playerId, title?, videoUrl }
// Players/parents may only submit for their own linked player; admin/coach
// may submit on behalf of any player on the roster (e.g. a coach who
// filmed a clip at practice).
router.post("/", asyncHandler(async (req, res) => {
  const { playerId, title, videoUrl } = req.body;
  if (!playerId || !videoUrl) {
    return res.status(400).json({ error: "playerId and videoUrl are required" });
  }

  const isStaff = req.membership.role === "admin" || req.membership.role === "coach";
  if (!isStaff && ownPlayerId(req.membership) !== playerId) {
    return res.status(403).json({ error: "You can only submit a video for your own player" });
  }

  const player = await prisma.player.findUnique({ where: { id: playerId } });
  if (!player || player.teamId !== req.membership.teamId) {
    return res.status(404).json({ error: "Player not found on this team" });
  }

  const video = await prisma.playerSkillVideo.create({
    data: {
      teamId: req.membership.teamId,
      playerId,
      title: title || null,
      videoUrl,
      submittedByMembershipId: req.membership.id,
    },
  });

  // Notify every coach/admin on the team that a submission is waiting on
  // them - fire-and-forget, same as the Personal Training booking flow.
  prisma.membership
    .findMany({
      where: { teamId: req.membership.teamId, role: { in: ["admin", "coach"] } },
      include: { user: true },
    })
    .then((staff) => {
      const when = `${player.firstName} ${player.lastName}`;
      Promise.allSettled(
        staff.flatMap((m) => [
          sendUserNotification(m.userId, {
            title: "New trick video submitted",
            body: `${when} submitted a video for review`,
            data: { type: "skill_video", videoId: video.id },
          }),
          sendEmail(
            m.user.email,
            "New trick video submitted for review",
            `${when} submitted a new trick video${title ? ` ("${title}")` : ""}. Review it in the TeamSync app under Skill Video Review.`
          ),
        ])
      ).catch(() => {});
    })
    .catch(() => {});

  res.status(201).json(video);
}));

// GET /api/skill-videos/mine - the caller's own submissions (any role),
// so a player/parent can see the status of clips they've sent in.
router.get("/mine", asyncHandler(async (req, res) => {
  const videos = await prisma.playerSkillVideo.findMany({
    where: { submittedByMembershipId: req.membership.id },
    orderBy: { createdAt: "desc" },
  });
  res.json(videos);
}));

// GET /api/skill-videos - coach/admin review queue for the active team.
// Optional ?status=pending|approved|rejected filter (default: all).
router.get("/", requireRole("admin", "coach"), asyncHandler(async (req, res) => {
  const where = { teamId: req.membership.teamId };
  if (req.query.status) where.status = req.query.status;

  const videos = await prisma.playerSkillVideo.findMany({
    where,
    include: { player: { select: { firstName: true, lastName: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(
    videos.map((v) => ({
      ...v,
      player: undefined,
      playerName: `${v.player.firstName} ${v.player.lastName}`,
    }))
  );
}));

// PUT /api/skill-videos/:id/review - approve or reject a submission.
// body: { status: "approved" | "rejected", coachNotes? }
router.put("/:id/review", requireRole("admin", "coach"), asyncHandler(async (req, res) => {
  const { status, coachNotes } = req.body;
  if (!["approved", "rejected"].includes(status)) {
    return res.status(400).json({ error: 'status must be "approved" or "rejected"' });
  }

  const video = await prisma.playerSkillVideo.findUnique({ where: { id: req.params.id } });
  if (!video || video.teamId !== req.membership.teamId) {
    return res.status(404).json({ error: "Video not found" });
  }

  const updated = await prisma.playerSkillVideo.update({
    where: { id: video.id },
    data: { status, coachNotes: coachNotes ?? video.coachNotes, reviewedAt: new Date() },
  });
  res.json(updated);
}));

// PUT /api/skill-videos/:id/feature - toggle whether an approved video is
// shown on the public fbiacademy.org showcase. body: { featured: boolean }
router.put("/:id/feature", requireRole("admin", "coach"), asyncHandler(async (req, res) => {
  const video = await prisma.playerSkillVideo.findUnique({ where: { id: req.params.id } });
  if (!video || video.teamId !== req.membership.teamId) {
    return res.status(404).json({ error: "Video not found" });
  }
  if (video.status !== "approved" && req.body.featured) {
    return res.status(400).json({ error: "Only an approved video can be featured" });
  }

  const updated = await prisma.playerSkillVideo.update({
    where: { id: video.id },
    data: { featured: !!req.body.featured },
  });
  res.json(updated);
}));

// DELETE /api/skill-videos/:id - remove a submission entirely.
router.delete("/:id", requireRole("admin", "coach"), asyncHandler(async (req, res) => {
  const video = await prisma.playerSkillVideo.findUnique({ where: { id: req.params.id } });
  if (!video || video.teamId !== req.membership.teamId) {
    return res.status(404).json({ error: "Video not found" });
  }
  await prisma.playerSkillVideo.delete({ where: { id: video.id } });
  res.status(204).end();
}));

module.exports = router;
