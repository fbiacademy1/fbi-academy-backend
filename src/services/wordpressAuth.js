const axios = require("axios");

async function verifyWordpressCredentials(email, password) {
    const base = process.env.WORDPRESS_FBI_API_BASE;
    const secret = process.env.WORDPRESS_AUTH_BRIDGE_SECRET;
    if (!base || !secret) {
          throw new Error("WORDPRESS_FBI_API_BASE / WORDPRESS_AUTH_BRIDGE_SECRET not configured");
    }

  try {
        const res = await axios.post(
                `${base}/auth/login`,
          { email, password },
          { headers: { "x-fbi-api-secret": secret }, timeout: 10000 }
              );
        if (!res.data || typeof res.data !== "object" || !res.data.id) {
                // WordPress answered with HTTP 200 but not the JSON shape the Coach
          // Portal's /auth/login endpoint returns. This has been seen when
          // something sits in front of the real endpoint (a security/WAF
          // challenge page, cached response, etc.) instead of a real
          // credential check. Log a snippet so it's diagnosable from Render
          // logs, and fail closed instead of crashing downstream on a missing
          // id.
          console.error(
                    "[wordpressAuth] /auth/login returned 200 with an unexpected body:",
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
