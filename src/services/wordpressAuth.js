const axios = require("axios");

// Network-level failures (no HTTP response at all) worth retrying - these
// mean the request never reached WordPress or never got a reply, as opposed
// to WordPress actively answering with an error (401/400/500/etc), which we
// should NOT retry. Seen in practice: Hostinger's shared-hosting bot/DDoS
// protection intermittently silently drops connections that look like
// server-to-server traffic from a cloud host (e.g. Render) rather than a
// browser - see the 2026-09-05 incident where every login attempt failed
// with ETIMEDOUT here while the same endpoint answered a normal browser
// request instantly. Retrying gives that a couple of chances to clear
// before giving up, since it has historically been intermittent rather than
// a hard, permanent block.
const RETRYABLE_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "ECONNABORTED", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [500, 1500]; // between attempts 1->2 and 2->3
const PER_ATTEMPT_TIMEOUT_MS = 4000; // kept short so 3 attempts + backoff still fits comfortably under the mobile app's own request timeout (see client.js's login() override)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableNetworkError(err) {
  return !err.response && RETRYABLE_CODES.has(err.code);
}

async function verifyWordpressCredentials(email, password) {
    const base = process.env.WORDPRESS_FBI_API_BASE;
    const secret = process.env.WORDPRESS_AUTH_BRIDGE_SECRET;
    if (!base || !secret) {
          throw new Error("WORDPRESS_FBI_API_BASE / WORDPRESS_AUTH_BRIDGE_SECRET not configured");
    }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
                  timeout: PER_ATTEMPT_TIMEOUT_MS,
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

          if (isRetryableNetworkError(err) && attempt < MAX_ATTEMPTS) {
            console.warn(`[wordpressAuth] /auth/verify attempt ${attempt} failed with ${err.code}, retrying...`);
            await sleep(RETRY_DELAYS_MS[attempt - 1]);
            continue;
          }

          if (isRetryableNetworkError(err)) {
            // Exhausted retries on a pure network failure (not a credentials
            // problem) - surface this distinctly so the route layer can
            // return a clear "try again" message instead of a bare 500.
            console.error(`[wordpressAuth] /auth/verify unreachable after ${MAX_ATTEMPTS} attempts: ${err.code}`);
            const unreachableErr = new Error("WordPress auth service unreachable");
            unreachableErr.isWpUnreachable = true;
            throw unreachableErr;
          }

          throw err;
    }
  }
}

module.exports = { verifyWordpressCredentials };
