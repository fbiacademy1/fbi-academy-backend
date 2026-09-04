const express = require("express");
const bcrypt = require("bcryptjs");
const prisma = require("../db");
const { requireAuth, requireTeamMembership, requireRole } = require("../middleware/auth");
const { pushPlayerToWordpress } = require("../services/wordpressSync");
const { pushTeamAssignmentToWordpress } = require("../services/teamAssignmentSync");
const { pushEvaluationsToWordpress } = require("../services/evaluationSync");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();
router.use(requireAuth, requireTeamMembership);

// Fields a player-role viewer is allowed to see for a TEAMMATE (not themselves).
// Players can see who's on the roster and recognize teammates by photo/jersey,
// but not contact info, notes, videos, or evaluation history - that's coach/
// self-only.
const TEAMMATE_VIEW_FIELDS = ["id", "teamId", "firstName", "lastName", "jerseyNumber", "position", "photoUrl", "favoritePlayerPhotoUrl"];

function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}

// --- Training-log aggregation, shared by /training-summary and /leaderboard ---
function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function dateKey(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
}
function summarizeTrainingLogs(logs) {
  if (!logs || logs.length === 0) return { total: 0, week: 0, streak: 0 };
  const now = new Date();
  const weekStart = startOfDay(now);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());

  let total = 0, week = 0;
  const daySet = new Set();
  logs.forEach((l) => {
    const d = new Date(l.loggedAt);
    total += l.minutes;
    if (d >= weekStart) week += l.minutes;
    daySet.add(dateKey(d));
  });

  let streak = 0;
  const cursor = startOfDay(now);
  if (!daySet.has(dateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (daySet.has(dateKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return { total, week, streak };
}

// GET /api/players/training-summary  (admin/coach only)
// Rollup of every player's training activity - the Techne "Manager Portal"
// equivalent: a coach can see who's training, how often, and how it's
// trending without opening each profile individually. Registered ahead of
// GET /:id so "training-summary" is never swallowed as a player id.
router.get("/training-summary", requireRole("admin", "coach"), asyncHandler(async (req, res) => {
  const players = await prisma.player.findMany({
    where: { teamId: req.membership.teamId },
    select: { id: true, firstName: true, lastName: true, photoUrl: true, jerseyNumber: true },
    orderBy: [{ lastName: "asc" }],
  });
  const logs = await prisma.playerTrainingLog.findMany({
    where: { player: { teamId: req.membership.teamId } },
    select: { playerId: true, minutes: true, loggedAt: true },
  });
  const byPlayer = new Map();
  logs.forEach((l) => {
    if (!byPlayer.has(l.playerId)) byPlayer.set(l.playerId, []);
    byPlayer.get(l.playerId).push(l);
  });
  const summary = players.map((p) => ({ ...p, ...summarizeTrainingLogs(byPlayer.get(p.id)) }));
  res.json(summary);
}));

// GET /api/players/leaderboard
// Team-scoped, opt-in only: players/guardians who've never turned
// leaderboardOptIn on never appear here, regardless of how much they've
// trained. Visible to every team member (that's the point of a
// leaderboard), ranked by minutes trained this week.
router.get("/leaderboard", asyncHandler(async (req, res) => {
  const players = await prisma.player.findMany({
    where: { teamId: req.membership.teamId, leaderboardOptIn: true },
    select: { id: true, firstName: true, lastName: true, photoUrl: true, jerseyNumber: true },
  });
  const logs = await prisma.playerTrainingLog.findMany({
    where: { player: { teamId: req.membership.teamId, leaderboardOptIn: true } },
    select: { playerId: true, minutes: true, loggedAt: true },
  });
  const byPlayer = new Map();
  logs.forEach((l) => {
    if (!byPlayer.has(l.playerId)) byPlayer.set(l.playerId, []);
    byPlayer.get(l.playerId).push(l);
  });
  const ranked = players
    .map((p) => ({ ...p, ...summarizeTrainingLogs(byPlayer.get(p.id)) }))
    .sort((a, b) => b.week - a.week || b.streak - a.streak);
  res.json(ranked);
}));

// GET /api/players  -> roster for the current team (see x-team-id header).
// Players get a trimmed view of everyone but themselves; coaches/admins see
// everything (used for contact info, sync status, etc.).
router.get("/", asyncHandler(async (req, res) => {
  const players = await prisma.player.findMany({
    where: { teamId: req.membership.teamId },
    orderBy: [{ lastName: "asc" }],
    // membershipId is only needed by staff (e.g. to assign a Volunteer Role
    // to a player/parent's membership) - included here rather than a
    // separate endpoint since the roster list is already fetched anyway.
    include: { membership: { select: { id: true } } },
  });

  const isStaff = ["admin", "coach"].includes(req.membership.role);
  if (isStaff) {
    return res.json(players.map(({ membership, ...p }) => ({ ...p, membershipId: membership?.id || null })));
  }

  const trimmed = players.map((p) =>
    p.id === req.membership.playerId ? p : pick(p, TEAMMATE_VIEW_FIELDS)
  );
  res.json(trimmed);
}));

// GET /api/players/:id
// Coaches/admins and the player themselves get the full profile (incl.
// videos and evaluation history). A player viewing a teammate only gets
// name, jersey number, and the two photos.
router.get("/:id", asyncHandler(async (req, res) => {
  const isStaff = ["admin", "coach"].includes(req.membership.role);
  const isSelf = req.membership.playerId === req.params.id;

  const player = await prisma.player.findUnique({
    where: { id: req.params.id },
    include: isStaff || isSelf
      ? {
          videos: { orderBy: { position: "asc" } },
          evaluations: { orderBy: { evaluationDate: "desc" } },
          skillTests: { orderBy: { recordedAt: "desc" } },
          // Capped so a long-running player's profile load doesn't grow
          // unbounded - full history is available via the dedicated
          // /training-logs endpoint below if ever needed.
          trainingLogs: {
            orderBy: { loggedAt: "desc" },
            take: 200,
            include: {
              video: { select: { id: true, title: true } },
              trainingVideo: { select: { id: true, title: true } },
            },
          },
        }
      : undefined,
  });
  if (!player || player.teamId !== req.membership.teamId) {
    return res.status(404).json({ error: "Player not found" });
  }

  if (!isStaff && !isSelf) {
    return res.json(pick(player, TEAMMATE_VIEW_FIELDS));
  }
  res.json(player);
}));

// POST /api/players  (admin/coach only) - adds a new player to the current team's roster.
// Optionally pass loginEmail (+ loginPassword) to also give the player access.
// If loginEmail matches an account that already exists (e.g. this same
// player already has a login on another team), that account is LINKED to
// this new team/player instead of erroring - this is how one player login
// ends up with access to multiple teams: the coach rosters them with the
// same email on each team. A password is only needed the first time, when
// the account doesn't exist yet. Players never self-register.
router.post("/", requireRole("admin", "coach"), asyncHandler(async (req, res) => {
  const { loginEmail, loginPassword, ...playerFields } = req.body;

  const player = await prisma.player.create({
    data: { ...playerFields, teamId: req.membership.teamId, syncStatus: "pending" },
  });

  let membership = null;
  let linkedExisting = false;

  if (loginEmail) {
    const existingUser = await prisma.user.findUnique({ where: { email: loginEmail } });

    if (existingUser) {
      try {
        membership = await prisma.membership.create({
          data: { userId: existingUser.id, teamId: req.membership.teamId, role: "player", playerId: player.id },
        });
        linkedExisting = true;
      } catch (e) {
        return res.status(409).json({
          error: "That email is already linked to a player on this team",
          player, // player was still created; caller can retry with a different email
        });
      }
    } else if (loginPassword) {
      const passwordHash = await bcrypt.hash(loginPassword, 10);
      const user = await prisma.user.create({ data: { email: loginEmail, passwordHash } });
      membership = await prisma.membership.create({
        data: { userId: user.id, teamId: req.membership.teamId, role: "player", playerId: player.id },
      });
    } else {
      return res.status(400).json({
        error: "A password is required to create a new login for this email",
        player,
      });
    }
  }

  pushPlayerToWordpress(player.id).catch((e) => console.error(e));
  // If this roster row is linked to a global WordPress player account
  // (wpPlayerId), tell WordPress this team should be added to that
  // player's pp_team_ids too - e.g. a coach rostering an existing WP
  // player onto a second TeamSync team.
  if (player.wpPlayerId) {
    pushTeamAssignmentToWordpress(player.wpPlayerId).catch((e) =>
      console.error("[teamAssignmentSync] push on create failed:", e.message)
    );
  }
  res.status(201).json({ ...player, loginCreated: !!membership, linkedExisting });
}));

// PUT /api/players/:id
// A player can edit their own profile; coaches/admins can edit anyone on the team.
router.put("/:id", asyncHandler(async (req, res) => {
  const player = await prisma.player.findUnique({ where: { id: req.params.id } });
  if (!player || player.teamId !== req.membership.teamId) {
    return res.status(404).json({ error: "Player not found" });
  }

  const isSelf = req.membership.playerId === player.id;
  const isStaff = ["admin", "coach"].includes(req.membership.role);
  if (!isSelf && !isStaff) {
    return res.status(403).json({ error: "You can only edit your own profile" });
  }

  const {
    firstName, lastName, email, phone, jerseyNumber, position,
    birthdate, photoUrl, favoritePlayerPhotoUrl, guardianName, guardianPhone, guardianEmail, emergencyContact, notes,
    leaderboardOptIn,
    // Self-reported profile fields (Player Portal parity - see
    // add-favorite-team.sql for the pp_* meta keys these mirror).
    heightWeight, preferredFoot, improvementNotes,
    favoriteTeamName, favoriteTeamPhotoUrl, favoritePlayerName,
  } = req.body;

  const updated = await prisma.player.update({
    where: { id: player.id },
    data: {
      firstName, lastName, email, phone, jerseyNumber, position,
      birthdate: birthdate ? new Date(birthdate) : undefined,
      photoUrl, favoritePlayerPhotoUrl, guardianName, guardianPhone, guardianEmail, emergencyContact, notes,
      leaderboardOptIn,
      heightWeight, preferredFoot, improvementNotes,
      favoriteTeamName, favoriteTeamPhotoUrl, favoritePlayerName,
      syncStatus: "pending",
    },
  });

  pushPlayerToWordpress(updated.id).catch((e) => console.error("[sync] push error:", e.message));

  res.json(updated);
}));

// DELETE /api/players/:id  (admin/coach only) - removes this player from
// THIS team's roster only. This only deletes the Player row scoped to this
// team (and its videos/evaluations/RSVPs, and the Membership that grants
// access to this specific team). If this same person is also rostered on
// other teams, those are separate Player rows tied to the same user account
// and are completely untouched - and the user's login itself is never
// deleted, so they keep access to any other team they're still rostered on.
router.delete("/:id", requireRole("admin", "coach"), asyncHandler(async (req, res) => {
  const player = await prisma.player.findUnique({ where: { id: req.params.id } });
  if (!player || player.teamId !== req.membership.teamId) {
    return res.status(404).json({ error: "Player not found" });
  }

  await prisma.$transaction([
    prisma.playerVideo.deleteMany({ where: { playerId: player.id } }),
    prisma.playerEvaluation.deleteMany({ where: { playerId: player.id } }),
    prisma.rSVP.deleteMany({ where: { playerId: player.id } }),
    // Keep the message history, just detach the author (MessagesScreen falls
    // back to showing "Coach" for messages with no authorPlayer).
    prisma.message.updateMany({ where: { authorPlayerId: player.id }, data: { authorPlayerId: null } }),
    // Removes this player's login access to THIS team only, if they had one.
    prisma.membership.deleteMany({ where: { playerId: player.id } }),
    prisma.player.delete({ where: { id: player.id } }),
  ]);

  // Mirror the removal to WordPress: this player's pp_team_ids should no
  // longer include this team. (Deleted-inside-transaction row is gone from
  // TeamSync, so this pull's the player's now-shorter remaining team list.)
  if (player.wpPlayerId) {
    pushTeamAssignmentToWordpress(player.wpPlayerId).catch((e) =>
      console.error("[teamAssignmentSync] push on delete failed:", e.message)
    );
  }

  res.status(204).end();
}));

// GET /api/players/:id/evaluations - full QDE evaluation history for a player.
// Coach/admin, or the player viewing their own history, only - evaluations
// are not visible between teammates.
router.get("/:id/evaluations", asyncHandler(async (req, res) => {
  const player = await prisma.player.findUnique({ where: { id: req.params.id } });
  if (!player || player.teamId !== req.membership.teamId) {
    return res.status(404).json({ error: "Player not found" });
  }
  const isStaff = ["admin", "coach"].includes(req.membership.role);
  const isSelf = req.membership.playerId === player.id;
  if (!isStaff && !isSelf) {
    return res.status(403).json({ error: "You can only view your own evaluations" });
  }
  const evaluations = await prisma.playerEvaluation.findMany({
    where: { playerId: player.id },
    orderBy: { evaluationDate: "desc" },
  });
  res.json(evaluations);
}));

// POST /api/players/:id/evaluations  (admin/coach only) - records a new QDE evaluation
router.post("/:id/evaluations", requireRole("admin", "coach"), asyncHandler(async (req, res) => {
  const player = await prisma.player.findUnique({ where: { id: req.params.id } });
  if (!player || player.teamId !== req.membership.teamId) {
    return res.status(404).json({ error: "Player not found" });
  }

  const {
    evaluationDate, evaluator, heightWeight, preferredFoot, coachNotes,
    strength, speed, quickness, dribbling, longPass, mediumShot,
    receiving, pressAfterLoss, concentration,
  } = req.body;

  const required = { strength, speed, quickness, dribbling, longPass, mediumShot, receiving, pressAfterLoss, concentration };
  for (const [key, val] of Object.entries(required)) {
    const n = Number(val);
    if (!Number.isInteger(n) || n < 1 || n > 4) {
      return res.status(400).json({ error: `${key} must be an integer 1-4` });
    }
  }

  const evaluation = await prisma.playerEvaluation.create({
    data: {
      playerId: player.id,
      evaluationDate: evaluationDate ? new Date(evaluationDate) : undefined,
      evaluator, heightWeight, preferredFoot, coachNotes,
      strength: Number(strength), speed: Number(speed), quickness: Number(quickness),
      dribbling: Number(dribbling), longPass: Number(longPass), mediumShot: Number(mediumShot),
      receiving: Number(receiving), pressAfterLoss: Number(pressAfterLoss), concentration: Number(concentration),
    },
  });

  pushEvaluationsToWordpress(player.id).catch((e) => console.error("[evaluationSync] push error:", e.message));

  res.status(201).json(evaluation);
}));

// GET /api/players/:id/training-logs - full self-training log history for
// a player. Same visibility rule as evaluations: coach/admin, or the
// player viewing their own history, only.
router.get("/:id/training-logs", asyncHandler(async (req, res) => {
  const player = await prisma.player.findUnique({ where: { id: req.params.id } });
  if (!player || player.teamId !== req.membership.teamId) {
    return res.status(404).json({ error: "Player not found" });
  }
  const isStaff = ["admin", "coach"].includes(req.membership.role);
  const isSelf = req.membership.playerId === player.id;
  if (!isStaff && !isSelf) {
    return res.status(403).json({ error: "You can only view your own training log" });
  }
  const trainingLogs = await prisma.playerTrainingLog.findMany({
    where: { playerId: player.id },
    orderBy: { loggedAt: "desc" },
  });
  res.json(trainingLogs);
}));

// POST /api/players/:id/training-logs - records a self-training session.
// minutes is expected to come from an in-app start/stop timer, not a
// free-typed number. videoId is optional (set when the player started the
// timer from a specific drill video). Self or staff only - staff can log
// on a player's behalf (e.g. a young player without their own device).
router.post("/:id/training-logs", asyncHandler(async (req, res) => {
  const player = await prisma.player.findUnique({ where: { id: req.params.id } });
  if (!player || player.teamId !== req.membership.teamId) {
    return res.status(404).json({ error: "Player not found" });
  }
  const isStaff = ["admin", "coach"].includes(req.membership.role);
  const isSelf = req.membership.playerId === player.id;
  if (!isStaff && !isSelf) {
    return res.status(403).json({ error: "You can only log your own training time" });
  }

  const { minutes, videoId, trainingVideoId, note, loggedAt } = req.body;
  const n = Number(minutes);
  if (!Number.isInteger(n) || n < 1 || n > 600) {
    return res.status(400).json({ error: "minutes must be an integer between 1 and 600" });
  }

  if (videoId) {
    const video = await prisma.playerVideo.findUnique({ where: { id: videoId } });
    if (!video || video.playerId !== player.id) {
      return res.status(400).json({ error: "videoId does not belong to this player" });
    }
  }
  if (trainingVideoId) {
    // TrainingVideo is team-scoped (shared library), not per-player.
    const trainingVideo = await prisma.trainingVideo.findUnique({ where: { id: trainingVideoId } });
    if (!trainingVideo || trainingVideo.teamId !== player.teamId) {
      return res.status(400).json({ error: "trainingVideoId does not belong to this team" });
    }
  }

  const log = await prisma.playerTrainingLog.create({
    data: {
      playerId: player.id,
      videoId: videoId || undefined,
      trainingVideoId: trainingVideoId || undefined,
      minutes: n,
      note: note || undefined,
      loggedAt: loggedAt ? new Date(loggedAt) : undefined,
    },
    include: {
      video: { select: { id: true, title: true } },
      trainingVideo: { select: { id: true, title: true } },
    },
  });

  res.status(201).json(log);
}));

// DELETE /api/players/:id/training-logs/:logId - removes a single logged
// session (e.g. an accidental timer start). Self or staff only.
router.delete("/:id/training-logs/:logId", asyncHandler(async (req, res) => {
  const player = await prisma.player.findUnique({ where: { id: req.params.id } });
  if (!player || player.teamId !== req.membership.teamId) {
    return res.status(404).json({ error: "Player not found" });
  }
  const isStaff = ["admin", "coach"].includes(req.membership.role);
  const isSelf = req.membership.playerId === player.id;
  if (!isStaff && !isSelf) {
    return res.status(403).json({ error: "You can only edit your own training log" });
  }

  const log = await prisma.playerTrainingLog.findUnique({ where: { id: req.params.logId } });
  if (!log || log.playerId !== player.id) {
    return res.status(404).json({ error: "Training log entry not found" });
  }
  await prisma.playerTrainingLog.delete({ where: { id: log.id } });
  res.status(204).end();
}));

// POST /api/players/:id/videos  (admin/coach only) - assigns an individually
// uploaded drill video to ONE player (distinct from /api/training-videos,
// which is the team-wide shared library). url is expected to already be a
// Supabase Storage URL returned by POST /api/uploads/video - this endpoint
// just records the metadata, same pattern as training-videos.js.
router.post("/:id/videos", requireRole("admin", "coach"), asyncHandler(async (req, res) => {
  const player = await prisma.player.findUnique({ where: { id: req.params.id } });
  if (!player || player.teamId !== req.membership.teamId) {
    return res.status(404).json({ error: "Player not found" });
  }

  const { title, url } = req.body;
  if (!title || !url) {
    return res.status(400).json({ error: "title and url are required" });
  }

  const last = await prisma.playerVideo.aggregate({
    where: { playerId: player.id },
    _max: { position: true },
  });

  const video = await prisma.playerVideo.create({
    data: {
      playerId: player.id,
      title,
      url,
      position: (last._max.position ?? -1) + 1,
    },
  });

  res.status(201).json(video);
}));

// DELETE /api/players/:id/videos/:videoId  (admin/coach only)
router.delete("/:id/videos/:videoId", requireRole("admin", "coach"), asyncHandler(async (req, res) => {
  const player = await prisma.player.findUnique({ where: { id: req.params.id } });
  if (!player || player.teamId !== req.membership.teamId) {
    return res.status(404).json({ error: "Player not found" });
  }

  const video = await prisma.playerVideo.findUnique({ where: { id: req.params.videoId } });
  if (!video || video.playerId !== player.id) {
    return res.status(404).json({ error: "Video not found" });
  }

  await prisma.playerVideo.delete({ where: { id: video.id } });
  res.status(204).end();
}));

// PATCH /api/players/:id/videos/:videoId/watched - toggle (or explicitly
// set via body.watched) the "I watched this" mark on a per-player drill
// video, mirroring the Player Portal's pp_watched_videos. Self or staff only.
router.patch("/:id/videos/:videoId/watched", asyncHandler(async (req, res) => {
  const player = await prisma.player.findUnique({ where: { id: req.params.id } });
  if (!player || player.teamId !== req.membership.teamId) {
    return res.status(404).json({ error: "Player not found" });
  }
  const isStaff = ["admin", "coach"].includes(req.membership.role);
  const isSelf = req.membership.playerId === player.id;
  if (!isStaff && !isSelf) {
    return res.status(403).json({ error: "You can only mark your own videos as watched" });
  }

  const video = await prisma.playerVideo.findUnique({ where: { id: req.params.videoId } });
  if (!video || video.playerId !== player.id) {
    return res.status(404).json({ error: "Video not found" });
  }

  const nextWatched = typeof req.body.watched === "boolean" ? req.body.watched : !video.watchedAt;
  const updated = await prisma.playerVideo.update({
    where: { id: video.id },
    data: { watchedAt: nextWatched ? new Date() : null },
  });

  res.json(updated);
}));

// GET /api/players/:id/skill-tests - full skill-test history for a player,
// same visibility rule as evaluations/training-logs (coach/admin or self).
router.get("/:id/skill-tests", asyncHandler(async (req, res) => {
  const player = await prisma.player.findUnique({ where: { id: req.params.id } });
  if (!player || player.teamId !== req.membership.teamId) {
    return res.status(404).json({ error: "Player not found" });
  }
  const isStaff = ["admin", "coach"].includes(req.membership.role);
  const isSelf = req.membership.playerId === player.id;
  if (!isStaff && !isSelf) {
    return res.status(403).json({ error: "You can only view your own skill tests" });
  }
  const skillTests = await prisma.playerSkillTest.findMany({
    where: { playerId: player.id },
    orderBy: { recordedAt: "desc" },
  });
  res.json(skillTests);
}));

// POST /api/players/:id/skill-tests - records a self-timed/self-counted
// score (e.g. "Juggles in 60s": score 34, unit "reps"). Self or staff only.
router.post("/:id/skill-tests", asyncHandler(async (req, res) => {
  const player = await prisma.player.findUnique({ where: { id: req.params.id } });
  if (!player || player.teamId !== req.membership.teamId) {
    return res.status(404).json({ error: "Player not found" });
  }
  const isStaff = ["admin", "coach"].includes(req.membership.role);
  const isSelf = req.membership.playerId === player.id;
  if (!isStaff && !isSelf) {
    return res.status(403).json({ error: "You can only record your own skill tests" });
  }

  const { testName, score, unit, note, recordedAt } = req.body;
  const s = Number(score);
  if (!testName || !unit || !Number.isFinite(s)) {
    return res.status(400).json({ error: "testName, score (number), and unit are required" });
  }

  const skillTest = await prisma.playerSkillTest.create({
    data: {
      playerId: player.id,
      testName,
      score: s,
      unit,
      note: note || undefined,
      recordedAt: recordedAt ? new Date(recordedAt) : undefined,
    },
  });
  res.status(201).json(skillTest);
}));

// DELETE /api/players/:id/skill-tests/:testId - removes a single recorded
// score (e.g. a mis-entered attempt). Self or staff only.
router.delete("/:id/skill-tests/:testId", asyncHandler(async (req, res) => {
  const player = await prisma.player.findUnique({ where: { id: req.params.id } });
  if (!player || player.teamId !== req.membership.teamId) {
    return res.status(404).json({ error: "Player not found" });
  }
  const isStaff = ["admin", "coach"].includes(req.membership.role);
  const isSelf = req.membership.playerId === player.id;
  if (!isStaff && !isSelf) {
    return res.status(403).json({ error: "You can only edit your own skill tests" });
  }

  const skillTest = await prisma.playerSkillTest.findUnique({ where: { id: req.params.testId } });
  if (!skillTest || skillTest.playerId !== player.id) {
    return res.status(404).json({ error: "Skill test entry not found" });
  }
  await prisma.playerSkillTest.delete({ where: { id: skillTest.id } });
  res.status(204).end();
}));

module.exports = router;
