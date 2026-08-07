const express = require("express");
const prisma = require("../db");
const { requireAuth } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { sendEmail, sendSms } = require("../services/outboundNotifications");
const { sendUserNotification } = require("../services/pushNotifications");
const jwt = require("jsonwebtoken");

const router = express.Router();

// A coach/admin on at least one team is allowed to run a Personal Training
// profile - PT isn't team-scoped itself, but this keeps it restricted to
// real staff rather than any player/parent login.
async function isCoachOrAdmin(userId) {
  const membership = await prisma.membership.findFirst({
    where: { userId, role: { in: ["admin", "coach"] } },
  });
  return !!membership;
}

// If a request happens to carry a valid TeamSync JWT (the mobile/web app
// booking flow, where the requester is already logged in), pull their
// userId so it can be attached to the booking. A public website visitor
// won't send one at all - that's fine, this just returns null.
function optionalUserId(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET).userId;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Public: browsing coaches + booking a session. No auth required - these
// back both the fbiacademy.org Personal Training page (anonymous visitors)
// and the TeamSync app's booking screen (logged-in users, who just also
// happen to send a token - see optionalUserId above).
// ---------------------------------------------------------------------

// GET /api/personal-training/coaches - every coach currently accepting PT bookings.
router.get("/coaches", asyncHandler(async (req, res) => {
  const profiles = await prisma.personalTrainingProfile.findMany({
    where: { enabled: true },
    select: {
      id: true,
      displayName: true,
      photoUrl: true,
      bio: true,
      individualRate: true,
      groupRate: true,
    },
    orderBy: { displayName: "asc" },
  });
  res.json(profiles);
}));

// GET /api/personal-training/coaches/:profileId/availability - open slots
// (not yet full, in the future) for the next 60 days.
router.get("/coaches/:profileId/availability", asyncHandler(async (req, res) => {
  const profile = await prisma.personalTrainingProfile.findUnique({ where: { id: req.params.profileId } });
  if (!profile || !profile.enabled) return res.status(404).json({ error: "Coach not found" });

  const now = new Date();
  const horizon = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
  const slots = await prisma.pTAvailabilitySlot.findMany({
    where: {
      profileId: profile.id,
      startTime: { gte: now, lte: horizon },
    },
    orderBy: { startTime: "asc" },
  });
  // Only expose seats-left, not the raw capacity/bookedCount internals.
  res.json(
    slots
      .map((s) => ({
        id: s.id,
        startTime: s.startTime,
        endTime: s.endTime,
        sessionType: s.sessionType,
        seatsTotal: s.capacity,
        seatsLeft: s.capacity - s.bookedCount,
      }))
      .filter((s) => s.seatsLeft > 0)
  );
}));

