const express = require("express");
const Company = require("../models/Company");
const User = require("../models/User");
const MarketEvent = require("../models/MarketEvent");
const PriceHistory = require("../models/PriceHistory");
const Settings = require("../models/Settings");
const { requireAdmin } = require("../middleware/auth");

const router = express.Router();

// Every route below is gated by requireAdmin — checked server-side on every
// request, never trust a client-side "isAdmin" flag alone.
router.use(requireAdmin);

router.post("/companies", async (req, res) => {
  try {
    const { id, name, icon, sector, price, liquidity } = req.body;
    if (!id || !name || !price) {
      return res.status(400).json({ error: "id, name, and price are required." });
    }
    const company = await Company.create({
      ticker: id.toLowerCase(),
      name,
      icon: icon || "🍩",
      sector: sector || "General",
      price,
      openPrice: price,
      liquidity: liquidity || 5000,
      status: "open",
    });
    await PriceHistory.create({ companyId: company.ticker, price: company.price });
    res.status(201).json(company.toJSON());
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "A company with that ticker already exists." });
    console.error(err);
    res.status(500).json({ error: "Could not create company." });
  }
});

router.patch("/companies/:ticker/price", async (req, res) => {
  try {
    const { price } = req.body;
    if (!price || price <= 0) return res.status(400).json({ error: "Price must be positive." });
    const company = await Company.findOneAndUpdate(
      { ticker: req.params.ticker.toLowerCase() },
      { price },
      { new: true }
    );
    if (!company) return res.status(404).json({ error: "Company not found." });
    await PriceHistory.create({ companyId: company.ticker, price: company.price });
    res.json(company.toJSON());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update price." });
  }
});

router.patch("/companies/:ticker/toggle", async (req, res) => {
  try {
    const company = await Company.findOne({ ticker: req.params.ticker.toLowerCase() });
    if (!company) return res.status(404).json({ error: "Company not found." });
    company.status = company.status === "open" ? "closed" : "open";
    await company.save();
    res.json(company.toJSON());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not toggle status." });
  }
});

router.post("/events", async (req, res) => {
  try {
    const { headline, companyId, impactPct } = req.body;
    if (!headline) return res.status(400).json({ error: "Headline is required." });

    const event = await MarketEvent.create({
      headline,
      companyId: companyId || null,
      impactPct: impactPct || 0,
    });

    if (companyId && impactPct) {
      const company = await Company.findOne({ ticker: companyId.toLowerCase() });
      if (company) {
        company.price = Math.max(company.price * (1 + impactPct / 100), 0.01);
        await company.save();
        await PriceHistory.create({ companyId: company.ticker, price: company.price });
      }
    }

    res.status(201).json(event);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not publish event." });
  }
});

router.get("/events", async (_req, res) => {
  try {
    const events = await MarketEvent.find().sort({ createdAt: -1 }).limit(20);
    res.json(events);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load events." });
  }
});

router.get("/users", async (_req, res) => {
  try {
    const users = await User.find().select("-holdings").sort({ balance: -1 });
    res.json(users.map((u) => u.toJSON()));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load users." });
  }
});

router.patch("/users/:id/role", async (req, res) => {
  try {
    const { role } = req.body;
    if (!["trader", "admin"].includes(role)) {
      return res.status(400).json({ error: "Role must be trader or admin." });
    }
    const user = await User.findByIdAndUpdate(req.params.id, { role }, { new: true });
    if (!user) return res.status(404).json({ error: "User not found." });
    res.json(user.toJSON());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update role." });
  }
});

// Accepts either { balance } to set an exact new balance, or { delta } to
// add/subtract from the current one (e.g. delta: 500 or delta: -200).
// Exactly one of the two is required. Balance can never go negative.
router.patch("/users/:id/balance", async (req, res) => {
  try {
    const { balance, delta } = req.body;
    const hasBalance = balance !== undefined && balance !== null;
    const hasDelta = delta !== undefined && delta !== null;

    if (hasBalance === hasDelta) {
      return res.status(400).json({ error: "Provide exactly one of balance or delta." });
    }
    if (hasBalance && (typeof balance !== "number" || balance < 0)) {
      return res.status(400).json({ error: "Balance must be a non-negative number." });
    }
    if (hasDelta && typeof delta !== "number") {
      return res.status(400).json({ error: "Delta must be a number." });
    }

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found." });

    const newBalance = hasBalance ? balance : user.balance + delta;
    if (newBalance < 0) {
      return res.status(400).json({ error: `That would take ${user.username}'s balance below 0 DC.` });
    }

    user.balance = newBalance;
    await user.save();
    res.json(user.toJSON());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update balance." });
  }
});

// Market-wide settings — currently just the starting balance handed to new
// traders on signup. See models/Settings.js and routes/auth.js.
router.get("/settings", async (_req, res) => {
  try {
    const settings = await Settings.getSingleton();
    res.json({ startingBalance: settings.startingBalance });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load settings." });
  }
});

router.patch("/settings", async (req, res) => {
  try {
    const { startingBalance } = req.body;
    if (typeof startingBalance !== "number" || startingBalance < 0) {
      return res.status(400).json({ error: "Starting balance must be a non-negative number." });
    }
    const settings = await Settings.getSingleton();
    settings.startingBalance = startingBalance;
    await settings.save();
    res.json({ startingBalance: settings.startingBalance });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update settings." });
  }
});

module.exports = router;
