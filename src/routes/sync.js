const express = require("express");
const { requireWordpressSecret } = require("../middleware/auth");
const { applyWordpressWebhook } = require("../services/wordpressSync");

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

module.exports = router;
