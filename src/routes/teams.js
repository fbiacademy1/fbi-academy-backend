const express = require("express");
const prisma = require("../db");
const { requireAuth } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();
router.use(requireAuth);

// GET /api/teams - every team the logged-in user belongs to, with their role on each
router.get("/", asyncHandler(async (req, res) => {
  const memberships = await prisma.membership.findMany({
    where: { userId: req.user.userId },
    include: { team: true },
  });

  // See the matching comment in auth.js membershipsFor() - a guardian can
  // hold more than one role:"parent" membership on the same team (one per
  // linked child), so batch-fetch each linked child's name for a
  // disambiguating `playerName` label.
  const mergedPlayerIds = [...new Set(memberships.map((m) => m.playerId || m.viewPlayerId).filter(Boolean))];
  const players = mergedPlayerIds.length
    ? await prisma.player.findMany({
        where: { id: { in: mergedPlayerIds } },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const playerNameById = new Map(players.map((p) => [p.id, `${p.firstName} ${p.lastName}`.trim()]));

  res.json(
    memberships.map((m) => {
      // See the matching comment in auth.js membershipsFor() - merges a
      // guardian's viewPlayerId in so parent-role memberships behave like
      // player-role ones everywhere the app reads playerId.
      const mergedPlayerId = m.playerId || m.viewPlayerId;
      return {
        teamId: m.teamId,
        teamName: m.team.name,
        sport: m.team.sport,
        season: m.team.season,
        role: m.role,
        playerId: mergedPlayerId,
        playerName: m.role === "parent" ? playerNameById.get(mergedPlayerId) || null : null,
        homeJerseyColor: m.team.homeJerseyColor,
        homeShortsColor: m.team.homeShortsColor,
        homeSocksColor: m.team.homeSocksColor,
        awayJerseyColor: m.team.awayJerseyColor,
        awayShortsColor: m.team.awayShortsColor,
        awaySocksColor: m.team.awaySocksColor,
      };
    })
  );
}));

// PUT /api/teams/:id/uniforms - sets default home/away jersey, shorts, and
// socks colors used to auto-populate new matches. Admin/coach on this team only.
router.put("/:id/uniforms", asyncHandler(async (req, res) => {
  const teamId = req.params.id;
  // findFirst, not findUnique: a guardian can hold more than one membership
  // on this team now, but none of them will ever be role admin/coach, so
  // which one this picks doesn't affect the check below.
  const membership = await prisma.membership.findFirst({
    where: { userId: req.user.userId, teamId },
  });
  if (!membership || !["admin", "coach"].includes(membership.role)) {
    return res.status(403).json({ error: "Only a coach/admin on this team can edit uniform colors" });
  }

  const { homeJerseyColor, homeShortsColor, homeSocksColor, awayJerseyColor, awayShortsColor, awaySocksColor } = req.body;
  const team = await prisma.team.update({
    where: { id: teamId },
    data: {
      homeJerseyColor: homeJerseyColor ?? null,
      homeShortsColor: homeShortsColor ?? null,
      homeSocksColor: homeSocksColor ?? null,
      awayJerseyColor: awayJerseyColor ?? null,
      awayShortsColor: awayShortsColor ?? null,
      awaySocksColor: awaySocksColor ?? null,
    },
  });
  res.json(team);
}));

// POST /api/teams - create a new team; the creator becomes its coach
router.post("/", asyncHandler(async (req, res) => {
  const { name, sport, season } = req.body;
  if (!name || !sport) return res.status(400).json({ error: "name and sport are required" });

  const team = await prisma.team.create({ data: { name, sport, season: season || null } });
  await prisma.membership.create({ data: { userId: req.user.userId, teamId: team.id, role: "coach" } });

  res.status(201).json({ teamId: team.id, teamName: team.name, sport: team.sport, season: team.season, role: "coach", playerId: null });
}));

// DELETE /api/teams/:id  (admin/coach on THIS team only) - deletes the team
// and everything scoped to it: players, events, RSVPs, videos, evaluations,
// team chat, and direct messages tied to this team. Only removes the
// Membership rows (access grants) for this team - user accounts themselves,
// and their access to any OTHER team, are untouched.
router.delete("/:id", asyncHandler(async (req, res) => {
  const teamId = req.params.id;

  // findFirst, not findUnique - see the matching comment on PUT /:id/uniforms above.
  const membership = await prisma.membership.findFirst({
    where: { userId: req.user.userId, teamId },
  });
  if (!membership || !["admin", "coach"].includes(membership.role)) {
    return res.status(403).json({ error: "Only a coach/admin on this team can delete it" });
  }

  const team = await prisma.team.findUnique({ where: { id: teamId } });
  if (!team) return res.status(404).json({ error: "Team not found" });

  await prisma.$transaction([
    prisma.playerVideo.deleteMany({ where: { player: { teamId } } }),
    prisma.playerEvaluation.deleteMany({ where: { player: { teamId } } }),
    prisma.rSVP.deleteMany({ where: { player: { teamId } } }),
    prisma.rSVP.deleteMany({ where: { event: { teamId } } }),
    prisma.message.deleteMany({ where: { teamId } }),
    prisma.directMessage.deleteMany({ where: { teamId } }),
    prisma.event.deleteMany({ where: { teamId } }),
    prisma.membership.deleteMany({ where: { teamId } }),
    prisma.player.deleteMany({ where: { teamId } }),
    prisma.team.delete({ where: { id: teamId } }),
  ]);

  res.status(204).end();
}));

module.exports = router;
