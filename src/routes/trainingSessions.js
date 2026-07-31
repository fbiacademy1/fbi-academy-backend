const express = require("express");
const prisma = require("../db");
const { requireAuth, requireTeamMembership, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const bridge = require("../services/trainingSessionsBridge");

const router = express.Router();

// Same gate the WordPress side enforces (fts_rest_resolve_acting_user only
// accepts a WP "coach" or "administrator" role) - a player calling this
// would just bounce off WordPress with an opaque error, so fail cleanly
// here instead. Every route below is coach/admin-only on the active team.
router.use(requireAuth, requireTeamMembership, requireRole("admin", "coach"));

// Looks up the acting coach's email once per request - the WP side
// identifies them by email (x-fts-user-email), not by TeamSync userId.
async function actingUserEmail(req) {
  const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
  if (!user) throw Object.assign(new Error("User not found"), { status: 404 });
  return user.email;
}

function relayBridgeError(err, res) {
  if (err.status) {
    return res.status(err.status).json({ error: err.message, ...(err.wpError ? { wpError: err.wpError } : {}) });
  }
  console.error("[trainingSessions]", err);
  return res.status(502).json({ error: "Couldn't reach the Training Sessions service" });
}

// GET /api/training-sessions - sessions for the active team, scoped to
// this coach's own sessions unless their WP account is an administrator
// (same scoping the front-end portal itself uses).
router.get("/", asyncHandler(async (req, res) => {
  try {
    const email = await actingUserEmail(req);
    const team = await prisma.team.findUnique({ where: { id: req.membership.teamId } });
    const sessions = await bridge.listSessions(email, team?.name);
    res.json(sessions);
  } catch (err) {
    relayBridgeError(err, res);
  }
}));

// GET /api/training-sessions/:id
router.get("/:id", asyncHandler(async (req, res) => {
  try {
    const email = await actingUserEmail(req);
    const session = await bridge.getSession(email, req.params.id);
    res.json(session);
  } catch (err) {
    relayBridgeError(err, res);
  }
}));

// POST /api/training-sessions - { title, date, drills } - team is filled in
// from the active team automatically so the mobile app never has to know
// WordPress's plain-text team-name convention.
router.post("/", asyncHandler(async (req, res) => {
  try {
    const email = await actingUserEmail(req);
    const team = await prisma.team.findUnique({ where: { id: req.membership.teamId } });
    const { title, date, drills } = req.body;
    const session = await bridge.createSession(email, { title, date, team: team?.name, drills });
    res.status(201).json(session);
  } catch (err) {
    relayBridgeError(err, res);
  }
}));

// PUT /api/training-sessions/:id - partial update; only send fields that changed.
router.put("/:id", asyncHandler(async (req, res) => {
  try {
    const email = await actingUserEmail(req);
    const { title, date, drills } = req.body;
    const session = await bridge.updateSession(email, req.params.id, { title, date, drills });
    res.json(session);
  } catch (err) {
    relayBridgeError(err, res);
  }
}));

// DELETE /api/training-sessions/:id
router.delete("/:id", asyncHandler(async (req, res) => {
  try {
    const email = await actingUserEmail(req);
    await bridge.deleteSession(email, req.params.id);
    res.status(204).end();
  } catch (err) {
    relayBridgeError(err, res);
  }
}));

module.exports = router;
