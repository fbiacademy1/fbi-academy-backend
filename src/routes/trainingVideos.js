const express = require("express");
const prisma = require("../db");
const { requireAuth, requireTeamMembership, requireRole } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();
router.use(requireAuth, requireTeamMembership);

// GET /api/training-videos - the current team's shared drill library.
// Visible to everyone on the team (players need to browse it to train
// against it), ordered newest-first.
router.get("/", asyncHandler(async (req, res) => {
  const videos = await prisma.trainingVideo.findMany({
    where: { teamId: req.membership.teamId },
    orderBy: [{ weekOf: "desc" }, { createdAt: "desc" }],
  });
  res.json(videos);
}));

// POST /api/training-videos  (admin/coach only)
// Body: { title, description?, category?, difficulty?, videoUrl, weekOf? }
// videoUrl is expected to already be a Supabase Storage URL returned by
// POST /api/uploads/video - this endpoint just records the metadata.
router.post("/", requireRole("admin", "coach"), asyncHandler(async (req, res) => {
  const { title, description, category, difficulty, videoUrl, weekOf } = req.body;
  if (!title || !videoUrl) {
    return res.status(400).json({ error: "title and videoUrl are required" });
  }

  const video = await prisma.trainingVideo.create({
    data: {
      teamId: req.membership.teamId,
      title,
      description: description || undefined,
      category: category || undefined,
      difficulty: difficulty || undefined,
      videoUrl,
      weekOf: weekOf ? new Date(weekOf) : undefined,
      uploadedByMembershipId: req.membership.id,
    },
  });
  res.status(201).json(video);
}));

// PUT /api/training-videos/:id  (admin/coach only) - edit metadata (not the file itself).
router.put("/:id", requireRole("admin", "coach"), asyncHandler(async (req, res) => {
  const video = await prisma.trainingVideo.findUnique({ where: { id: req.params.id } });
  if (!video || video.teamId !== req.membership.teamId) {
    return res.status(404).json({ error: "Training video not found" });
  }

  const { title, description, category, difficulty, weekOf, position } = req.body;
  const updated = await prisma.trainingVideo.update({
    where: { id: video.id },
    data: {
      title: title !== undefined ? title : undefined,
      description: description !== undefined ? description : undefined,
      category: category !== undefined ? category : undefined,
      difficulty: difficulty !== undefined ? difficulty : undefined,
      weekOf: weekOf !== undefined ? (weekOf ? new Date(weekOf) : null) : undefined,
      position: position !== undefined ? Number(position) : undefined,
    },
  });
  res.json(updated);
}));

// DELETE /api/training-videos/:id  (admin/coach only). Any training logs
// that referenced this video keep their minutes - they just lose the
// back-reference (trainingVideoId is ON DELETE SET NULL).
router.delete("/:id", requireRole("admin", "coach"), asyncHandler(async (req, res) => {
  const video = await prisma.trainingVideo.findUnique({ where: { id: req.params.id } });
  if (!video || video.teamId !== req.membership.teamId) {
    return res.status(404).json({ error: "Training video not found" });
  }
  await prisma.trainingVideo.delete({ where: { id: video.id } });
  res.status(204).end();
}));

module.exports = router;
