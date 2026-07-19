const express = require("express");
const prisma = require("../db");
const { requireAuth, requireTeamMembership } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();
router.use(requireAuth, requireTeamMembership);

// GET /api/messages  -> team-wide chat + announcements for the current team, newest first
router.get("/", asyncHandler(async (req, res) => {
  const messages = await prisma.message.findMany({
    where: { teamId: req.membership.teamId },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { authorPlayer: { select: { firstName: true, lastName: true } } },
  });
  res.json(messages);
}));

// POST /api/messages
// Anyone on the team can post to chat; only admin/coach can post as an announcement
// (announcements trigger a push notification to the whole team, see notifications service).
router.post("/", asyncHandler(async (req, res) => {
  const { body, isAnnouncement } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: "Message body is required" });

  if (isAnnouncement && !["admin", "coach"].includes(req.membership.role)) {
    return res.status(403).json({ error: "Only coaches/admins can post announcements" });
  }

  const message = await prisma.message.create({
    data: {
      teamId: req.membership.teamId,
      authorPlayerId: req.membership.playerId || null,
      body: body.trim(),
      isAnnouncement: !!isAnnouncement,
    },
  });

  // TODO: hook up push notifications (Expo Push API) here, especially for announcements.
  res.status(201).json(message);
}));

module.exports = router;
