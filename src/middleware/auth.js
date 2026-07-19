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
async function requireTeamMembership(req, res, next) {
  try {
    const teamId = req.headers["x-team-id"];
    if (!teamId) return res.status(400).json({ error: "Missing x-team-id header" });

    const membership = await prisma.membership.findUnique({
      where: { userId_teamId: { userId: req.user.userId, teamId } },
    });
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

module.exports = { requireAuth, requireTeamMembership, requireRole, requireWordpressSecret, requireFbiSecret };
