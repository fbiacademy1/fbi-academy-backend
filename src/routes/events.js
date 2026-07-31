const express = require("express");
const crypto = require("crypto");
const prisma = require("../db");
const { requireAuth, requireTeamMembership, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { sendTeamNotification } = require("../services/pushNotifications");
const { notifyEventToFamilies } = require("../services/outboundNotifications");

const TYPE_LABELS = { game: "Match", practice: "Training", event: "Team Function" };

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
    include: { rsvps: { include: { player: true, membership: { include: { user: true } } } } },
  });
  if (!event || event.teamId !== req.membership.teamId) return res.status(404).json({ error: "Event not found" });
  res.json(event);
}));

// POST /api/events  (admin/coach only) - creates a game/practice/team function
// and a pending RSVP row for every player currently on the roster. If
// `repeat` is "daily" | "weekly" | "monthly", generates a fixed number of
// future occurrences (see REPEAT_OCCURRENCES) instead of just one, all
// sharing a recurringId and each getting its own RSVP rows.
//
// For matches, `homeAway` ("home" | "away") is optional alongside `opponent`.
// When set, the team's default uniform colors (see Team Settings) are
// snapshotted onto jerseyColor/shortsColor/socksColor at creation time.
//
// `repeatEndDate`, if given alongside `repeat`, stops generating occurrences
// once an occurrence's start time would fall after it - an early cutoff on
// top of (never beyond) the REPEAT_OCCURRENCES cap below.
router.post("/", requireRole("admin", "coach"), asyncHandler(async (req, res) => {
  const {
    type, title, location, startTime, endTime, notes, repeat, repeatEndDate, opponent, homeAway,
    locationDetails, timeTbd, arriveEarlyMinutes, extraLabel, flagColor, trackAvailability, notForStandings, notifyTeam,
  } = req.body;
  if (!type || !title || !startTime) {
    return res.status(400).json({ error: "type, title, and startTime are required" });
  }
  if (repeat && !REPEAT_OCCURRENCES[repeat]) {
    return res.status(400).json({ error: "repeat must be one of: daily, weekly, monthly" });
  }
  if (homeAway && !["home", "away"].includes(homeAway)) {
    return res.status(400).json({ error: "homeAway must be 'home' or 'away'" });
  }

  const baseStart = new Date(startTime);
  const baseEnd = endTime ? new Date(endTime) : null;
  const occurrenceCount = repeat ? REPEAT_OCCURRENCES[repeat] : 1;
  const recurringId = repeat ? crypto.randomUUID() : null;
  const repeatEnd = repeat && repeatEndDate ? new Date(repeatEndDate) : null;

  let jerseyColor = null;
  let shortsColor = null;
  let socksColor = null;
  if (homeAway) {
    const team = await prisma.team.findUnique({ where: { id: req.membership.teamId } });
    if (homeAway === "home") {
      jerseyColor = team?.homeJerseyColor || null;
      shortsColor = team?.homeShortsColor || null;
      socksColor = team?.homeSocksColor || null;
    } else {
      jerseyColor = team?.awayJerseyColor || null;
      shortsColor = team?.awayShortsColor || null;
      socksColor = team?.awaySocksColor || null;
    }
  }

  const players = await prisma.player.findMany({ where: { teamId: req.membership.teamId } });
  const shouldTrack = trackAvailability !== false; // defaults to true

  const createdEvents = [];
  for (let i = 0; i < occurrenceCount; i++) {
    const occStart = repeat ? addRepeatOffset(baseStart, repeat, i) : baseStart;
    if (repeatEnd && occStart > repeatEnd) break;
    const event = await prisma.event.create({
      data: {
        teamId: req.membership.teamId,
        type,
        title,
        location,
        startTime: occStart,
        endTime: baseEnd ? (repeat ? addRepeatOffset(baseEnd, repeat, i) : baseEnd) : null,
        notes,
        repeatFreq: repeat || null,
        recurringId,
        opponent: opponent || null,
        homeAway: homeAway || null,
        jerseyColor,
        shortsColor,
        socksColor,
        locationDetails: locationDetails || null,
        timeTbd: !!timeTbd,
        arriveEarlyMinutes: arriveEarlyMinutes || null,
        extraLabel: extraLabel || null,
        flagColor: flagColor || null,
        trackAvailability: shouldTrack,
        notForStandings: !!notForStandings,
        notifyTeam: !!notifyTeam,
      },
    });
    if (shouldTrack && players.length > 0) {
      await prisma.rSVP.createMany({
        data: players.map((p) => ({ eventId: event.id, playerId: p.id })),
      });
    }
    createdEvents.push(event);
  }

  if (notifyTeam && createdEvents.length > 0) {
    const first = createdEvents[0];
    const typeLabel = TYPE_LABELS[type] || type;
    const when = first.startTime.toLocaleString
      ? first.startTime.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : new Date(first.startTime).toLocaleString();
    const bodyText = repeat ? `Starts ${when} - repeats ${repeat}` : `${when}${location ? ` - ${location}` : ""}`;
    sendTeamNotification(
      req.membership.teamId,
      {
        title: `New ${typeLabel}: ${title}`,
        body: bodyText,
        data: { eventId: first.id },
      },
      req.user.userId
    );
    notifyEventToFamilies(players, {
      subject: `New ${typeLabel}: ${title}`,
      body: `New ${typeLabel}: ${title}\n${bodyText}`,
    });
  }

  res.status(201).json(repeat ? { events: createdEvents, count: createdEvents.length } : createdEvents[0]);
}));

