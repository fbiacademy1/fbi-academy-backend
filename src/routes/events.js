const express = require("express");
const prisma = require("../db");
const crypto = require("crypto");
const { requireAuth, requireTeamMembership, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();
router.use(requireAuth, requireTeamMembership);

// How many occurrences to generate for each repeat frequency. Fixed rather
// than open-ended so a recurring event can't silently create rows forever;
// a coach can always add more by creating the event again once these run out.
const REPEAT_OCCURRENCES = { daily: 30, weekly: 12, monthly: 6 };
const REPEAT_STEP_MS = {
    daily: 24 * 60 * 60 * 1000,
    weekly: 7 * 24 * 60 * 60 * 1000,
    // Monthly is handled separately (calendar months, not a fixed ms step)
};

function addRepeatOffset(date, freq, occurrenceIndex) {
    if (freq === "monthly") {
          const d = new Date(date);
          d.setMonth(d.getMonth() + occurrenceIndex);
          return d;
    }
    return new Date(date.getTime() + REPEAT_STEP_MS[freq] * occurrenceIndex);
}

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
  const { type, title, location, startTime, endTime, notes, repeat } = req.body;
    if (!type || !title || !startTime) {
          return res.status(400).json({ error: "type, title, and startTime are required" });
    }
    if (repeat && !REPEAT_OCCURRENCES[repeat]) {
          return res.status(400).json({ error: "repeat must be one of: daily, weekly, monthly" });
    }

    const baseStart = new Date(startTime);
    const baseEnd = endTime ? new Date(endTime) : null;
    const occurrenceCount = repeat ? REPEAT_OCCURRENCES[repeat] : 1;
    const recurringId = repeat ? crypto.randomUUID() : null;

    const players = await prisma.player.findMany({ where: { teamId: req.membership.teamId } });

    const createdEvents = [];
    for (let i = 0; i < occurrenceCount; i++) {
          const event = await prisma.event.create({
                  data: {
                            teamId: req.membership.teamId,
                            type,
                            title,
                            location,
                            startTime: repeat ? addRepeatOffset(baseStart, repeat, i) : baseStart,
                            endTime: baseEnd ? (repeat ? addRepeatOffset(baseEnd, repeat, i) : baseEnd) : null,
                            notes,
                            repeatFreq: repeat || null,
                            recurringId,
                  },
          });
          if (players.length > 0) {
                  await prisma.rSVP.createMany({
                            data: players.map((p) => ({ eventId: event.id, playerId: p.id })),
                  });
          }
          createdEvents.push(event);
    }

    res.status(201).json(repeat ? { events: createdEvents, count: createdEvents.length } : createdEvents[0]);
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
