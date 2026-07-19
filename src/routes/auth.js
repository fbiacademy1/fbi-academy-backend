const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const prisma = require("../db");
const { requireAuth } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();

async function membershipsFor(userId) {
  const memberships = await prisma.membership.findMany({
    where: { userId },
    include: { team: true },
  });
  return memberships.map((m) => ({
    teamId: m.teamId,
    teamName: m.team.name,
    sport: m.team.sport,
    role: m.role,
    playerId: m.playerId,
  }));
}

// POST /api/auth/login
router.post("/login", asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "email and password required" });

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: "Invalid credentials" });

  // The token only identifies the user - which team they're acting on is
  // sent per-request via the x-team-id header, since one login can span
  // multiple teams.
  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "30d" });
  const memberships = await membershipsFor(user.id);

  res.json({ token, user: { id: user.id, email: user.email }, memberships });
}));

// POST /api/auth/register - creates a bare account with no teams yet.
// A coach then creates a team (POST /api/teams) to become its first member.
router.post("/register", asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "email and password are required" });

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: "Email already registered" });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({ data: { email, passwordHash } });

  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "30d" });
  res.status(201).json({ token, user: { id: user.id, email: user.email }, memberships: [] });
}));

// GET /api/auth/me - refetch current user + memberships (e.g. after creating/joining a team)
router.get("/me", requireAuth, asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
  if (!user) return res.status(404).json({ error: "User not found" });
  const memberships = await membershipsFor(user.id);
  res.json({ user: { id: user.id, email: user.email }, memberships });
}));

module.exports = router;
