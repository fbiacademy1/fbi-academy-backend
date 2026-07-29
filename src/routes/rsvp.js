const express = require("express");
const prisma = require("../db");
const { requireAuth, requireTeamMembership } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();
router.use(requireAuth, requireTeamMembership);

// PUT /api/rsvp/:eventId  -> the logged-in user sets their own availability
// body: { status: "yes" | "no" | "maybe" }
//
// Players (and parent logins tied to a player) RSVP against their player
// row - that's what gets seeded for every roster player when an event is
// created, so "Team availability" always shows the full roster. Coaches/
// admins aren't rostered as a player, so they RSVP against their own
// membership instead - created here on first response rather than seeded
// up front, since there's no fixed roster of staff to seed against.
router.put("/:eventId", asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!["yes", "no", "maybe", "no_response"].includes(status)) {
    return res.status(400).json({ error: "status must be yes, no, maybe, or no_response" });
  }

  const event = await prisma.event.findUnique({ where: { id: req.params.eventId } });
  if (!event || event.teamId !== req.membership.teamId) return res.status(404).json({ error: "Event not found" });

  const rsvp = req.membership.playerId
    ? await prisma.rSVP.upsert({
        where: { eventId_playerId: { eventId: event.id, playerId: req.membership.playerId } },
        update: { status, respondedAt: new Date() },
        create: { eventId: event.id, playerId: req.membership.playerId, status, respondedAt: new Date() },
      })
    : await prisma.rSVP.upsert({
        where: { eventId_membershipId: { eventId: event.id, membershipId: req.membership.id } },
        update: { status, respondedAt: new Date() },
        create: { eventId: event.id, membershipId: req.membership.id, status, respondedAt: new Date() },
      });

  res.json(rsvp);
}));

// GET /api/rsvp/:eventId  -> full RSVP roster for an event (coach/admin view)
router.get("/:eventId", asyncHandler(async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.eventId } });
  if (!event || event.teamId !== req.membership.teamId) return res.status(404).json({ error: "Event not found" });

  const rsvps = await prisma.rSVP.findMany({
    where: { eventId: event.id },
    include: {
      player: { select: { id: true, firstName: true, lastName: true, jerseyNumber: true } },
      membership: { select: { id: true, role: true, user: { select: { email: true } } } },
    },
  });
  res.json(rsvps);
}));

module.exports = router;
