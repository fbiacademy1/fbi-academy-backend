const express = require("express");
const prisma = require("../db");
const { requireAuth, requireTeamMembership, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();
router.use(requireAuth, requireTeamMembership);

// GET /api/events  -> schedule (games, practices, team functions) for the current team
router.get("/", asyncHandler(async (req, res) => {
  const events = await prisma.event.findMany({
    where: { teamId: req.membership.teamId },
    orderBy: { startTime: "asc" },
    include: { rsvps: true },
  });
  res.json(events);
}));

router.get("/:id", asyncHandler(async (req, res) => {
  const event = await prisma.event.findUnique({
    where: { id: req.params.id },
    include: { rsvps: { include: { player: true } } },
  });
  if (!event || event.teamId !== req.membership.teamId) return res.status(404).json({ error: "Event not found" });
  res.json(event);
}));

// POST /api/events  (admin/coach only) - creates a game/practice/team function
// and a pending RSVP row for every player currently on the roster
router.post("/", requireRole("admin", "coach"), asyncHandler(async (req, res) => {
  const { type, title, location, startTime, endTime, notes } = req.body;
  if (!type || !title || !startTime) {
    return res.status(400).json({ error: "type, title, and startTime are required" });
  }

  const event = await prisma.event.create({
    data: {
      teamId: req.membership.teamId,
      type,
      title,
      location,
      startTime: new Date(startTime),
      endTime: endTime ? new Date(endTime) : null,
      notes,
    },
  });

  const players = await prisma.player.findMany({ where: { teamId: req.membership.teamId } });
  if (players.length > 0) {
    await prisma.rSVP.createMany({
      data: players.map((p) => ({ eventId: event.id, playerId: p.id })),
    });
  }

  res.status(201).json(event);
}));

router.put("/:id", requireRole("admin", "coach"), asyncHandler(async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event || event.teamId !== req.membership.teamId) return res.status(404).json({ error: "Event not found" });

  const { type, title, location, startTime, endTime, notes } = req.body;
  const updated = await prisma.event.update({
    where: { id: event.id },
    data: { type, title, location, startTime: startTime ? new Date(startTime) : undefined, endTime: endTime ? new Date(endTime) : undefined, notes },
  });
  res.json(updated);
}));

router.delete("/:id", requireRole("admin", "coach"), asyncHandler(async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event || event.teamId !== req.membership.teamId) return res.status(404).json({ error: "Event not found" });
  await prisma.event.delete({ where: { id: event.id } });
  res.status(204).end();
}));

module.exports = router;
