const express = require("express");
const { requireWordpressSecret, requireFbiSecret } = require("../middleware/auth");
const { applyWordpressWebhook } = require("../services/wordpressSync");
const { applyWordpressTeamAssignment, applyWordpressCoachTeamAssignment, applyWordpressCreateTeam, applyWordpressDeleteTeam, applyWordpressGuardianLink, removeWordpressPlayer } = require("../services/teamAssignmentSync");
const prisma = require("../db");

const router = express.Router();

// POST /api/sync/webhook/wordpress
// Called by the TeamSync WordPress plugin whenever a player_profile post
// is created or updated directly on the website (e.g. a coach editing it
// in wp-admin). Authenticated via a shared secret header, not a user token.
router.post("/webhook/wordpress", requireWordpressSecret, async (req, res) => {
  try {
    const player = await applyWordpressWebhook(req.body);
    res.json({ ok: true, player_id: player.id });
  } catch (err) {
    console.error("[sync] webhook error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// GET /api/sync/teams
// Lets the Coach Portal populate a "which teams is this player on" multi-
// select with TeamSync's real teams, rather than free text. Shared-secret
// protected, not user-scoped - see INTEGRATION_ARCHITECTURE.md.
router.get("/teams", requireFbiSecret, async (req, res) => {
  const teams = await prisma.team.findMany({
    select: { id: true, name: true, sport: true, season: true },
    orderBy: { name: "asc" },
  });
  res.json(teams);
});

// POST /api/sync/wordpress-team-assignment
// Called by the Coach Portal whenever a coach changes a player's team
// assignments there. Body: { wpPlayerId, firstName, lastName, teamIds }.
router.post("/wordpress-team-assignment", requireFbiSecret, async (req, res) => {
  try {
    const result = await applyWordpressTeamAssignment(req.body);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[sync] team assignment webhook error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/sync/wordpress-coach-team-assignment
// Called by the Coach Portal's admin-only "Create Coach" screen whenever an
// admin creates a coach or changes their team assignments there. Body:
// { wpCoachId, email, firstName, lastName, teamIds }.
router.post("/wordpress-coach-team-assignment", requireFbiSecret, async (req, res) => {
    try {
          const result = await applyWordpressCoachTeamAssignment(req.body);
          res.json({ ok: true, ...result });
    } catch (err) {
          console.error("[sync] coach team assignment webhook error:", err.message);
          res.status(400).json({ error: err.message });
    }
});

// POST /api/sync/wordpress-create-team
// Called by the Coach Portal's admin-only "+ Add Team" action to create a
// brand-new team directly. Body: { name, sport, season }.
router.post("/wordpress-create-team", requireFbiSecret, async (req, res) => {
    try {
          const result = await applyWordpressCreateTeam(req.body);
          res.json({ ok: true, ...result });
    } catch (err) {
          console.error("[sync] create team webhook error:", err.message);
          res.status(400).json({ error: err.message });
    }
});

// POST /api/sync/wordpress-delete-team
// Called by the Coach Portal's admin-only "Delete" button next to a team.
// Body: { teamId }. Refuses (400, with a clear message) if the team still
// has players rostered - see applyWordpressDeleteTeam for exactly what is
// and isn't cleaned up.
router.post("/wordpress-delete-team", requireFbiSecret, async (req, res) => {
  try {
    const result = await applyWordpressDeleteTeam(req.body);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[sync] delete team webhook error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/sync/wordpress-guardian-link
// Called by the Coach Portal whenever a player's Guardian Email is set or
// changed. Body: { wpGuardianId, email, children: [{ wpPlayerId, teamId }] }
// - the full, current list of every child/team pair sharing that guardian
// email, so this fully reconciles (adds/updates/removes) rather than only
// adding. See applyWordpressGuardianLink for what this actually does.
router.post("/wordpress-guardian-link", requireFbiSecret, async (req, res) => {
  try {
    const result = await applyWordpressGuardianLink(req.body);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[sync] guardian link webhook error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/sync/wordpress-player-removed
// Called by the Coach Portal's "Delete Player" admin action, right after it
// deletes that player's WordPress login. Body: { wpPlayerId } - the WP user
// id (this player's wpPlayerId in TeamSync). Cleans up every Player row for
// them across every team, their own login's access, and revokes any
// guardian's link to specifically this child. See removeWordpressPlayer for
// exactly what is and isn't touched.
router.post("/wordpress-player-removed", requireFbiSecret, async (req, res) => {
  try {
    const result = await removeWordpressPlayer(req.body);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[sync] player removed webhook error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
