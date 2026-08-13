const jwt = require("jsonwebtoken");
const prisma = require("../db");

// Verifies the JWT and attaches req.user = { userId }.
// Note: the token no longer carries a fixed team/role, since one user can
// belong to multiple teams with different roles - see requireTeamMembership.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing auth token" });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Resolves which team the request is acting on (from the "x-team-id" header,
// sent by the mobile app based on whichever team the user currently has
// selected) and confirms the logged-in user actually belongs to it.
// Attaches req.membership = { id, teamId, role, playerId }.
//
// A guardian can now hold more than one role:"parent" Membership on the SAME
// team (one per linked child there), so userId+teamId alone no longer
// uniquely identifies a Membership - the mobile app also sends
// "x-membership-id" (the specific Membership.id it has active) once it
// knows it, which this looks up first. Every other case (a plain
// admin/coach/player, or a guardian's first request before it has an id to
// send yet) falls back to "any membership on this team", same as before.
async function requireTeamMembership(req, res, next) {
  try {
    const teamId = req.headers["x-team-id"];
    if (!teamId) return res.status(400).json({ error: "Missing x-team-id header" });

    const membershipId = req.headers["x-membership-id"];
    let membership = null;
    if (membershipId) {
      membership = await prisma.membership.findFirst({
        where: { id: membershipId, userId: req.user.userId, teamId },
      });
    }
    if (!membership) {
      membership = await prisma.membership.findFirst({
        where: { userId: req.user.userId, teamId },
      });
    }
    if (!membership) return res.status(403).json({ error: "You don't have access to this team" });

    req.membership = membership;
    next();
  } catch (err) {
    next(err);
  }
}

// Restricts a route to certain roles on the current team, e.g. requireRole("admin", "coach")
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.membership || !roles.includes(req.membership.role)) {
      return res.status(403).json({ error: "Not authorized for this action" });
    }
    next();
  };
}

// Verifies requests coming FROM WordPress carry the shared secret.
// (This guards the OLDER teamsync-sync.php plugin's webhook specifically -
// see requireFbiSecret below for the newer fbi/v1 integration's webhooks.)
function requireWordpressSecret(req, res, next) {
  const secret = req.headers["x-teamsync-secret"];
  if (!secret || secret !== process.env.WORDPRESS_SYNC_SECRET) {
    return res.status(401).json({ error: "Invalid sync secret" });
  }
  next();
}

// Verifies requests coming FROM the FBI Academy Coach Portal's fbi/v1
// integration (auth bridge + team-assignment sync) carry the shared secret
// set in WORDPRESS_AUTH_BRIDGE_SECRET / WordPress's Settings > FBI
// Integration page. Kept separate from requireWordpressSecret above so the
// two plugins' trust boundaries never overlap.
function requireFbiSecret(req, res, next) {
  const secret = req.headers["x-fbi-api-secret"];
  if (!secret || secret !== process.env.WORDPRESS_AUTH_BRIDGE_SECRET) {
    return res.status(401).json({ error: "Invalid sync secret" });
  }
  next();
}

// Combined auth for routes that need to work for BOTH the mobile app (JWT +
// x-team-id/x-membership-id, resolved against a real Membership row) AND
// the Coach Portal calling in server-to-server as a logged-in WordPress
// coach (x-fbi-api-secret + x-fbi-coach-email + x-fbi-team-id, no JWT -
// WordPress already did the real login/authorization, same trust level as
// the other requireFbiSecret routes in sync.js).
//
// The WordPress path auto-provisions a TeamSync User (by email) and a
// "coach" Membership on the given team if one doesn't exist yet, mirroring
// the auto-provisioning pattern training-sessions-api uses for its embedded
// auth - a coach who manages the schedule from the website but has never
// opened the mobile app still gets a working, minimal identity here rather
// than a confusing 403/404.
//
// Either path ends with the same req.user = { userId } / req.membership =
// {..., teamId, role } shape, so existing route handlers (events.js, etc.)
// don't need to know or care which caller they're serving.
async function requireAuthAndTeam(req, res, next) {
  const fbiSecret = req.headers["x-fbi-api-secret"];

  if (fbiSecret) {
    if (fbiSecret !== process.env.WORDPRESS_AUTH_BRIDGE_SECRET) {
      return res.status(401).json({ error: "Invalid sync secret" });
    }
    const email = req.headers["x-fbi-coach-email"];
    const teamId = req.headers["x-fbi-team-id"];
    if (!email || !teamId) {
      return res.status(400).json({ error: "Missing x-fbi-coach-email or x-fbi-team-id header" });
    }
    try {
      const team = await prisma.team.findUnique({ where: { id: teamId } });
      if (!team) return res.status(404).json({ error: "Team not found" });

      let user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        user = await prisma.user.create({ data: { email } });
      }

      let membership = await prisma.membership.findFirst({ where: { userId: user.id, teamId } });
      if (!membership) {
        membership = await prisma.membership.create({ data: { userId: user.id, teamId, role: "coach" } });
      }

      req.user = { userId: user.id };
      req.membership = membership;
      req.isWordPressBridge = true;
      return next();
    } catch (err) {
      return next(err);
    }
  }

  // No fbi secret - fall back to the normal mobile-app path.
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    requireTeamMembership(req, res, next);
  });
}

module.exports = {
  requireAuth,
  requireTeamMembership,
  requireRole,
  requireWordpressSecret,
  requireFbiSecret,
  requireAuthAndTeam,
};