// POST /api/personal-training/bookings - book one seat in a slot.
// body: { slotId, requesterName, requesterEmail, requesterPhone?, playerName?, notes? }
// Atomically claims a seat (raw UPDATE guarded by capacity) so two
// simultaneous bookers can never both land the last open spot, then
// notifies the coach (push + email) and confirms to the requester (email).
router.post("/bookings", asyncHandler(async (req, res) => {
  const { slotId, requesterName, requesterEmail, requesterPhone, playerName, notes } = req.body;
  if (!slotId || !requesterName || !requesterEmail) {
    return res.status(400).json({ error: "slotId, requesterName, and requesterEmail are required" });
  }

  const requesterUserId = optionalUserId(req);

  const result = await prisma.$transaction(async (tx) => {
    const affected = await tx.$executeRaw`
      UPDATE "PTAvailabilitySlot"
      SET "bookedCount" = "bookedCount" + 1
      WHERE id = ${slotId} AND "bookedCount" < capacity
    `;
    if (affected === 0) return null;

    const slot = await tx.pTAvailabilitySlot.findUnique({ where: { id: slotId } });
    const booking = await tx.pTBooking.create({
      data: {
        slotId,
        profileId: slot.profileId,
        requesterName,
        requesterEmail,
        requesterPhone: requesterPhone || null,
        playerName: playerName || null,
        requesterUserId,
        notes: notes || null,
      },
    });
    return { booking, slot };
  });

  if (!result) {
    return res.status(409).json({ error: "Sorry, that session just filled up. Please pick another time." });
  }

  const profile = await prisma.personalTrainingProfile.findUnique({
    where: { id: result.slot.profileId },
    include: { user: true },
  });

  const when = `${new Date(result.slot.startTime).toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  })}`;
  const sessionLabel = result.slot.sessionType === "group" ? "small-group" : "individual";

  // Fire-and-forget - a notification failure should never fail the booking
  // the requester already has confirmed.
  Promise.allSettled([
    sendEmail(
      profile.user.email,
      "New Personal Training booking",
      `${requesterName} booked a ${sessionLabel} session with you on ${when}.\nContact: ${requesterEmail}${requesterPhone ? ", " + requesterPhone : ""}${playerName ? `\nPlayer: ${playerName}` : ""}${notes ? `\nNotes: ${notes}` : ""}`
    ),
    profile.phone
      ? sendSms(profile.phone, `New PT booking: ${requesterName} on ${when}. Check your email for details.`)
      : Promise.resolve(),
    sendUserNotification(profile.userId, {
      title: "New Personal Training booking",
      body: `${requesterName} booked ${when}`,
      data: { type: "pt_booking", bookingId: result.booking.id },
    }),
    sendEmail(
      requesterEmail,
      "Personal Training session confirmed",
      `You're booked for a ${sessionLabel} session with ${profile.displayName} on ${when}.\nRate: $${sessionLabel === "small-group" ? profile.groupRate : profile.individualRate}/hr, payable directly to the coach.`
    ),
  ]).catch(() => {});

  res.status(201).json(result.booking);
}));

// ---------------------------------------------------------------------
// Coach-facing: manage own profile, availability, and bookings. Not
// team-scoped, so this uses requireAuth only (not requireTeamMembership) -
// eligibility is checked inline via isCoachOrAdmin.
// ---------------------------------------------------------------------
router.use(requireAuth);

// GET /api/personal-training/profile - the logged-in user's own PT profile
// (null if they haven't set one up yet), plus whether they're eligible to.
router.get("/profile", asyncHandler(async (req, res) => {
  const [profile, eligible] = await Promise.all([
    prisma.personalTrainingProfile.findUnique({ where: { userId: req.user.userId } }),
    isCoachOrAdmin(req.user.userId),
  ]);
  res.json({ profile, eligible });
}));

// PUT /api/personal-training/profile - create or update the caller's own profile.
router.put("/profile", asyncHandler(async (req, res) => {
  if (!(await isCoachOrAdmin(req.user.userId))) {
    return res.status(403).json({ error: "Only a coach/admin can set up Personal Training" });
  }
  const { displayName, photoUrl, bio, phone, individualRate, groupRate, enabled } = req.body;
  if (!displayName || individualRate == null) {
    return res.status(400).json({ error: "displayName and individualRate are required" });
  }

  const profile = await prisma.personalTrainingProfile.upsert({
    where: { userId: req.user.userId },
    update: {
      displayName,
      photoUrl: photoUrl ?? null,
      bio: bio ?? null,
      phone: phone ?? null,
      individualRate,
      groupRate: groupRate ?? null,
      enabled: enabled ?? true,
    },
    create: {
      userId: req.user.userId,
      displayName,
      photoUrl: photoUrl ?? null,
      bio: bio ?? null,
      phone: phone ?? null,
      individualRate,
      groupRate: groupRate ?? null,
      enabled: enabled ?? true,
    },
  });
  res.json(profile);
}));

// Looks up the caller's own profile or 404s - shared by the slot/booking
// management routes below, all of which act on "my" profile.
async function ownProfileOr404(req, res) {
  const profile = await prisma.personalTrainingProfile.findUnique({ where: { userId: req.user.userId } });
  if (!profile) {
    res.status(404).json({ error: "Set up your Personal Training profile first" });
    return null;
  }
  return profile;
}

