const express = require("express");
const Company = require("../models/Company");
const User = require("../models/User");
const Order = require("../models/Order");
const Trade = require("../models/Trade");
const Candle = require("../models/Candle");
const MarketEvent = require("../models/MarketEvent");
const Settings = require("../models/Settings");
const cal = require("../engine/calendar");
const price = require("../engine/price");
const exchange = require("../services/exchange");
const market = require("../services/market");
const settingsService = require("../services/settings");
const { requireAdmin } = require("../middleware/auth");

const router = express.Router();

// Every route below is gated by requireAdmin — checked server-side on every
// request. A client-side "isAdmin" flag is a suggestion, not a permission.
router.use(requireAdmin);

const NUMERIC_PARAMS = [
  "annualVol",
  "beta",
  "sectorBeta",
  "drift",
  "meanReversion",
  "jumpsPerYear",
  "jumpVol",
  "adv",
];

function readParams(body) {
  const params = {};
  for (const key of NUMERIC_PARAMS) {
    if (body[key] === "" || body[key] === null) params[key] = null;
    else if (body[key] !== undefined && Number.isFinite(Number(body[key]))) params[key] = Number(body[key]);
  }
  return params;
}

// GET /api/admin/overview — the numbers that tell an admin whether the
// exchange is healthy: economy size, activity, resting order book, halts.
router.get("/overview", async (_req, res) => {
  try {
    const settings = await settingsService.get();
    const companies = await exchange.loadMarket({ settings });
    const [users, trades24h, openOrders, events24h] = await Promise.all([
      User.find().select("balance holdings role createdAt"),
      Trade.countDocuments({ createdAt: { $gte: new Date(Date.now() - 86400000) } }),
      Order.countDocuments({ status: { $in: ["open", "triggered"] } }),
      MarketEvent.countDocuments({ at: { $gte: new Date(Date.now() - 86400000) } }),
    ]);

    const prices = Object.fromEntries(companies.map((c) => [c.ticker, c.price]));
    const totalCoins = users.reduce(
      (sum, u) => sum + u.balance + u.holdings.reduce((h, x) => h + x.shares * (prices[x.companyId] || 0), 0),
      0
    );

    res.json({
      index: market.computeIndex(companies),
      session: cal.sessionAt(Date.now(), settings.marketMode),
      companies: companies.length,
      halted: companies.filter((c) => c.status === "halted").length,
      traders: users.length,
      admins: users.filter((u) => u.role === "admin").length,
      totalCoins,
      trades24h,
      openOrders,
      events24h,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the admin overview." });
  }
});

// POST /api/admin/companies — list a new company.
// A brand-new ticker gets a deterministic backfilled chart so it doesn't open
// as a single flat dot; see engine/price.js#backfill.
router.post("/companies", async (req, res) => {
  try {
    const { id, name, icon, sector, description, liquidity, sharesOutstanding } = req.body;
    const startPrice = Number(req.body.price);

    if (!id || !name || !Number.isFinite(startPrice) || startPrice <= 0) {
      return res.status(400).json({ error: "A ticker, a name and a positive starting price are required." });
    }
    if (!/^[a-z0-9]{1,6}$/i.test(id)) {
      return res.status(400).json({ error: "Tickers are 1–6 letters or digits." });
    }

    const now = Date.now();
    const draft = {
      ticker: id.toLowerCase(),
      name,
      icon: icon || "🍩",
      sector: sector || "General",
      description: description || "",
      price: startPrice,
      openPrice: startPrice,
      listedAt: new Date(now),
      liquidity: Number(liquidity) > 0 ? Number(liquidity) : 5000,
      sharesOutstanding: Number(sharesOutstanding) > 0 ? Number(sharesOutstanding) : 1000000,
      status: "open",
      params: readParams(req.body),
      sim: price.initSim({ price: startPrice }, now),
    };

    const company = await Company.create(draft);

    const bars = price.backfill(company, company.sim, now - 10 * 86400000, now, { barMs: cal.BAR_MS });
    await market.persistBars(company.ticker, bars.slice(-4000), null);

    res.status(201).json(company.toJSON());
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "A company with that ticker already exists." });
    console.error(err);
    res.status(500).json({ error: "Could not create the company." });
  }
});

