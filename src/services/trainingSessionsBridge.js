const axios = require("axios");

// Talks to the fts/v1 REST API added to the live fbi-training-sessions.php
// WordPress plugin (see wordpress-plugin/ for context - that plugin's own
// front-end portal at fbiacademy.org/training-sessions/ owns this data;
// this bridge just lets the TeamSync mobile app read/write the same posts
// server-to-server). Authenticated the same way wordpressAuth.js /
// teamAssignmentSync.js talk to the Coach Portal: a shared secret header
// plus the acting coach's email, since the mobile app never holds a WP
// session of its own.
function client() {
  const base = process.env.FTS_API_BASE;
  const secret = process.env.TRAINING_SESSIONS_API_SECRET;
  if (!base || !secret) {
    throw new Error("FTS_API_BASE / TRAINING_SESSIONS_API_SECRET not configured");
  }
  return { base, secret };
}

function headersFor(userEmail) {
  const { secret } = client();
  return {
    "x-fts-api-secret": secret,
    "x-fts-user-email": userEmail,
  };
}

// Re-throws WordPress's WP_Error-shaped response body as-is (it already has
// {code, message, data:{status}}) so the route layer can relay status/message
// straight through instead of everything collapsing to a generic 500.
function unwrap(err) {
  if (err.response && err.response.data) {
    const wpError = new Error(err.response.data.message || "Training Sessions API error");
    wpError.status = err.response.data.data?.status || err.response.status || 502;
    wpError.wpError = err.response.data;
    throw wpError;
  }
  throw err;
}

async function listSessions(userEmail, teamName) {
  const { base } = client();
  try {
    const res = await axios.get(`${base}/sessions`, {
      headers: headersFor(userEmail),
      params: teamName ? { team: teamName } : undefined,
      timeout: 10000,
    });
    return res.data;
  } catch (err) {
    unwrap(err);
  }
}

async function getSession(userEmail, id) {
  const { base } = client();
  try {
    const res = await axios.get(`${base}/sessions/${id}`, { headers: headersFor(userEmail), timeout: 10000 });
    return res.data;
  } catch (err) {
    unwrap(err);
  }
}

async function createSession(userEmail, payload) {
  const { base } = client();
  try {
    const res = await axios.post(`${base}/sessions`, payload, { headers: headersFor(userEmail), timeout: 10000 });
    return res.data;
  } catch (err) {
    unwrap(err);
  }
}

async function updateSession(userEmail, id, payload) {
  const { base } = client();
  try {
    const res = await axios.put(`${base}/sessions/${id}`, payload, { headers: headersFor(userEmail), timeout: 10000 });
    return res.data;
  } catch (err) {
    unwrap(err);
  }
}

async function deleteSession(userEmail, id) {
  const { base } = client();
  try {
    const res = await axios.delete(`${base}/sessions/${id}`, { headers: headersFor(userEmail), timeout: 10000 });
    return res.data;
  } catch (err) {
    unwrap(err);
  }
}

module.exports = { listSessions, getSession, createSession, updateSession, deleteSession };
