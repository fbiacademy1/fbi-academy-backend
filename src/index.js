require("dotenv").config();
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth");
const teamRoutes = require("./routes/teams");
const playerRoutes = require("./routes/players");
const eventRoutes = require("./routes/events");
const rsvpRoutes = require("./routes/rsvp");
const messageRoutes = require("./routes/messages");
const directMessageRoutes = require("./routes/directMessages");
const syncRoutes = require("./routes/sync");
const uploadRoutes = require("./routes/uploads");
const trainingSessionRoutes = require("./routes/trainingSessions");
const trainingVideoRoutes = require("./routes/trainingVideos");
const personalTrainingRoutes = require("./routes/personalTraining");
const skillVideoRoutes = require("./routes/skillVideos");

const app = express();
app.use(cors());
app.use(express.json());

// Simple request logger so it's obvious in the terminal whether a request
// from the app actually reached the backend.
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/teams", teamRoutes);
app.use("/api/players", playerRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/rsvp", rsvpRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/direct-messages", directMessageRoutes);
app.use("/api/sync", syncRoutes);
app.use("/api/uploads", uploadRoutes);
app.use("/api/training-sessions", trainingSessionRoutes);
app.use("/api/training-videos", trainingVideoRoutes);
app.use("/api/personal-training", personalTrainingRoutes);
app.use("/api/skill-videos", skillVideoRoutes);

// Centralized error handler. Respects err.statusCode/err.message when a
// route deliberately threw a typed error (e.g. auth.js's login route for a
// WordPress-unreachable condition) so the client gets something more useful
// than a bare 500 - falls back to the old generic 500 for anything else.
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.statusCode || 500;
  res.status(status).json({ error: status === 500 ? "Internal server error" : err.message });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`TeamSync backend listening on port ${PORT}`));
