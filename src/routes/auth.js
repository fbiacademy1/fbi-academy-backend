const express = require("express");
const jwt = require("jsonwebtoken");
const prisma = require("../db");
const { requireAuth } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { verifyWordpressCredentials } = require("../services/wordpressAuth");

const router = express.Router();

async function membershipsFor(userId) {
  const memberships = await prisma.membership.findMany({
    where: { userId },
    include: { team: true },
  });
  return memberships.map((m) => ({
    id: m.id,
    teamId: m.teamId,
    teamName: m.team.name,
    sport: m.team.sport,
    role: m.role,
    // For role:"parent" rows, playerId itself is null (that column is
    // reserved for the child's own login - see the unique constraint on
    // Membership.playerId) and viewPlayerId carries which child this
    // guardian can act on behalf of instead. Every screen in the app reads
    // activeMembership.playerId to know "which player am I", so merging
    // the two here means a guardian gets the exact same player-scoped
    // experience (training videos, RSVP, roster "isSelf") as the child's
    // own login would, with no other app code needing to know guardians exist.
    playerId: m.playerId || m.viewPlayerId,
    homeJerseyColor: m.team.homeJerseyColor,
    homeShortsColor: m.team.homeShortsColor,
    homeSocksColor: m.team.homeSocksColor,
    awayJerseyColor: m.team.awayJerseyColor,
    awayShortsColor: m.team.awayShortsColor,
    awaySocksColor: m.team.awaySocksColor,
  }));
}

// POST /api/auth/login
// Credentials are checked against WordPress (the FBI Academy Coach Portal
// plugin), not a local password - WordPress is now the single source of
// truth for identity, per INTEGRATION_ARCHITECTURE.md. On a user's first
// successful login through this bridge, a local User row is created (or, if
// one already exists with a matching email from before the bridge existed,
// linked) via wpUserId, so existing Team/Membership relationships keep
// working exactly as before - only how the password is checked changed.
router.post("/login", asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "email and password required" });

  const wpUser = await verifyWordpressCredentials(email, password);
  if (!wpUser) return res.status(401).json({ error: "Invalid credentials" });

  let user = await prisma.user.findUnique({ where: { wpUserId: wpUser.id } });
  if (!user) {
    const existingByEmail = await prisma.user.findUnique({ where: { email: wpUser.email } });
    if (existingByEmail) {
      user = await prisma.user.update({
        where: { id: existingByEmail.id },
        data: { wpUserId: wpUser.id, email: wpUser.email },
      });
    } else {
      user = await prisma.user.create({ data: { email: wpUser.email, wpUserId: wpUser.id } });
    }
  } else if (user.email !== wpUser.email) {
    // Keep email in sync if it was changed in WordPress since last login.
    user = await prisma.user.update({ where: { id: user.id }, data: { email: wpUser.email } });
  }

  // The token only identifies the user - which team they're acting on is
  // sent per-request via the x-team-id header, since one login can span
  // multiple teams.
  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "30d" });
  const memberships = await membershipsFor(user.id);

  res.json({ token, user: { id: user.id, email: user.email }, memberships });
}));

// POST /api/auth/register - retired. Accounts are now provisioned in
// WordPress (the Coach Portal for players, wp-admin for coaches) instead of
// self-signup here, so WordPress stays the single source of truth for
// identity. A coach still creates a team (POST /api/teams) after logging in
// to become its first member - that part is unchanged.
router.post("/register", (req, res) => {
  res.status(410).json({
    error:
      "Self-registration has moved. Player accounts are created in the FBI Academy Coach Portal; coach accounts in WordPress admin. Log in here with those credentials instead.",
  });
});

// GET /api/auth/me - refetch current user + memberships (e.g. after creating/joining a team)
router.get("/me", requireAuth, asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
  if (!user) return res.status(404).json({ error: "User not found" });
  const memberships = await membershipsFor(user.id);
  res.json({ user: { id: user.id, email: user.email }, memberships });
}));

// POST /api/auth/push-token - registers this device's Expo push token
// against the logged-in user, so "Notify Team" event notifications can
// reach them. Overwrites any previous token for this user (simple 1
// device/user model). Called from the app right after login/launch.
router.post("/push-token", requireAuth, asyncHandler(async (req, res) => {
  const { pushToken } = req.body;
  if (!pushToken) return res.status(400).json({ error: "pushToken is required" });
  await prisma.user.update({ where: { id: req.user.userId }, data: { pushToken } });
  res.json({ ok: true });
}));

module.exports = router;
