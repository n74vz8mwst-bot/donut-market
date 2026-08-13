const jwt = require("jsonwebtoken");
const User = require("../models/User");

// Attaches req.userId when a valid token is present. Does NOT block the
// request if there's no token — routes that require login call
// requireAuth() explicitly, so public routes (GET /companies, leaderboard)
// can still use this to optionally know who's asking.
function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token) {
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      req.userId = payload.sub;
    } catch (err) {
      // invalid/expired token — treat as logged out rather than erroring
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.userId) {
    return res.status(401).json({ error: "You must be logged in." });
  }
  next();
}

async function requireAdmin(req, res, next) {
  if (!req.userId) {
    return res.status(401).json({ error: "You must be logged in." });
  }
  const user = await User.findById(req.userId);
  if (!user || user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required." });
  }
  req.user = user;
  next();
}

module.exports = { optionalAuth, requireAuth, requireAdmin };