// PATCH /api/admin/companies/:ticker — edit a listing and its simulation
// parameters (volatility, beta, drift, news intensity, average daily volume).
router.patch("/companies/:ticker", async (req, res) => {
  try {
    const company = await Company.findOne({ ticker: req.params.ticker.toLowerCase() });
    if (!company) return res.status(404).json({ error: "Company not found." });

    for (const field of ["name", "icon", "sector", "description"]) {
      if (req.body[field] !== undefined) company[field] = req.body[field];
    }
    if (Number(req.body.liquidity) > 0) company.liquidity = Number(req.body.liquidity);
    if (Number(req.body.sharesOutstanding) > 0) company.sharesOutstanding = Number(req.body.sharesOutstanding);

    const params = readParams(req.body);
    for (const [key, value] of Object.entries(params)) company.params[key] = value;

    await company.save();
    res.json(company.toJSON());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update the company." });
  }
});

// PATCH /api/admin/companies/:ticker/price — intervene directly.
// This moves fair value with the price, otherwise mean reversion would drag it
// straight back and the intervention would look like a glitch.
router.patch("/companies/:ticker/price", async (req, res) => {
  try {
    const newPrice = Number(req.body.price);
    if (!Number.isFinite(newPrice) || newPrice <= 0) {
      return res.status(400).json({ error: "Price must be a positive number." });
    }

    const settings = await settingsService.get();
    const company = await exchange.loadTicker(req.params.ticker, { settings });
    if (!company) return res.status(404).json({ error: "Company not found." });

    const shift = Math.log(newPrice) - company.sim.logPrice;
    company.sim.logPrice = Math.log(newPrice);
    company.sim.fairLog += shift;
    company.sim.dayHigh = Math.max(company.sim.dayHigh || newPrice, newPrice);
    company.sim.dayLow = Math.min(company.sim.dayLow || newPrice, newPrice);
    company.price = newPrice;
    await company.save();

    await market.persistBars(
      company.ticker,
      [{ t: cal.barStart(Date.now()), o: newPrice, h: newPrice, l: newPrice, c: newPrice, v: 0 }],
      null
    );

    res.json(company.toJSON());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update the price." });
  }
});

// PATCH /api/admin/companies/:ticker/status — halt, resume or delist.
// A halt is a real circuit breaker: quotes freeze and orders are rejected.
router.patch("/companies/:ticker/status", async (req, res) => {
  try {
    const { status } = req.body;
    if (!["open", "halted", "closed"].includes(status)) {
      return res.status(400).json({ error: "Status must be open, halted or closed." });
    }
    const company = await Company.findOne({ ticker: req.params.ticker.toLowerCase() });
    if (!company) return res.status(404).json({ error: "Company not found." });
    await market.ensureSim(company);

    // Resuming from a halt: skip the clock past the halt instead of releasing
    // all the price movement that "would have" happened while it was frozen.
    if (company.status !== "open" && status === "open") {
      company.sim.tick = cal.tickAt(Date.now() - 1);
    }
    company.status = status;
    await company.save();
    res.json(company.toJSON());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not change the company's status." });
  }
});

// Kept for the old admin UI: flips between open and halted.
router.patch("/companies/:ticker/toggle", async (req, res) => {
  try {
    const company = await Company.findOne({ ticker: req.params.ticker.toLowerCase() });
    if (!company) return res.status(404).json({ error: "Company not found." });
    await market.ensureSim(company);
    if (company.status !== "open") company.sim.tick = cal.tickAt(Date.now() - 1);
    company.status = company.status === "open" ? "halted" : "open";
    await company.save();
    res.json(company.toJSON());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not toggle the company's status." });
  }
});

// POST /api/admin/events — publish a headline, optionally with a price shock.
router.post("/events", async (req, res) => {
  try {
    const { headline, companyId } = req.body;
    const impactPct = Number(req.body.impactPct) || 0;
    if (!headline) return res.status(400).json({ error: "A headline is required." });
    if (Math.abs(impactPct) > 90) return res.status(400).json({ error: "Impact must be within ±90%." });

    let company = null;
    if (companyId) {
      const settings = await settingsService.get();
      company = await exchange.loadTicker(companyId, { settings });
      if (!company) return res.status(404).json({ error: "Company not found." });

      if (impactPct) {
        // Shock the price and its fair value together, so the move sticks the
        // way a genuine piece of news would.
        const shift = Math.log(1 + impactPct / 100);
        company.sim.logPrice += shift;
        company.sim.fairLog += shift * 0.6;
        company.price = Math.exp(company.sim.logPrice);
        company.sim.dayHigh = Math.max(company.sim.dayHigh || company.price, company.price);
        company.sim.dayLow = Math.min(company.sim.dayLow || company.price, company.price);
        await company.save();
        await market.persistBars(
          company.ticker,
          [
            {
              t: cal.barStart(Date.now()),
              o: company.price,
              h: company.price,
              l: company.price,
              c: company.price,
              v: 0,
            },
          ],
          null
        );
      }
    }

    const event = await MarketEvent.create({
      headline,
      companyId: company ? company.ticker : null,
      companyName: company ? company.name : null,
      companyIcon: company ? company.icon : null,
      impactPct,
      severity: Math.abs(impactPct) >= 8 ? "major" : Math.abs(impactPct) >= 2.5 ? "moderate" : "minor",
      source: "admin",
      at: new Date(),
    });

    res.status(201).json(event.toJSON());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not publish that event." });
  }
});

