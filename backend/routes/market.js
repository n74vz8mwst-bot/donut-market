const express = require("express");
const MarketEvent = require("../models/MarketEvent");
const Trade = require("../models/Trade");
const cal = require("../engine/calendar");
const exchange = require("../services/exchange");
const market = require("../services/market");
const settingsService = require("../services/settings");

const router = express.Router();

// GET /api/market/status — is the exchange open, and if not, when does it open?
// Cheap enough for the header to poll on every page.
router.get("/status", async (_req, res) => {
  try {
    const settings = await settingsService.get();
    const now = Date.now();
    const info = cal.sessionAt(now, settings.marketMode);
    res.json({
      at: now,
      session: info.session,
      is_open: info.isOpen,
      mode: settings.marketMode,
      timezone: cal.TZ,
      session_ends: info.segmentEnd,
      next_open: info.isOpen ? null : cal.nextOpen(now, settings.marketMode),
      trading_day: info.dayKey,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load market status." });
  }
});

// GET /api/market/index — the Donut 500, plus its intraday curve.
router.get("/index", async (req, res) => {
  try {
    const settings = await settingsService.get();
    const companies = await exchange.loadMarket({ settings });
    const index = market.computeIndex(companies);
    if (!index) return res.json({ index: null, history: [] });

    const timeframe = market.TIMEFRAMES[req.query.tf] ? req.query.tf : "15m";
    const history = await market.getIndexHistory(companies, timeframe, Number(req.query.limit) || 96);

    res.json({ index, history, session: cal.sessionAt(Date.now(), settings.marketMode) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the index." });
  }
});

// GET /api/market/movers — biggest movers, most active, and the widest spreads.
router.get("/movers", async (_req, res) => {
  try {
    const settings = await settingsService.get();
    const companies = await exchange.loadMarket({ settings });
    const quotes = companies
      .filter((c) => c.status !== "closed")
      .map((c) => market.quoteFor(c, { settings }));

    const byChange = [...quotes].sort((a, b) => b.change_pct - a.change_pct);
    res.json({
      gainers: byChange.slice(0, 5),
      losers: byChange.slice(-5).reverse(),
      active: [...quotes].sort((a, b) => b.day_volume - a.day_volume).slice(0, 5),
      widest: [...quotes].sort((a, b) => b.spreadBps - a.spreadBps).slice(0, 5),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load movers." });
  }
});

// GET /api/market/news — the exchange-wide wire.
router.get("/news", async (req, res) => {
  try {
    // Sync first: news is filed as the simulation produces jumps, so the feed
    // is only current if the market is.
    const settings = await settingsService.get();
    await exchange.loadMarket({ settings });

    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const filter = {};
    if (req.query.severity) filter.severity = req.query.severity;
    if (req.query.ticker) filter.companyId = String(req.query.ticker).toLowerCase();

    const events = await MarketEvent.find(filter).sort({ at: -1 }).limit(limit);
    res.json(events.map((e) => e.toJSON()));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the news wire." });
  }
});

// GET /api/market/trades — the public tape of real player trades.
router.get("/trades", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const trades = await Trade.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("user", "username")
      .lean();

    res.json(
      trades.map((t) => ({
        id: String(t._id),
        trader: t.user ? t.user.username : "—",
        companyId: t.companyId,
        companyName: t.companyName,
        companyIcon: t.companyIcon,
        type: t.type,
        shares: t.shares,
        price: t.price,
        total: t.total,
        created_at: t.createdAt,
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load recent trades." });
  }
});

module.exports = router;
