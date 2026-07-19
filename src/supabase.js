const { createClient } = require("@supabase/supabase-js");

// Used for Supabase Storage (player/favorite-player photo uploads). The
// service role key is required here since uploads happen server-side on
// behalf of the logged-in coach/player, not directly from their browser.
let supabase = null;

function getSupabase() {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set to upload images");
  }
  supabase = createClient(url, key);
  return supabase;
}

module.exports = { getSupabase };