router.get("/events", async (_req, res) => {
  try {
    const events = await MarketEvent.find().sort({ at: -1 }).limit(30);
    res.json(events.map((e) => e.toJSON()));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load events." });
  }
});

// GET /api/admin/orders — every resting order on the exchange.
router.get("/orders", async (_req, res) => {
  try {
    const orders = await Order.find({ status: { $in: ["open", "triggered"] } })
      .sort({ createdAt: -1 })
      .limit(100)
      .populate("user", "username")
      .lean();
    res.json(
      orders.map((o) => ({
        id: String(o._id),
        trader: o.user ? o.user.username : "—",
        ticker: o.ticker,
        side: o.side,
        type: o.type,
        qty: o.qty,
        limit_price: o.limitPrice,
        stop_price: o.stopPrice,
        status: o.status,
        created_at: o.createdAt,
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load resting orders." });
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
    // Don't let the last admin demote themselves out of the building.
    if (role === "trader" && String(req.params.id) === String(req.user._id)) {
      const admins = await User.countDocuments({ role: "admin" });
      if (admins <= 1) return res.status(400).json({ error: "You're the only admin — promote someone else first." });
    }
    const user = await User.findByIdAndUpdate(req.params.id, { role }, { returnDocument: "after" });
    if (!user) return res.status(404).json({ error: "User not found." });
    res.json(user.toJSON());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update that role." });
  }
});

// Accepts { balance } to set an exact amount, or { delta } to add/subtract.
// Either way the change is recorded in adminAdjustments so the leaderboard
// keeps measuring trading skill rather than generosity.
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
    if (newBalance < (user.reservedCash || 0)) {
      return res.status(400).json({
        error: `${user.username} has ${user.reservedCash.toFixed(2)} DC committed to resting orders — the balance can't go below that.`,
      });
    }

    user.adminAdjustments = (user.adminAdjustments || 0) + (newBalance - user.balance);
    user.balance = newBalance;
    await user.save();
    res.json(user.toJSON());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update that balance." });
  }
});

// Market-wide configuration: hours, fees and risk limits.
router.get("/settings", async (_req, res) => {
  try {
    const settings = await Settings.getSingleton();
    res.json(settings.toJSON());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load settings." });
  }
});

router.patch("/settings", async (req, res) => {
  try {
    const settings = await Settings.getSingleton();

    const numbers = {
      startingBalance: [0, 1e9],
      commissionBps: [0, 500],
      minCommission: [0, 1000],
      sellFeeBps: [0, 500],
      maxOrderNotional: [1, 1e12],
      maxPositionPct: [1, 100],
    };
    for (const [key, [min, max]] of Object.entries(numbers)) {
      if (req.body[key] === undefined) continue;
      const value = Number(req.body[key]);
      if (!Number.isFinite(value) || value < min || value > max) {
        return res.status(400).json({ error: `${key} must be a number between ${min} and ${max}.` });
      }
      settings[key] = value;
    }
    if (req.body.marketMode !== undefined) {
      if (!["exchange", "24/7"].includes(req.body.marketMode)) {
        return res.status(400).json({ error: "Market mode must be 'exchange' or '24/7'." });
      }
      settings.marketMode = req.body.marketMode;
    }
    if (req.body.allowExtendedHours !== undefined) {
      settings.allowExtendedHours = Boolean(req.body.allowExtendedHours);
    }

    await settings.save();
    settingsService.invalidate();
    res.json(settings.toJSON());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update settings." });
  }
});

// DELETE /api/admin/companies/:ticker/history — wipe a ticker's candles and
// rebuild a fresh backfilled chart. Useful after changing volatility wildly.
router.delete("/companies/:ticker/history", async (req, res) => {
  try {
    const company = await Company.findOne({ ticker: req.params.ticker.toLowerCase() });
    if (!company) return res.status(404).json({ error: "Company not found." });
    await market.ensureSim(company);

    await Candle.deleteMany({ ticker: company.ticker });
    const now = Date.now();
    const bars = price.backfill(company, company.sim, now - 10 * 86400000, now, { barMs: cal.BAR_MS });
    await market.persistBars(company.ticker, bars.slice(-4000), null);

    res.json({ success: true, bars: bars.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not rebuild that history." });
  }
});

module.exports = router;
