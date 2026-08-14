const express = require("express");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const cors = require("cors");
const path = require("path");

const { optionalAuth } = require("./middleware/auth");
const { detectTransactionSupport } = require("./services/db");

const authRoutes = require("./routes/auth");
const companyRoutes = require("./routes/companies");
const orderRoutes = require("./routes/orders");
const portfolioRoutes = require("./routes/portfolio");
const leaderboardRoutes = require("./routes/leaderboard");
const adminRoutes = require("./routes/admin");
const statsRoutes = require("./routes/stats");
const marketRoutes = require("./routes/market");

dotenv.config();

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);

// Conservative security headers. Everything the frontend loads is same-origin
// apart from the Google Fonts stylesheet, so the policy can stay tight without
// reaching for another dependency.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      // Every script is an external file under /js — no inline scripts, so the
      // policy can stay strict here. Inline *styles* are still used for a few
      // one-off layout tweaks in the markup, hence the exception below.
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'self'",
    ].join("; ")
  );
  next();
});

app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(optionalAuth); // reads the Bearer token (if any) into req.userId

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
app.use("/api/auth", authRoutes);
app.use("/api/companies", companyRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/portfolio", portfolioRoutes);
app.use("/api/leaderboard", leaderboardRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/stats", statsRoutes);
app.use("/api/market", marketRoutes);

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    message: "🍩 Donut Market API is running.",
    db: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    uptime_s: Math.round(process.uptime()),
  });
});

// An unmatched /api/* path should be a JSON 404, not the homepage.
app.use("/api", (_req, res) => res.status(404).json({ error: "No such endpoint." }));

// ---------------------------------------------------------------------------
// Static frontend, served from the project root one level up. One free host
// runs the whole site — pages, assets and API together.
// ---------------------------------------------------------------------------
const frontendRoot = path.join(__dirname, "..");
app.use(
  express.static(frontendRoot, {
    extensions: ["html"],
    setHeaders(res, filePath) {
      // HTML is re-fetched every time; hashed-free assets get a short cache so
      // an edit shows up on refresh instead of hours later.
      res.setHeader("Cache-Control", filePath.endsWith(".html") ? "no-cache" : "public, max-age=300");
    },
  })
);

// Anything else that isn't a real file: send the homepage.
app.use((_req, res) => res.sendFile(path.join(frontendRoot, "index.html")));

// Last-resort error handler, so a thrown error is JSON rather than an HTML
// stack trace leaking file paths to the browser.
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(err.status || 500).json({ error: "Something went wrong on the exchange." });
});

const PORT = process.env.PORT || 3000;

async function start() {
  if (!process.env.MONGODB_URI) {
    console.error(
      "❌ MONGODB_URI is not set.\n" +
        "   Either fill it in (see SETUP.md), or run `npm run dev:memory` to start\n" +
        "   Donut Market with a throwaway in-memory database and no setup at all."
    );
    process.exit(1);
  }
  if (!process.env.JWT_SECRET) {
    console.error("❌ JWT_SECRET is not set — logins can't be signed. See SETUP.md.");
    process.exit(1);
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
    console.log("✅ Connected to MongoDB.");
    await detectTransactionSupport();

    const server = app.listen(PORT, () => {
      console.log(`🚀 Donut Market running on http://localhost:${PORT}`);
    });

    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => {
        console.log(`\n${signal} received — shutting down.`);
        server.close(() => mongoose.disconnect().then(() => process.exit(0)));
      });
    }
  } catch (err) {
    console.error("❌ Failed to connect to MongoDB:", err.message);
    process.exit(1);
  }
}

// Exported so scripts/dev-memory.js can boot the same app against a temporary
// database without duplicating any of this.
module.exports = { app, start };

if (require.main === module) start();