// POST /api/personal-training/profile/slots - add one or more availability
// slots at once. body: { slots: [{ startTime, endTime, sessionType?, capacity? }, ...] }
router.post("/profile/slots", asyncHandler(async (req, res) => {
  const profile = await ownProfileOr404(req, res);
  if (!profile) return;

  const slots = Array.isArray(req.body.slots) ? req.body.slots : null;
  if (!slots || slots.length === 0) {
    return res.status(400).json({ error: "slots (array) is required" });
  }
  for (const s of slots) {
    if (!s.startTime || !s.endTime) {
      return res.status(400).json({ error: "Each slot needs startTime and endTime" });
    }
  }

  await prisma.pTAvailabilitySlot.createMany({
    data: slots.map((s) => ({
      profileId: profile.id,
      startTime: new Date(s.startTime),
      endTime: new Date(s.endTime),
      sessionType: s.sessionType === "group" ? "group" : "individual",
      capacity: s.sessionType === "group" ? Math.max(2, parseInt(s.capacity, 10) || 4) : 1,
    })),
  });

  const created = await prisma.pTAvailabilitySlot.findMany({
    where: { profileId: profile.id },
    orderBy: { startTime: "asc" },
  });
  res.status(201).json(created);
}));

// GET /api/personal-training/profile/slots - the coach's own slots
// (future and past), so they can see what's already open and how full it
// is before adding more or deleting an unbooked one.
router.get("/profile/slots", asyncHandler(async (req, res) => {
  const profile = await ownProfileOr404(req, res);
  if (!profile) return;

  const slots = await prisma.pTAvailabilitySlot.findMany({
    where: { profileId: profile.id },
    orderBy: { startTime: "asc" },
  });
  res.json(slots);
}));

// DELETE /api/personal-training/profile/slots/:id - remove a slot that has
// no bookings yet.
router.delete("/profile/slots/:id", asyncHandler(async (req, res) => {
  const profile = await ownProfileOr404(req, res);
  if (!profile) return;

  const slot = await prisma.pTAvailabilitySlot.findUnique({ where: { id: req.params.id } });
  if (!slot || slot.profileId !== profile.id) return res.status(404).json({ error: "Slot not found" });
  if (slot.bookedCount > 0) {
    return res.status(400).json({ error: "Can't delete a slot that already has bookings - cancel the booking(s) first" });
  }

  await prisma.pTAvailabilitySlot.delete({ where: { id: slot.id } });
  res.status(204).end();
}));

// GET /api/personal-training/profile/bookings - the coach's own upcoming +
// past bookings, most recent slot first.
router.get("/profile/bookings", asyncHandler(async (req, res) => {
  const profile = await ownProfileOr404(req, res);
  if (!profile) return;

  const bookings = await prisma.pTBooking.findMany({
    where: { profileId: profile.id, status: "confirmed" },
    include: { slot: true },
    orderBy: { slot: { startTime: "asc" } },
  });
  res.json(bookings);
}));

// DELETE /api/personal-training/bookings/:id - coach cancels a booking,
// freeing the seat back up and letting the requester know.
router.delete("/bookings/:id", asyncHandler(async (req, res) => {
  const profile = await ownProfileOr404(req, res);
  if (!profile) return;

  const booking = await prisma.pTBooking.findUnique({ where: { id: req.params.id }, include: { slot: true } });
  if (!booking || booking.profileId !== profile.id) return res.status(404).json({ error: "Booking not found" });
  if (booking.status === "canceled") return res.status(400).json({ error: "Already canceled" });

  await prisma.$transaction([
    prisma.pTBooking.update({ where: { id: booking.id }, data: { status: "canceled" } }),
    prisma.pTAvailabilitySlot.update({
      where: { id: booking.slotId },
      data: { bookedCount: { decrement: 1 } },
    }),
  ]);

  const when = new Date(booking.slot.startTime).toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  sendEmail(
    booking.requesterEmail,
    "Personal Training session canceled",
    `Your session with ${profile.displayName} on ${when} was canceled by the coach. Please reach out to reschedule.`
  ).catch(() => {});

  res.status(204).end();
}));

module.exports = router;
