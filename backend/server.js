const express = require("express");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const cors = require("cors");
const path = require("path");

const { optionalAuth } = require("./middleware/auth");
const authRoutes = require("./routes/auth");
const companyRoutes = require("./routes/companies");
const tradeRoutes = require("./routes/trade");
const portfolioRoutes = require("./routes/portfolio");
const leaderboardRoutes = require("./routes/leaderboard");
const adminRoutes = require("./routes/admin");
const statsRoutes = require("./routes/stats");

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(optionalAuth); // reads the Bearer token (if any) into req.userId on every request

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
app.use("/api/auth", authRoutes);
app.use("/api/companies", companyRoutes);
app.use("/api/trade", tradeRoutes);
app.use("/api/portfolio", portfolioRoutes);
app.use("/api/leaderboard", leaderboardRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/stats", statsRoutes);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, message: "🍩 Donut Market API is running." });
});

// ---------------------------------------------------------------------------
// Serve the static frontend (index.html, css/, js/, pages/) from the project
// root one level up from /backend — this lets a single free host (Render,
// Railway, etc.) serve both the site and the API with no separate deploy.
// ---------------------------------------------------------------------------
const frontendRoot = path.join(__dirname, "..");
app.use(express.static(frontendRoot));

// Any non-API route that doesn't match a static file falls back to index.html
// isn't needed here since every page is a real .html file (multi-page site,
// not a single-page app) — Express's static middleware already serves them
// directly at /, /pages/market.html, etc.

const PORT = process.env.PORT || 3000;

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("✅ Connected to MongoDB.");
    app.listen(PORT, () => {
      console.log(`🚀 Donut Market running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("❌ Failed to connect to MongoDB:", err.message);
    process.exit(1);
  });
