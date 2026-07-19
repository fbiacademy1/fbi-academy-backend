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
  return res.data;
} catch (err) {
  if (err.response && (err.response.status === 401 || err.response.status === 400)) {
    return null;
  }
  throw err;
}
}

module.exports = { verifyWordpressCredentials };
