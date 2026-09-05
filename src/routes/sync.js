const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const { requireWordpressSecret, requireFbiSecret } = require("../middleware/auth");
const { applyWordpressWebhook } = require("../services/wordpressSync");
const { applyWordpressTeamAssignment, applyWordpressCoachTeamAssignment, applyWordpressCreateTeam, applyWordpressDeleteTeam, applyWordpressGuardianLink, removeWordpressPlayer } = require("../services/teamAssignmentSync");
const { applyWordpressEvaluations } = require("../services/evaluationSync");
const { getSupabase } = require("../supabase");
const prisma = require("../db");

const router = express.Router();

// Same 150MB/video-mimetype limit as POST /api/uploads/video - see that
// route's comment for why. Kept as its own multer instance here (rather
// than importing uploads.js's) so this file's dependencies stay self-
// contained and the two routers can evolve independently.
const uploadVideo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("video/")) return cb(new Error("Only video uploads are allowed"));
    cb(null, true);
  },
});

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

// GET /api/sync/team-players?teamId=<postgres team id>
// Lets the website's "Upload Training Video" form (teamsync-sync.php) build
// a player checklist for a chosen team without needing any JWT/session -
// just the team's TeamSync id from GET /teams above. Only returns players
// that actually have a WordPress login linked (wpPlayerId set), since
// wpPlayerId is what wordpress-video-upload uses to map the checked boxes
// back to Player rows.
router.get("/team-players", requireFbiSecret, async (req, res) => {
  const teamId = String(req.query.teamId || "").trim();
  if (!teamId) return res.status(400).json({ error: "teamId is required" });

  const players = await prisma.player.findMany({
    where: { teamId, wpPlayerId: { not: null } },
    select: { id: true, firstName: true, lastName: true, jerseyNumber: true, wpPlayerId: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
  res.json(players);
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

// POST /api/sync/wordpress-evaluations
// Called by the Coach Portal whenever a coach saves the "Player Evaluations
// (QDE)" section on a player's Edit Player screen. Body: { wpPlayerId,
// evaluations }. See applyWordpressEvaluations for exactly how this
// reconciles - it's a two-way bridge, not a single shared database; see
// evaluationSync.js for the full explanation and loop-safety notes.
router.post("/wordpress-evaluations", requireFbiSecret, async (req, res) => {
  try {
    const result = await applyWordpressEvaluations(req.body);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[sync] evaluations webhook error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/sync/wordpress-video-upload
// Called by the Coach Portal's website "Upload Training Video" form
// (teamsync-sync.php) when a coach/admin picks a real video FILE (not a
// pasted YouTube/Vimeo link) and chooses which players it goes to - the
// website equivalent of the mobile app's Bulk Video Upload screen /
// POST /api/players/videos/bulk-assign. The website has no JWT to act as a
// TeamSync user, so this goes through the same shared-secret bridge as the
// other wordpress-* routes above instead of requireAuth.
//
// multipart/form-data body:
//   video        - the file itself, field name "video"
//   title        - video title
//   wpPlayerIds  - comma-separated WordPress user IDs of the target players
//   teamId       - optional TeamSync (Postgres) team id, same id WordPress
//                  already sends as part of teamIds in
//                  wordpress-team-assignment above. If a person has a Player
//                  row on more than one team (same wpPlayerId), this narrows
//                  the match to just the team the coach was viewing. Omit to
//                  match ALL of that person's teams (rare, but harmless for
//                  a single-team club).
router.post(
  "/wordpress-video-upload",
  requireFbiSecret,
  uploadVideo.single("video"),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No video file provided" });

    const title = (req.body.title || "").trim();
    if (!title) return res.status(400).json({ error: "title is required" });

    const wpPlayerIds = String(req.body.wpPlayerIds || "")
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n));
    if (wpPlayerIds.length === 0) {
      return res.status(400).json({ error: "wpPlayerIds is required" });
    }

    try {
      const bucket = process.env.SUPABASE_VIDEO_BUCKET || "training-videos";
      const ext = (req.file.originalname.match(/\.[a-zA-Z0-9]+$/) || [".mp4"])[0];
      const filename = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`;

      const supabase = getSupabase();
      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
      if (uploadError) {
        console.error("[sync] video upload failed:", uploadError.message);
        return res.status(502).json({ error: "Upload failed - try again" });
      }
      const { data: publicUrlData } = supabase.storage.from(bucket).getPublicUrl(filename);
      const url = publicUrlData.publicUrl;

      const teamId = req.body.teamId ? String(req.body.teamId).trim() : null;
      const players = await prisma.player.findMany({
        where: {
          wpPlayerId: { in: wpPlayerIds },
          ...(teamId ? { teamId } : {}),
        },
        select: { id: true },
      });
      if (players.length === 0) {
        return res.status(404).json({ error: "None of the selected players were found" });
      }

      const lastPositions = await prisma.playerVideo.groupBy({
        by: ["playerId"],
        where: { playerId: { in: players.map((p) => p.id) } },
        _max: { position: true },
      });
      const posByPlayer = new Map(lastPositions.map((row) => [row.playerId, row._max.position ?? -1]));

      const videos = await prisma.$transaction(
        players.map((p) =>
          prisma.playerVideo.create({
            data: { playerId: p.id, title, url, position: (posByPlayer.get(p.id) ?? -1) + 1 },
          })
        )
      );

      res.status(201).json({ ok: true, count: videos.length, url });
    } catch (err) {
      console.error("[sync] video upload error:", err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

// --- Player Portal training videos (2026-09-05 unification) ---------------
// The WordPress Player Portal (player-profiles plugin's [player_portal]
// shortcode) used to keep its own separate copy of each player's training
// videos in pp_videos/pp_watched_videos user meta - completely disconnected
// from this PlayerVideo table, which the mobile app, App Portal, and the
// website's "Upload Training Video" form (wordpress-video-upload above) all
// already use. That meant a video assigned on one surface silently never
// showed up on the others. These four endpoints let the WordPress plugin
// read/write PlayerVideo directly instead, keyed by wpPlayerId (the WP user
// id) same as every other wordpress-* route in this file, so there is now
// exactly one training-video list per player, shared everywhere.

// GET /api/sync/player-videos?wpPlayerId=<wp user id>
router.get("/player-videos", requireFbiSecret, async (req, res) => {
  const wpPlayerId = parseInt(req.query.wpPlayerId, 10);
  if (!Number.isInteger(wpPlayerId)) {
    return res.status(400).json({ error: "wpPlayerId is required" });
  }

  const player = await prisma.player.findFirst({ where: { wpPlayerId } });
  if (!player) {
    // Not an error - a WP player who hasn't been synced/rostered into
    // TeamSync yet just has an empty video list, same as "no videos assigned".
    return res.json({ videos: [] });
  }

  const videos = await prisma.playerVideo.findMany({
    where: { playerId: player.id },
    orderBy: { position: "asc" },
  });
  res.json({ videos });
});

// POST /api/sync/player-videos
// Body: { wpPlayerId, title, url, instructions?, irfUrl? }
// Used by the Player Portal's wp-admin "Training Videos" repeater (Edit User
// screen) to add a video for one player, same shared-secret bridge pattern
// as wordpress-video-upload above.
router.post("/player-videos", requireFbiSecret, async (req, res) => {
  const wpPlayerId = parseInt(req.body.wpPlayerId, 10);
  const title = (req.body.title || "").trim();
  const url = (req.body.url || "").trim();
  if (!Number.isInteger(wpPlayerId) || !title || !url) {
    return res.status(400).json({ error: "wpPlayerId, title, and url are required" });
  }

  const player = await prisma.player.findFirst({ where: { wpPlayerId } });
  if (!player) {
    return res.status(404).json({ error: "No TeamSync player found for that wpPlayerId" });
  }

  const last = await prisma.playerVideo.aggregate({
    where: { playerId: player.id },
    _max: { position: true },
  });

  const video = await prisma.playerVideo.create({
    data: {
      playerId: player.id,
      title,
      url,
      instructions: req.body.instructions || undefined,
      irfUrl: req.body.irfUrl || undefined,
      position: (last._max.position ?? -1) + 1,
    },
  });
  res.status(201).json(video);
});

// PUT /api/sync/player-videos/:id
// Body: { wpPlayerId, title?, url?, instructions?, irfUrl? } - edits an
// existing video. wpPlayerId is required as a lightweight ownership check
// (this route has no per-user session to authorize against otherwise).
router.put("/player-videos/:id", requireFbiSecret, async (req, res) => {
  const wpPlayerId = parseInt(req.body.wpPlayerId, 10);
  if (!Number.isInteger(wpPlayerId)) {
    return res.status(400).json({ error: "wpPlayerId is required" });
  }

  const video = await prisma.playerVideo.findUnique({
    where: { id: req.params.id },
    include: { player: true },
  });
  if (!video || video.player.wpPlayerId !== wpPlayerId) {
    return res.status(404).json({ error: "Video not found" });
  }

  const updated = await prisma.playerVideo.update({
    where: { id: video.id },
    data: {
      title: req.body.title || undefined,
      url: req.body.url || undefined,
      instructions: "instructions" in req.body ? req.body.instructions || null : undefined,
      irfUrl: "irfUrl" in req.body ? req.body.irfUrl || null : undefined,
    },
  });
  res.json(updated);
});

// DELETE /api/sync/player-videos/:id?wpPlayerId=<wp user id>
router.delete("/player-videos/:id", requireFbiSecret, async (req, res) => {
  const wpPlayerId = parseInt(req.query.wpPlayerId, 10);
  if (!Number.isInteger(wpPlayerId)) {
    return res.status(400).json({ error: "wpPlayerId is required" });
  }

  const video = await prisma.playerVideo.findUnique({
    where: { id: req.params.id },
    include: { player: true },
  });
  if (!video || video.player.wpPlayerId !== wpPlayerId) {
    return res.status(404).json({ error: "Video not found" });
  }

  await prisma.playerVideo.delete({ where: { id: video.id } });
  res.status(204).end();
});

// PATCH /api/sync/player-videos/:id/watched
// Body: { wpPlayerId, watched? } - the Player Portal's "Mark as Watched"
// button, mirroring PATCH /api/players/:id/videos/:videoId/watched (the
// JWT-authenticated equivalent used by the mobile app/App Portal).
router.patch("/player-videos/:id/watched", requireFbiSecret, async (req, res) => {
  const wpPlayerId = parseInt(req.body.wpPlayerId, 10);
  if (!Number.isInteger(wpPlayerId)) {
    return res.status(400).json({ error: "wpPlayerId is required" });
  }

  const video = await prisma.playerVideo.findUnique({
    where: { id: req.params.id },
    include: { player: true },
  });
  if (!video || video.player.wpPlayerId !== wpPlayerId) {
    return res.status(404).json({ error: "Video not found" });
  }

  const nextWatched = typeof req.body.watched === "boolean" ? req.body.watched : !video.watchedAt;
  const updated = await prisma.playerVideo.update({
    where: { id: video.id },
    data: { watchedAt: nextWatched ? new Date() : null },
  });
  res.json(updated);
});

module.exports = router;
