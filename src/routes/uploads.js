const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const { requireAuth } = require("../middleware/auth");
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

// Multer errors (file too large, wrong type) land here instead of the
// generic 500 handler, so the app gets a useful message.
router.use((err, req, res, next) => {
  if (err) return res.status(400).json({ error: err.message });
  next();
});

module.exports = router;
