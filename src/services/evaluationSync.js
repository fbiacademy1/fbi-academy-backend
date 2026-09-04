/**
 * Two-way sync bridge for player development evaluations (QDE), between
 * this backend's Postgres PlayerEvaluation table and the WordPress Coach
 * Portal's pp_qde_evaluations user meta (which is what the website's Player
 * Portal radar chart actually reads from).
 *
 * These stay two separate databases under the hood - unifying them into one
 * would mean rewriting either the WordPress Player Portal or the mobile
 * app's data layer, which is out of scope. Instead, each side pushes its
 * full current evaluation history to the other whenever a coach saves a
 * change, so both surfaces show the same data within moments either way.
 *
 * Loop safety: applyWordpressEvaluations (WP -> here) is only ever called
 * from the Coach Portal's form-save handler. pushEvaluationsToWordpress
 * (here -> WP) posts to a WordPress REST endpoint that ONLY writes user
 * meta - it does not call back into fcp_push_evaluations_to_teamsync. So
 * neither direction re-triggers the other; there's no ping-pong.
 */

const axios = require("axios");
const prisma = require("../db");

// [postgres camelCase key, WordPress snake_case key] - same 9 QDE
// attributes, same order, on both sides (see PP_Roles::attributes() /
// fcp_attributes() in the Coach Portal plugin).
const ATTR_KEYS = [
  ["strength", "strength"],
  ["speed", "speed"],
  ["quickness", "quickness"],
  ["dribbling", "dribbling"],
  ["longPass", "long_pass"],
  ["mediumShot", "medium_shot"],
  ["receiving", "receiving"],
  ["pressAfterLoss", "press_after_loss"],
  ["concentration", "concentration"],
];

/**
 * Called from routes/sync.js (POST /api/sync/wordpress-evaluations) when a
 * coach saves the "Player Evaluations (QDE)" section on the Coach Portal's
 * Edit Player screen. WordPress is the source of truth for this push, so
 * this player's ENTIRE evaluation history is replaced wholesale rather than
 * diffed/merged - same pattern applyWordpressWebhook uses for video_links.
 * A person can have a Player row on more than one team sharing the same
 * wpPlayerId; the same evaluation history is applied to all of them, since
 * WordPress only keeps one (team-agnostic) evaluation history per person.
 */
async function applyWordpressEvaluations({ wpPlayerId, evaluations }) {
  if (!wpPlayerId) throw new Error("wpPlayerId is required");
  const list = Array.isArray(evaluations) ? evaluations : [];

  const players = await prisma.player.findMany({ where: { wpPlayerId } });

  for (const player of players) {
    await prisma.playerEvaluation.deleteMany({ where: { playerId: player.id } });
    if (list.length) {
      await prisma.playerEvaluation.createMany({
        data: list.map((row) => {
          const attrs = row.attributes || {};
          const data = {
            playerId: player.id,
            evaluationDate: row.eval_date ? new Date(row.eval_date) : new Date(),
            evaluator: row.evaluator || undefined,
            coachNotes: row.coach_notes || undefined,
          };
          for (const [pgKey, wpKey] of ATTR_KEYS) {
            data[pgKey] = Math.max(0, Math.min(4, Number(attrs[wpKey]) || 0));
          }
          return data;
        }),
      });
    }
  }

  return { playersUpdated: players.length };
}

/**
 * Called after a coach creates an evaluation in the mobile app (see
 * routes/players.js POST /:id/evaluations). Pushes this player's ENTIRE
 * current evaluation history to WordPress's pp_qde_evaluations meta so the
 * website Player Portal's radar chart shows the same data. No-ops quietly
 * if this player has no linked WordPress login yet (wpPlayerId is null) or
 * the auth-bridge env vars aren't configured - same fail-open behavior as
 * the other WordPress push services in this app.
 */
async function pushEvaluationsToWordpress(playerId) {
  const player = await prisma.player.findUnique({ where: { id: playerId } });
  if (!player || !player.wpPlayerId) return;

  const base = process.env.WORDPRESS_FBI_API_BASE;
  const secret = process.env.WORDPRESS_AUTH_BRIDGE_SECRET;
  if (!base || !secret) {
    console.warn("[evaluationSync] WORDPRESS_FBI_API_BASE / WORDPRESS_AUTH_BRIDGE_SECRET not set, skipping push");
    return;
  }

  const evaluations = await prisma.playerEvaluation.findMany({
    where: { playerId: player.id },
    orderBy: { evaluationDate: "asc" },
  });

  const payload = {
    wpPlayerId: player.wpPlayerId,
    evaluations: evaluations.map((ev) => ({
      id: ev.id,
      eval_date: ev.evaluationDate.toISOString().slice(0, 10),
      evaluator: ev.evaluator || "",
      coach_notes: ev.coachNotes || "",
      attributes: Object.fromEntries(ATTR_KEYS.map(([pgKey, wpKey]) => [wpKey, ev[pgKey]])),
    })),
  };

  try {
    await axios.post(`${base}/evaluations/sync`, payload, {
      headers: {
        "x-fbi-api-secret": secret,
        "Content-Type": "application/json",
        Accept: "application/json",
        // Same Hostinger bot-protection workaround used by the other
        // server-to-server calls in this app (see wordpressAuth.js).
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
      timeout: 10000,
    });
  } catch (err) {
    console.error("[evaluationSync] push failed:", err.message);
  }
}

module.exports = { applyWordpressEvaluations, pushEvaluationsToWordpress };