router.put("/:id", requireRole("admin", "coach"), asyncHandler(async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event || event.teamId !== req.membership.teamId) return res.status(404).json({ error: "Event not found" });

  const {
    type, title, location, startTime, endTime, notes, opponent, homeAway,
    locationDetails, timeTbd, arriveEarlyMinutes, extraLabel, flagColor, trackAvailability, notForStandings, canceled,
    notifyTeam,
  } = req.body;
  if (homeAway && !["home", "away"].includes(homeAway)) {
    return res.status(400).json({ error: "homeAway must be 'home' or 'away'" });
  }

  let uniformUpdate = {};
  if (homeAway && homeAway !== event.homeAway) {
    const team = await prisma.team.findUnique({ where: { id: req.membership.teamId } });
    uniformUpdate =
      homeAway === "home"
        ? { jerseyColor: team?.homeJerseyColor || null, shortsColor: team?.homeShortsColor || null, socksColor: team?.homeSocksColor || null }
        : { jerseyColor: team?.awayJerseyColor || null, shortsColor: team?.awayShortsColor || null, socksColor: team?.awaySocksColor || null };
  }

  const updated = await prisma.event.update({
    where: { id: event.id },
    data: {
      type,
      title,
      location,
      startTime: startTime ? new Date(startTime) : undefined,
      endTime: endTime ? new Date(endTime) : undefined,
      notes,
      opponent: opponent !== undefined ? opponent || null : undefined,
      homeAway: homeAway !== undefined ? homeAway || null : undefined,
      locationDetails: locationDetails !== undefined ? locationDetails || null : undefined,
      timeTbd: timeTbd !== undefined ? !!timeTbd : undefined,
      arriveEarlyMinutes: arriveEarlyMinutes !== undefined ? arriveEarlyMinutes || null : undefined,
      extraLabel: extraLabel !== undefined ? extraLabel || null : undefined,
      flagColor: flagColor !== undefined ? flagColor || null : undefined,
      trackAvailability: trackAvailability !== undefined ? !!trackAvailability : undefined,
      notForStandings: notForStandings !== undefined ? !!notForStandings : undefined,
      canceled: canceled !== undefined ? !!canceled : undefined,
      ...uniformUpdate,
    },
  });

  if (notifyTeam) {
    const typeLabel = TYPE_LABELS[updated.type] || updated.type;
    const when = updated.startTime.toLocaleString
      ? updated.startTime.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : new Date(updated.startTime).toLocaleString();
    const bodyText = `${when}${updated.location ? ` - ${updated.location}` : ""}${canceled ? " (CANCELED)" : ""}`;
    sendTeamNotification(
      req.membership.teamId,
      {
        title: `Updated ${typeLabel}: ${updated.title}`,
        body: bodyText,
        data: { eventId: updated.id },
      },
      req.user.userId
    );
    const players = await prisma.player.findMany({ where: { teamId: req.membership.teamId } });
    notifyEventToFamilies(players, {
      subject: `Updated ${typeLabel}: ${updated.title}`,
      body: `Updated ${typeLabel}: ${updated.title}\n${bodyText}`,
    });
  }

  res.json(updated);
}));

