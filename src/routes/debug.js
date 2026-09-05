const express = require("express");
const axios = require("axios");

const router = express.Router();

// GET /api/debug/wp-check
// TEMPORARY diagnostic route for the 2026-09-05 Render<->Hostinger
// connectivity incident (see wordpressAuth.js). Render's Free tier only
// exposes a shared /24 outbound IP range in its dashboard, not a
// per-request source IP - which isn't specific enough for Hostinger
// support to search their firewall logs against. This route reports the
// exact outbound IP this Render instance is using RIGHT NOW (via a public
// IP-echo service) alongside the outcome of making the *same* call our
// login flow makes to WordPress's /auth/verify endpoint, so we can hand
// Hostinger a single IP + exact timestamp + real result instead of a
// historical log screenshot they can't match against a shared range.
//
// Safe to leave temporarily: no user data, no secrets in the response.
// Remove once the Hostinger/Render connectivity issue is resolved.
router.get("/wp-check", async (req, res) => {
  const timestamp = new Date().toISOString();

  let outboundIp = null;
  let ipError = null;
  try {
    const ipRes = await axios.get("https://api.ipify.org?format=json", { timeout: 5000 });
    outboundIp = ipRes.data.ip;
  } catch (err) {
    ipError = err.code || err.message;
  }

  const base = process.env.WORDPRESS_FBI_API_BASE;
  const secret = process.env.WORDPRESS_AUTH_BRIDGE_SECRET;
  let wordpressCheck;
  if (!base || !secret) {
    wordpressCheck = { ok: false, error: "WORDPRESS_FBI_API_BASE / WORDPRESS_AUTH_BRIDGE_SECRET not configured" };
  } else {
    const started = Date.now();
    try {
      const wpRes = await axios.post(
        `${base}/auth/verify`,
        { email: "debug-check@example.com", password: "not-a-real-password" },
        {
          headers: {
            "x-fbi-api-secret": secret,
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          },
          timeout: 8000,
          validateStatus: () => true, // we want to see 401s etc, not throw
        }
      );
      wordpressCheck = {
        ok: true,
        httpStatus: wpRes.status,
        tookMs: Date.now() - started,
        note: "ok:true just means WordPress answered at all - a 401 here is expected/healthy since the credentials are fake.",
      };
    } catch (err) {
      wordpressCheck = {
        ok: false,
        errorCode: err.code || null,
        errorMessage: err.message,
        tookMs: Date.now() - started,
      };
    }
  }

  res.json({ timestamp, outboundIp, ipError, wordpressCheck });
});

module.exports = router;
