/**
 * WordPress <-> TeamSync team-assignment sync.
 *
 * A player's PROFILE lives in WordPress (one account, see wordpressAuth.js
 * and INTEGRATION_ARCHITECTURE.md). Which TEAMS that player is rostered to
 * still lives here in TeamSync, as Player rows (one per team) linked back
 * to the WordPress account via wpPlayerId. This module keeps that roster
 * list in sync with WordPress's pp_team_ids field whenever either side
 * changes it.
 */

const prisma = require("../db");

/**
 * Called when WordPress pushes a player's full current team list (e.g. a
 * coach edited their team assignments in the Coach Portal). Reconciles
 * TeamSync's Player rows for this WordPress player to match: creates a
 * roster row (and a Membership, if this player already has a TeamSync
 * login) for any newly-added team, and removes the roster row for any
 * team no longer in the list.
 */
async function applyWordpressTeamAssignment({ wpPlayerId, firstName, lastName, teamIds }) {
  if (!wpPlayerId) throw new Error("wpPlayerId is required");
  const newTeamIds = Array.isArray(teamIds) ? teamIds : [];

  const existing = await prisma.player.findMany({ where: { wpPlayerId } });
  const existingTeamIds = existing.map((p) => p.teamId);

  const toAdd = newTeamIds.filter((id) => !existingTeamIds.includes(id));
  const toRemove = existing.filter((p) => !newTeamIds.includes(p.teamId));

  const linkedUser = await prisma.user.findUnique({ where: { wpUserId: wpPlayerId } });

  for (const teamId of toAdd) {
    const player = await prisma.player.create({
      data: {
        teamId,
        wpPlayerId,
        firstName: firstName || "Player",
        lastName: lastName || "",
        syncStatus: "synced",
      },
    });

    if (linkedUser) {
      await prisma.membership
        .create({ data: { userId: linkedUser.id, teamId, role: "player", playerId: player.id } })
        .catch((e) => console.error("[teamAssignmentSync] membership create skipped:", e.message));
    }
  }

  for (const player of toRemove) {
    await prisma.$transaction([
      prisma.playerVideo.deleteMany({ where: { playerId: player.id } }),
      prisma.playerEvaluation.deleteMany({ where: { playerId: player.id } }),
      prisma.rSVP.deleteMany({ where: { playerId: player.id } }),
      prisma.message.updateMany({ where: { authorPlayerId: player.id }, data: { authorPlayerId: null } }),
      prisma.membership.deleteMany({ where: { playerId: player.id } }),
      prisma.player.delete({ where: { id: player.id } }),
    ]);
  }

  return { added: toAdd.length, removed: toRemove.length };
}

/**
 * The reverse direction: called after a coach adds/removes a player from a
 * team inside the TeamSync app itself, to push that player's full current
 * team list back to WordPress so pp_team_ids stays accurate there too.
 */
async function pushTeamAssignmentToWordpress(wpPlayerId) {
  if (!wpPlayerId) return;
  const base = process.env.WORDPRESS_FBI_API_BASE;
  const secret = process.env.WORDPRESS_AUTH_BRIDGE_SECRET;
  if (!base || !secret) {
    console.warn("[teamAssignmentSync] WORDPRESS_FBI_API_BASE / WORDPRESS_AUTH_BRIDGE_SECRET not set, skipping push");
    return;
  }

  const axios = require("axios");
  const players = await prisma.player.findMany({ where: { wpPlayerId } });
  const teamIds = players.map((p) => p.teamId);

  try {
    await axios.put(
      `${base}/players/${wpPlayerId}/teams`,
      { teamIds },
      { headers: { "x-fbi-api-secret": secret }, timeout: 10000 }
    );
  } catch (err) {
    console.error("[teamAssignmentSync] push to WordPress failed:", err.message);
  }
}

module.exports = { applyWordpressTeamAssignment, pushTeamAssignmentToWordpress };
