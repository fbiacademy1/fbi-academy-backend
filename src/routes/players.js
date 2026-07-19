const express = require("express");
const bcrypt = require("bcryptjs");
const prisma = require("../db");
const { requireAuth, requireTeamMembership, requireRole } = require("../middleware/auth");
const { pushPlayerToWordpress } = require("../services/wordpressSync");
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

// GET /api/players  -> roster for the current team (see x-team-id header).
// Players get a trimmed view of everyone but themselves; coaches/admins see
// everything (used for contact info, sync status, etc.).
router.get("/", asyncHandler(async (req, res) => {
  const players = await prisma.player.findMany({
    where: { teamId: req.membership.teamId },
    orderBy: [{ lastName: "asc" }],
  });

  const isStaff = ["admin", "coach"].includes(req.membership.role);
  if (isStaff) return res.json(players);

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
      ? { videos: { orderBy: { position: "asc" } }, evaluations: { orderBy: { evaluationDate: "desc" } } }
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
    birthdate, photoUrl, favoritePlayerPhotoUrl, guardianName, emergencyContact, notes,
  } = req.body;

  const updated = await prisma.player.update({
    where: { id: player.id },
    data: {
      firstName, lastName, email, phone, jerseyNumber, position,
      birthdate: birthdate ? new Date(birthdate) : undefined,
      photoUrl, favoritePlayerPhotoUrl, guardianName, emergencyContact, notes,
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

  res.status(201).json(evaluation);
}));

module.exports = router;
