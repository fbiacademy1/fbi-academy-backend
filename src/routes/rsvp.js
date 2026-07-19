const express = require("express");
const prisma = require("../db");
const { requireAuth, requireTeamMembership } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();
router.use(requireAuth, requireTeamMembership);

// PUT /api/rsvp/:eventId  -> the logged-in player sets their own availability
// body: { status: "yes" | "no" | "maybe" }
router.put("/:eventId", asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!["yes", "no", "maybe", "no_response"].includes(status)) {
    return res.status(400).json({ error: "status must be yes, no, maybe, or no_response" });
  }
  if (!req.membership.playerId) {
    return res.status(400).json({ error: "This account isn't linked to a player profile on this team" });
  }

  const event = await prisma.event.findUnique({ where: { id: req.params.eventId } });
  if (!event || event.teamId !== req.membership.teamId) return res.status(404).json({ error: "Event not found" });

  const rsvp = await prisma.rSVP.upsert({
    where: { eventId_playerId: { eventId: event.id, playerId: req.membership.playerId } },
    update: { status, respondedAt: new Date() },
    create: { eventId: event.id, playerId: req.membership.playerId, status, respondedAt: new Date() },
  });

  res.json(rsvp);
}));

// GET /api/rsvp/:eventId  -> full RSVP roster for an event (coach/admin view)
router.get("/:eventId", asyncHandler(async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.eventId } });
  if (!event || event.teamId !== req.membership.teamId) return res.status(404).json({ error: "Event not found" });

  const rsvps = await prisma.rSVP.findMany({
    where: { eventId: event.id },
    include: { player: { select: { id: true, firstName: true, lastName: true, jerseyNumber: true } } },
  });
  res.json(rsvps);
}));

module.exports = router;
