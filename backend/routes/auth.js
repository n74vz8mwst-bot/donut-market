const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const settingsService = require("../services/settings");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const USERNAME_RE = /^[a-zA-Z0-9_]{3,18}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

function signToken(user) {
  return jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET, { expiresIn: "30d" });
}

router.post("/signup", async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: "Username, email, and password are all required." });
    }
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: "Usernames are 3–18 characters, letters, numbers and underscores only." });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: "That doesn't look like an email address." });
    }
    if (password.length < MIN_PASSWORD) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
    }

    const existing = await User.findOne({
      $or: [{ email: email.toLowerCase() }, { username: new RegExp(`^${username}$`, "i") }],
    });
    if (existing) {
      return res.status(409).json({ error: "That username or email is already taken." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const { startingBalance } = await settingsService.get();
    const user = await User.create({
      username,
      email,
      passwordHash,
      balance: startingBalance,
      startingBalance,
    });

    res.status(201).json({ token: signToken(user), ...user.toJSON() });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "That username or email is already taken." });
    console.error(err);
    res.status(500).json({ error: "Could not create your account." });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const user = await User.findOne({ email: String(email).toLowerCase() });
    // Same message either way — telling an attacker which half was wrong is
    // free information.
    const match = user ? await bcrypt.compare(password, user.passwordHash) : false;
    if (!user || !match) {
      return res.status(401).json({ error: "Incorrect email or password." });
    }

    user.lastSeenAt = new Date();
    await user.save();

    res.json({ token: signToken(user), ...user.toJSON() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not log you in." });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.userId,
      { lastSeenAt: new Date() },
      { returnDocument: "after" }
    );
    if (!user) return res.status(404).json({ error: "User not found." });
    res.json(user.toJSON());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load your account." });
  }
});

module.exports = router;
