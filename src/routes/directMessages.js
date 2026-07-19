const express = require("express");
const prisma = require("../db");
const { requireAuth, requireTeamMembership } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();
router.use(requireAuth, requireTeamMembership);

// GET /api/direct-messages/contacts
// Everyone else on the current team who has an app account (i.e. a Membership
// with a userId), so the current user can start/continue a conversation with them.
router.get("/contacts", asyncHandler(async (req, res) => {
  const memberships = await prisma.membership.findMany({
    where: { teamId: req.membership.teamId, userId: { not: req.user.userId } },
    include: { user: true, player: true },
  });

  res.json(
    memberships.map((m) => ({
      userId: m.userId,
      email: m.user.email,
      role: m.role,
      name: m.player ? `${m.player.firstName} ${m.player.lastName}` : m.user.email,
    }))
  );
}));

// GET /api/direct-messages  -> one row per conversation (most recent message with each contact)
router.get("/", asyncHandler(async (req, res) => {
  const messages = await prisma.directMessage.findMany({
    where: {
      teamId: req.membership.teamId,
      OR: [{ senderId: req.user.userId }, { recipientId: req.user.userId }],
    },
    orderBy: { createdAt: "desc" },
  });

  const byContact = new Map();
  for (const m of messages) {
    const otherUserId = m.senderId === req.user.userId ? m.recipientId : m.senderId;
    if (!byContact.has(otherUserId)) byContact.set(otherUserId, m);
  }

  res.json(Array.from(byContact.entries()).map(([otherUserId, lastMessage]) => ({ otherUserId, lastMessage })));
}));

// GET /api/direct-messages/:otherUserId  -> full thread with one specific person
router.get("/:otherUserId", asyncHandler(async (req, res) => {
  const { otherUserId } = req.params;
  const messages = await prisma.directMessage.findMany({
    where: {
      teamId: req.membership.teamId,
      OR: [
        { senderId: req.user.userId, recipientId: otherUserId },
        { senderId: otherUserId, recipientId: req.user.userId },
      ],
    },
    orderBy: { createdAt: "asc" },
  });
  res.json(messages);
}));

// POST /api/direct-messages  -> { recipientId, body }
router.post("/", asyncHandler(async (req, res) => {
  const { recipientId, body } = req.body;
  if (!recipientId || !body || !body.trim()) {
    return res.status(400).json({ error: "recipientId and body are required" });
  }

  const recipientMembership = await prisma.membership.findUnique({
    where: { userId_teamId: { userId: recipientId, teamId: req.membership.teamId } },
  });
  if (!recipientMembership) return res.status(404).json({ error: "That person isn't on this team" });

  const message = await prisma.directMessage.create({
    data: {
      teamId: req.membership.teamId,
      senderId: req.user.userId,
      recipientId,
      body: body.trim(),
    },
  });

  res.status(201).json(message);
}));

module.exports = router;
