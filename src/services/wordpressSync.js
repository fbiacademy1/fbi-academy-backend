/**
 * WordPress sync service.
 *
 * This backend is the source of truth. Whenever a player profile changes here
 * (e.g. a player edits their profile in the mobile app), we push the new data
 * to the companion WordPress plugin's REST endpoint, which upserts a
 * "player_profile" custom post so the website reflects the change.
 *
 * WordPress can also be the origin of a change (a coach edits a profile
 * directly in wp-admin). The WP plugin calls back into this backend's
 * /api/sync/webhook/wordpress endpoint (see routes/sync.js) when that happens.
 *
 * To avoid ping-pong loops (push -> webhook -> push -> ...), every payload
 * carries a content hash. Before pushing, we skip the call if the player's
 * lastSyncedHash already matches the current data.
 */

const axios = require("axios");
const crypto = require("crypto");
const prisma = require("../db");

function hashPlayer(player) {
  const fields = {
    firstName: player.firstName,
    lastName: player.lastName,
    email: player.email,
    phone: player.phone,
    jerseyNumber: player.jerseyNumber,
    position: player.position,
    photoUrl: player.photoUrl,
    favoritePlayerPhotoUrl: player.favoritePlayerPhotoUrl,
    guardianName: player.guardianName,
    emergencyContact: player.emergencyContact,
  };
  return crypto.createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

async function pushPlayerToWordpress(playerId) {
  const player = await prisma.player.findUnique({ where: { id: playerId } });
  if (!player) return;

  const currentHash = hashPlayer(player);
  if (player.lastSyncedHash === currentHash) {
    return; // nothing actually changed since the last sync in either direction
  }

  const base = process.env.WORDPRESS_API_BASE;
  const secret = process.env.WORDPRESS_SYNC_SECRET;
  if (!base || !secret) {
    console.warn("[wordpressSync] WORDPRESS_API_BASE / WORDPRESS_SYNC_SECRET not set, skipping push");
    return;
  }

  try {
    const res = await axios.post(
      `${base}/players/upsert`,
      {
        teamsync_player_id: player.id,
        wordpress_post_id: player.wordpressPostId || null,
        first_name: player.firstName,
        last_name: player.lastName,
        email: player.email,
        phone: player.phone,
        jersey_number: player.jerseyNumber,
        position: player.position,
        photo_url: player.photoUrl,
        favorite_player_photo_url: player.favoritePlayerPhotoUrl,
        guardian_name: player.guardianName,
        emergency_contact: player.emergencyContact,
        content_hash: currentHash,
      },
      { headers: { "x-teamsync-secret": secret }, timeout: 10000 }
    );

    await prisma.player.update({
      where: { id: player.id },
      data: {
        wordpressPostId: res.data.wordpress_post_id,
        lastSyncedHash: currentHash,
        syncStatus: "synced",
      },
    });
  } catch (err) {
    console.error("[wordpressSync] push failed:", err.message);
    await prisma.player.update({
      where: { id: player.id },
      data: { syncStatus: "error" },
    });
  }
}

/**
 * Called by routes/sync.js when the WP plugin notifies us of a change made
 * directly on the website. Upserts the local player record.
 */
async function applyWordpressWebhook(payload) {
  const {
    teamsync_player_id,
    wordpress_post_id,
    team_id,
    first_name,
    last_name,
    email,
    phone,
    jersey_number,
    position,
    photo_url,
    favorite_player_photo_url,
    guardian_name,
    emergency_contact,
    content_hash,
    video_links, // optional array of { title, url }, sourced from the WP player template
  } = payload;

  const data = {
    firstName: first_name,
    lastName: last_name,
    email,
    phone,
    jerseyNumber: jersey_number,
    position,
    photoUrl: photo_url,
    favoritePlayerPhotoUrl: favorite_player_photo_url,
    guardianName: guardian_name,
    emergencyContact: emergency_contact,
    wordpressPostId: wordpress_post_id,
    lastSyncedHash: content_hash,
    syncStatus: "synced",
  };

  let player;
  if (teamsync_player_id) {
    player = await prisma.player.update({ where: { id: teamsync_player_id }, data });
  } else {
    // New profile created on the website first (no backend record yet).
    const existing = await prisma.player.findFirst({ where: { wordpressPostId: wordpress_post_id } });
    if (existing) {
      player = await prisma.player.update({ where: { id: existing.id }, data });
    } else {
      if (!team_id) {
        throw new Error("team_id is required to create a new player from a WordPress-originated profile");
      }
      player = await prisma.player.create({ data: { ...data, teamId: team_id } });
    }
  }

  // WordPress is the source of truth for video links - replace the local set
  // wholesale on every sync rather than trying to diff/merge.
  if (Array.isArray(video_links)) {
    await prisma.playerVideo.deleteMany({ where: { playerId: player.id } });
    if (video_links.length) {
      await prisma.playerVideo.createMany({
        data: video_links
          .filter((v) => v && v.url)
          .map((v, i) => ({ playerId: player.id, title: v.title || `Video ${i + 1}`, url: v.url, position: i })),
      });
    }
  }

  return player;
}

module.exports = { pushPlayerToWordpress, applyWordpressWebhook, hashPlayer };
