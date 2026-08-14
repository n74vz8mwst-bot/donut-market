const express = require("express");
const User = require("../models/User");
const Company = require("../models/Company");
const Trade = require("../models/Trade");
const exchange = require("../services/exchange");
const portfolio = require("../services/portfolio");
const settingsService = require("../services/settings");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// GET /api/portfolio — everything the portfolio page needs in one round trip:
// valuation, positions with P&L, and the account's equity curve.
router.get("/", requireAuth, async (req, res) => {
  try {
    const settings = await settingsService.get();
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "User not found." });

    // Sync the names this trader holds so the valuation uses live prices and
    // any resting order that should have filled by now has.
    const tickers = user.holdings.map((h) => h.companyId);
    const companies = tickers.length
      ? await exchange.loadMarket({ settings, filter: { ticker: { $in: tickers } } })
      : [];

    // Re-read: a resting order may have filled during the sync above.
    const fresh = await User.findById(req.userId);
    const valuation = portfolio.valuate(fresh, companies);
    await portfolio.recordSnapshot(fresh, valuation);

    res.json({
      ...valuation,
      username: fresh.username,
      role: fresh.role,
      starting_balance: fresh.startingBalance,
      trade_count: fresh.tradeCount || 0,
      equity: await portfolio.equityCurve(fresh._id),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load your portfolio." });
  }
});

// GET /api/portfolio/holdings — positions only.
router.get("/holdings", requireAuth, async (req, res) => {
  try {
    const settings = await settingsService.get();
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "User not found." });

    const tickers = user.holdings.map((h) => h.companyId);
    const companies = tickers.length
      ? await exchange.loadMarket({ settings, filter: { ticker: { $in: tickers } } })
      : [];

    res.json(portfolio.valuate(user, companies).positions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load holdings." });
  }
});

// GET /api/portfolio/trades — your fills, newest first.
router.get("/trades", requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 200);
    const trades = await Trade.find({ user: req.userId }).sort({ createdAt: -1 }).limit(limit);
    res.json(
      trades.map((t) => ({
        id: String(t._id),
        type: t.type,
        order_type: t.orderType,
        shares: t.shares,
        price: t.price,
        reference_price: t.referencePrice,
        slippage_pct: t.slippagePct,
        fees: t.fees,
        total: t.total,
        realized_pnl: t.realizedPnl,
        session: t.session,
        created_at: t.createdAt,
        companyId: t.companyId,
        companies: { id: t.companyId, name: t.companyName, icon: t.companyIcon },
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load trade history." });
  }
});

// GET /api/portfolio/equity — the account's net-worth curve.
router.get("/equity", requireAuth, async (req, res) => {
  try {
    res.json(await portfolio.equityCurve(req.userId, parseInt(req.query.limit, 10) || 180));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load your equity curve." });
  }
});

// GET /api/portfolio/watchlist and PUT to change it.
router.get("/watchlist", requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("watchlist");
    if (!user) return res.status(404).json({ error: "User not found." });
    const companies = await Company.find({ ticker: { $in: user.watchlist } }).select("ticker name icon");
    res.json({ tickers: user.watchlist, companies: companies.map((c) => c.toJSON()) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load your watchlist." });
  }
});

router.put("/watchlist/:ticker", requireAuth, async (req, res) => {
  try {
    const ticker = req.params.ticker.toLowerCase();
    const exists = await Company.exists({ ticker });
    if (!exists) return res.status(404).json({ error: "Company not found." });

    const user = await User.findById(req.userId);
    const has = user.watchlist.includes(ticker);
    user.watchlist = has ? user.watchlist.filter((t) => t !== ticker) : [...user.watchlist, ticker];
    await user.save();
    res.json({ tickers: user.watchlist, watching: !has });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update your watchlist." });
  }
});

module.exports = router;
