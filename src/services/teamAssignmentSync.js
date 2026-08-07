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
 * Called when WordPress pushes a coach's full current team list (a coach
  * created or edited via the Coach Portal's admin-only "Create Coach"
   * screen). Unlike a player, a coach IS a TeamSync User directly (found or
    * created via wpUserId) - there's no per-team Player row involved - so this
     * reconciles Membership rows with role:"coach" directly on that User to
      * match WordPress's pp_coach_team_ids field.
       */
async function applyWordpressCoachTeamAssignment({ wpCoachId, email, firstName, lastName, teamIds }) {
    if (!wpCoachId) throw new Error("wpCoachId is required");
    const newTeamIds = Array.isArray(teamIds) ? teamIds : [];
  
    let user = await prisma.user.findUnique({ where: { wpUserId: wpCoachId } });
    if (!user) {
          if (!email) throw new Error("email is required to create a new coach User");
          const existingByEmail = await prisma.user.findUnique({ where: { email } });
          user = existingByEmail
            ? await prisma.user.update({ where: { id: existingByEmail.id }, data: { wpUserId: wpCoachId } })
                  : await prisma.user.create({ data: { email, wpUserId: wpCoachId } });
    } else if (email && user.email !== email) {
          user = await prisma.user.update({ where: { id: user.id }, data: { email } });
    }
  
    const existing = await prisma.membership.findMany({ where: { userId: user.id, role: "coach" } });
    const existingTeamIds = existing.map((m) => m.teamId);
  
    const toAdd = newTeamIds.filter((id) => !existingTeamIds.includes(id));
    const toRemove = existing.filter((m) => !newTeamIds.includes(m.teamId));
  
    for (const teamId of toAdd) {
          await prisma.membership
            .create({ data: { userId: user.id, teamId, role: "coach" } })
            .catch((e) => console.error("[teamAssignmentSync] coach membership create skipped:", e.message));
    }
  
    for (const membership of toRemove) {
          await prisma.membership.delete({ where: { id: membership.id } });
    }
  
    return { userId: user.id, added: toAdd.length, removed: toRemove.length };
}

/**
 * Called from the Coach Portal's admin-only "+ Add Team" action to create a
  * brand-new team directly. Unlike POST /api/teams (which requires a coach's
   * own TeamSync login and auto-enrolls them as its coach), this is
    * shared-secret authenticated so an admin can create a team on someone
     * else's behalf, then assign a coach to it separately via
      * applyWordpressCoachTeamAssignment above.
       */
async function applyWordpressCreateTeam({ name, sport, season }) {
    if (!name) throw new Error("name is required");
    if (!sport) throw new Error("sport is required");
  
    const team = await prisma.team.create({
          data: { name, sport, season: season || null },
    });
  
    return { teamId: team.id, teamName: team.name, sport: team.sport, season: team.season };
}

/**
 * Called from the Coach Portal whenever a player's guardian email is set or
 * changed. Reconciles ONE guardian's WordPress account against TeamSync:
 * finds-or-creates the guardian's own User row (same wpUserId-linking
 * pattern as a coach or player login above), then makes their role:"parent"
 * Memberships match the full, fresh list of {wpPlayerId, teamId} pairs
 * WordPress just computed for every child sharing this guardian email -
 * adding any missing, updating any that moved, and removing any no longer
 * there. Unlike a child's own Membership.playerId (unique - one login per
 * Player, so the app always knows who a roster row "belongs" to),
 * viewPlayerId is deliberately NOT unique - it exists purely to tell the
 * app "which player is this guardian currently looking at", not to grant
 * ownership, so several guardians (or a guardian and the child themselves)
 * can all have their own separate login pointing at the same Player.
 */
async function applyWordpressGuardianLink({ wpGuardianId, email, children }) {
  if (!wpGuardianId) throw new Error("wpGuardianId is required");
  const pairs = Array.isArray(children) ? children : [];

  let user = await prisma.user.findUnique({ where: { wpUserId: wpGuardianId } });
  if (!user) {
    if (!email) throw new Error("email is required to create a new guardian User");
    const existingByEmail = await prisma.user.findUnique({ where: { email } });
    user = existingByEmail
      ? await prisma.user.update({ where: { id: existingByEmail.id }, data: { wpUserId: wpGuardianId } })
      : await prisma.user.create({ data: { email, wpUserId: wpGuardianId } });
  } else if (email && user.email !== email) {
    user = await prisma.user.update({ where: { id: user.id }, data: { email } });
  }

  // Resolve each {wpPlayerId, teamId} pair WordPress sent to a real Player
  // row on that team - a pair silently drops if that roster row hasn't
  // synced yet rather than failing the whole request.
  const resolved = [];
  for (const { wpPlayerId, teamId } of pairs) {
    if (!wpPlayerId || !teamId) continue;
    const player = await prisma.player.findFirst({ where: { wpPlayerId, teamId } });
    if (player) resolved.push({ teamId, playerId: player.id });
  }

  const existing = await prisma.membership.findMany({ where: { userId: user.id, role: "parent" } });
  const existingByTeam = new Map(existing.map((m) => [m.teamId, m]));
  const wantedTeamIds = new Set(resolved.map((r) => r.teamId));

  let added = 0, updated = 0, removed = 0;
  for (const { teamId, playerId } of resolved) {
    const current = existingByTeam.get(teamId);
    if (!current) {
      await prisma.membership
        .create({ data: { userId: user.id, teamId, role: "parent", viewPlayerId: playerId } })
        .then(() => { added += 1; })
        // A non-"parent" membership already on this team (e.g. this same
        // person is also a coach there) collides with the userId+teamId
        // unique constraint - skip rather than clobber it.
        .catch((e) => console.error("[teamAssignmentSync] guardian membership create skipped:", e.message));
    } else if (current.viewPlayerId !== playerId) {
      await prisma.membership.update({ where: { id: current.id }, data: { viewPlayerId: playerId } });
      updated += 1;
    }
  }
  for (const m of existing) {
    if (!wantedTeamIds.has(m.teamId)) {
      await prisma.membership.delete({ where: { id: m.id } });
      removed += 1;
    }
  }

  return { userId: user.id, added, updated, removed };
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

module.exports = {
  applyWordpressTeamAssignment,
  applyWordpressCoachTeamAssignment,
  applyWordpressCreateTeam,
  applyWordpressGuardianLink,
  pushTeamAssignmentToWordpress,
};
