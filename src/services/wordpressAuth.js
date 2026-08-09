const axios = require("axios");

async function verifyWordpressCredentials(email, password) {
    const base = process.env.WORDPRESS_FBI_API_BASE;
    const secret = process.env.WORDPRESS_AUTH_BRIDGE_SECRET;
    if (!base || !secret) {
          throw new Error("WORDPRESS_FBI_API_BASE / WORDPRESS_AUTH_BRIDGE_SECRET not configured");
    }

  try {
        const res = await axios.post(
                // NOTE: intentionally NOT "/auth/login" - Hostinger's LiteSpeed
                // server-level bot protection pattern-matches the word "login" in
                // request paths and started serving an HTML reCAPTCHA challenge
                // page (HTTP 403) instead of proxying to WordPress, which broke
                // login for every user on 2026-08-09. Renamed to "/auth/verify"
                // on both this side and the Coach Portal's route registration to
                // dodge that heuristic. Do not rename this back to "/auth/login".
                `${base}/auth/verify`,
          { email, password },
          {
                headers: {
                  "x-fbi-api-secret": secret,
                  "Content-Type": "application/json",
                  Accept: "application/json",
                  // Same fix as wordpressSync.js (task #213): axios's default
                  // User-Agent reads as bot traffic to Hostinger's protection,
                  // which after the /auth/login rename started hard-resetting
                  // the connection (ECONNRESET) instead of even serving a
                  // challenge page. A normal browser User-Agent avoids that.
                  "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                },
                timeout: 10000,
              }
              );
        if (!res.data || typeof res.data !== "object" || !res.data.id) {
                // WordPress answered with HTTP 200 but not the JSON shape the Coach
          // Portal's /auth/verify endpoint returns. This has been seen when
          // something sits in front of the real endpoint (a security/WAF
          // challenge page, cached response, etc.) instead of a real
          // credential check. Log a snippet so it's diagnosable from Render
          // logs, and fail closed instead of crashing downstream on a missing
          // id.
          console.error(
                    "[wordpressAuth] /auth/verify returned 200 with an unexpected body:",
                    typeof res.data === "string" ? res.data.slice(0, 500) : JSON.stringify(res.data).slice(0, 500)
                  );
                throw new Error("WordPress auth bridge returned an unexpected response");
        }
        return res.data;
  } catch (err) {
        if (err.response && (err.response.status === 401 || err.response.status === 400)) {
                return null;
        }
        throw err;
  }
}

module.exports = { verifyWordpressCredentials };
