const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const { requireAuth, requireTeamMembership, requireRole } = require("../middleware/auth");
const { getSupabase } = require("../supabase");

const router = express.Router();

// Buffered in memory, then handed straight to Supabase Storage - nothing is
// written to the server's local disk, so uploaded photos survive redeploys
// (Render/Railway wipe local disk on every deploy; Supabase Storage doesn't).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) return cb(new Error("Only image uploads are allowed"));
    cb(null, true);
  },
});

// Separate instance for the Training Video library (drill clips a coach
// records/uploads for the whole team). Videos are much bigger than profile
// photos, so this gets its own generous-but-bounded limit and its own
// Supabase Storage bucket - kept as a fully separate multer config rather
// than a shared one so the 8MB photo limit above is never accidentally
// loosened. 150MB comfortably covers a short (30-90s) 1080p drill clip;
// coaches recording longer/higher-res footage should trim or compress it
// first, same guidance Techne itself gives for its own drill clips.
const uploadVideo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 }, // 150MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("video/")) return cb(new Error("Only video uploads are allowed"));
    cb(null, true);
  },
});

// POST /api/uploads  (multipart/form-data, field name "image")
// Returns a URL the uploaded file can be reached at. Used for player profile
// photos and "favorite player" photos - the app uploads here first, then
// saves the returned URL onto the player record.
router.post("/", requireAuth, upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image file provided" });

  const bucket = process.env.SUPABASE_BUCKET || "player-photos";
  const ext = (req.file.originalname.match(/\.[a-zA-Z0-9]+$/) || [".jpg"])[0];
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`;

  try {
    const supabase = getSupabase();
    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

    if (uploadError) {
      console.error("[uploads] Supabase upload failed:", uploadError.message);
      return res.status(502).json({ error: "Upload failed - try again" });
    }

    const { data } = supabase.storage.from(bucket).getPublicUrl(filename);
    res.status(201).json({ url: data.publicUrl });
  } catch (err) {
    console.error("[uploads] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/uploads/video  (multipart/form-data, field name "video")
// Coach/admin only - used for the Training Video library. Returns a URL,
// same two-step pattern as the image endpoint above: upload the file here
// first, then POST /api/training-videos with the returned url as videoUrl.
router.post(
  "/video",
  requireAuth,
  requireTeamMembership,
  requireRole("admin", "coach"),
  uploadVideo.single("video"),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No video file provided" });

    const bucket = process.env.SUPABASE_VIDEO_BUCKET || "training-videos";
    const ext = (req.file.originalname.match(/\.[a-zA-Z0-9]+$/) || [".mp4"])[0];
    const filename = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`;

    try {
      const supabase = getSupabase();
      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

      if (uploadError) {
        console.error("[uploads] Supabase video upload failed:", uploadError.message);
        return res.status(502).json({ error: "Upload failed - try again" });
      }

      const { data } = supabase.storage.from(bucket).getPublicUrl(filename);
      res.status(201).json({ url: data.publicUrl });
    } catch (err) {
      console.error("[uploads] video error:", err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

// POST /api/uploads/skill-video  (multipart/form-data, field name "video")
// Any team member (player, parent, coach, admin) - used for the trick-video
// submission feature. Deliberately NOT gated to requireRole("admin","coach")
// like /video above: players/parents are exactly who needs to upload here.
// Reuses the same multer config/size limit as the training-video upload,
// just a separate bucket so submissions never mix with the coach-curated
// drill library.
router.post(
  "/skill-video",
  requireAuth,
  requireTeamMembership,
  uploadVideo.single("video"),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No video file provided" });

    const bucket = process.env.SUPABASE_SKILL_VIDEO_BUCKET || "skill-videos";
    const ext = (req.file.originalname.match(/\.[a-zA-Z0-9]+$/) || [".mp4"])[0];
    const filename = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`;

    try {
      const supabase = getSupabase();
      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

      if (uploadError) {
        console.error("[uploads] Supabase skill-video upload failed:", uploadError.message);
        return res.status(502).json({ error: "Upload failed - try again" });
      }

      const { data } = supabase.storage.from(bucket).getPublicUrl(filename);
      res.status(201).json({ url: data.publicUrl });
    } catch (err) {
      console.error("[uploads] skill-video error:", err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

// Multer errors (file too large, wrong type) land here instead of the
// generic 500 handler, so the app gets a useful message.
router.use((err, req, res, next) => {
  if (err) return res.status(400).json({ error: err.message });
  next();
});

module.exports = router;
