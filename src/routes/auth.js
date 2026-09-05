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

  // A guardian can now hold more than one role:"parent" Membership on the
  // SAME team (one per linked child there - see teamAssignmentSync.js), so
  // teamId alone is no longer enough to tell two of a guardian's memberships
  // apart in a team switcher. Batch-fetch the linked child's name so parent
  // rows can carry a `playerName` label the mobile app can show for
  // disambiguation ("Eagles - Alex" vs "Eagles - Sam").
  const mergedPlayerIds = [...new Set(memberships.map((m) => m.playerId || m.viewPlayerId).filter(Boolean))];
  const players = mergedPlayerIds.length
    ? await prisma.player.findMany({
        where: { id: { in: mergedPlayerIds } },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const playerNameById = new Map(players.map((p) => [p.id, `${p.firstName} ${p.lastName}`.trim()]));

  return memberships.map((m) => {
    // For role:"parent" rows, playerId itself is null (that column is
    // reserved for the child's own login - see the unique constraint on
    // Membership.playerId) and viewPlayerId carries which child this
    // guardian can act on behalf of instead. Every screen in the app reads
    // activeMembership.playerId to know "which player am I", so merging
    // the two here means a guardian gets the exact same player-scoped
    // experience (training videos, RSVP, roster "isSelf") as the child's
    // own login would, with no other app code needing to know guardians exist.
    const mergedPlayerId = m.playerId || m.viewPlayerId;
    return {
      id: m.id,
      teamId: m.teamId,
      teamName: m.team.name,
      sport: m.team.sport,
      role: m.role,
      playerId: mergedPlayerId,
      // Only set for role:"parent" rows - null for a player's own login,
      // where there's only ever one Membership per team so no disambiguation
      // is needed.
      playerName: m.role === "parent" ? playerNameById.get(mergedPlayerId) || null : null,
      homeJerseyColor: m.team.homeJerseyColor,
      homeShortsColor: m.team.homeShortsColor,
      homeSocksColor: m.team.homeSocksColor,
      awayJerseyColor: m.team.awayJerseyColor,
      awayShortsColor: m.team.awayShortsColor,
      awaySocksColor: m.team.awaySocksColor,
    };
  });
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

  let wpUser;
  try {
    wpUser = await verifyWordpressCredentials(email, password);
  } catch (err) {
    // verifyWordpressCredentials already retried a few times internally -
    // this only happens once those retries are exhausted on a pure network
    // failure reaching WordPress (see wordpressAuth.js), not a credentials
    // problem. 503 + a clear message beats a bare 500 "Internal server
    // error" for something the user can meaningfully retry in a moment.
    if (err.isWpUnreachable) {
      return res.status(503).json({ error: "Login is temporarily unavailable - please try again in a moment." });
    }
    throw err;
  }
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

// GET /api/auth/my-kids - every child this guardian (role:"parent") is
// linked to, across EVERY team, in one call. Everything under /api/players
// is scoped to req.membership.teamId (one team at a time, via
// requireTeamMembership - see middleware/auth.js), which is exactly why a
// guardian with kids on different teams can't get a combined view from
// those endpoints without switching active team first. This sits on
// /api/auth instead since it only needs the JWT, not an active team - lets
// the mobile app show a "My Kids" screen with every linked child up front,
// then use setActiveTeam(teamId, membershipId) to drill into one.
router.get("/my-kids", requireAuth, asyncHandler(async (req, res) => {
  const memberships = await prisma.membership.findMany({
    where: { userId: req.user.userId, role: "parent" },
    include: { team: true },
  });

  const playerIds = [...new Set(memberships.map((m) => m.viewPlayerId).filter(Boolean))];
  const players = playerIds.length
    ? await prisma.player.findMany({
        where: { id: { in: playerIds } },
        select: { id: true, firstName: true, lastName: true, photoUrl: true, position: true, jerseyNumber: true },
      })
    : [];
  const playerById = new Map(players.map((p) => [p.id, p]));

  const kids = memberships
    .map((m) => {
      const player = playerById.get(m.viewPlayerId);
      if (!player) return null; // roster row not synced yet - drop rather than show a broken card
      return {
        membershipId: m.id,
        teamId: m.teamId,
        teamName: m.team.name,
        sport: m.team.sport,
        playerId: player.id,
        firstName: player.firstName,
        lastName: player.lastName,
        photoUrl: player.photoUrl,
        position: player.position,
        jerseyNumber: player.jerseyNumber,
      };
    })
    .filter(Boolean);

  res.json(kids);
}));

module.exports = router;