router.delete("/:id", requireRole("admin", "coach"), asyncHandler(async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event || event.teamId !== req.membership.teamId) return res.status(404).json({ error: "Event not found" });
  // Every event gets an RSVP row per roster player at creation time, and
  // RSVP has a required FK to Event with no cascade delete at the DB level
  // - deleting the event directly violates that FK and fails with a
  // generic 500. VolunteerRole has the same required-FK relationship.
  // Clean those up first, and independently of each other, so a problem
  // with one dependent table can't block deleting the other or the event.
  try {
    await prisma.rSVP.deleteMany({ where: { eventId: event.id } });
  } catch (err) {
    console.error(`Failed to delete RSVPs for event ${event.id}:`, err);
  }
  try {
    await prisma.volunteerRole.deleteMany({ where: { eventId: event.id } });
  } catch (err) {
    console.error(`Failed to delete volunteer roles for event ${event.id}:`, err);
  }
  await prisma.event.delete({ where: { id: event.id } });
  res.status(204).end();
}));

// --- Volunteer Assignments ---
// A coach defines volunteer role slots for an event (e.g. "Snacks",
// "Equipment") and can optionally assign each to a roster member. Managed
// after the event exists (not during creation) - simplest flow, and avoids
// needing an eventId before the event is actually saved.

// GET /api/events/:eventId/volunteers - any team member can view assignments
router.get("/:eventId/volunteers", asyncHandler(async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.eventId } });
  if (!event || event.teamId !== req.membership.teamId) return res.status(404).json({ error: "Event not found" });

  const roles = await prisma.volunteerRole.findMany({
    where: { eventId: event.id },
    include: { assignedMembership: { include: { player: true, user: true } } },
    orderBy: { createdAt: "asc" },
  });
  res.json(roles);
}));

// POST /api/events/:eventId/volunteers  (admin/coach only) - add a role slot
router.post("/:eventId/volunteers", requireRole("admin", "coach"), asyncHandler(async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.params.eventId } });
  if (!event || event.teamId !== req.membership.teamId) return res.status(404).json({ error: "Event not found" });

  const { title, assignedMembershipId, notes } = req.body;
  if (!title) return res.status(400).json({ error: "title is required" });

  const role = await prisma.volunteerRole.create({
    data: { eventId: event.id, title, assignedMembershipId: assignedMembershipId || null, notes: notes || null },
  });
  res.status(201).json(role);
}));

// PUT /api/events/volunteer-roles/:id  (admin/coach only) - edit or (re)assign a role slot
router.put("/volunteer-roles/:id", requireRole("admin", "coach"), asyncHandler(async (req, res) => {
  const role = await prisma.volunteerRole.findUnique({ where: { id: req.params.id }, include: { event: true } });
  if (!role || role.event.teamId !== req.membership.teamId) return res.status(404).json({ error: "Volunteer role not found" });

  const { title, assignedMembershipId, notes } = req.body;
  const updated = await prisma.volunteerRole.update({
    where: { id: role.id },
    data: {
      title: title !== undefined ? title : undefined,
      assignedMembershipId: assignedMembershipId !== undefined ? assignedMembershipId || null : undefined,
      notes: notes !== undefined ? notes || null : undefined,
    },
  });
  res.json(updated);
}));

// DELETE /api/events/volunteer-roles/:id  (admin/coach only)
router.delete("/volunteer-roles/:id", requireRole("admin", "coach"), asyncHandler(async (req, res) => {
  const role = await prisma.volunteerRole.findUnique({ where: { id: req.params.id }, include: { event: true } });
  if (!role || role.event.teamId !== req.membership.teamId) return res.status(404).json({ error: "Volunteer role not found" });
  await prisma.volunteerRole.delete({ where: { id: role.id } });
  res.status(204).end();
}));

module.exports = router;
