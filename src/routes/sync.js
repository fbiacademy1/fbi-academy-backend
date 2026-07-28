const express = require("express");
const { requireWordpressSecret, requireFbiSecret } = require("../middleware/auth");
const { applyWordpressWebhook } = require("../services/wordpressSync");
const { applyWordpressTeamAssignment, applyWordpressCoachTeamAssignment, applyWordpressCreateTeam } = require("../services/teamAssignmentSync");
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

module.exports = router;
