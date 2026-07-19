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

// Centralized error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`TeamSync backend listening on port ${PORT}`));
