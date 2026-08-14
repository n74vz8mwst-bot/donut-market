const express = require("express");
const Company = require("../models/Company");
const MarketEvent = require("../models/MarketEvent");
const exchange = require("../services/exchange");
const market = require("../services/market");
const settingsService = require("../services/settings");

const router = express.Router();

// Every endpoint here syncs before it answers — see services/exchange.js.
// That's what keeps the market ticking without a background worker.

// GET /api/companies — the whole board: quotes, day stats and sparklines.
router.get("/", async (req, res) => {
  try {
    const settings = await settingsService.get();
    const companies = await exchange.loadMarket({ settings });
    const quotes = companies.map((c) => market.quoteFor(c, { settings }));

    let sparklines = {};
    if (req.query.sparkline !== "0") {
      sparklines = await market.getSparklines(companies.map((c) => c.ticker));
    }

    res.json(
      quotes.map((q) => ({
        ...q,
        id: q.ticker,
        sparkline: sparklines[q.ticker] || [q.price],
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the market." });
  }
});

// GET /api/companies/quotes?tickers=dnut,glz — the polling endpoint the live
// pages hit every few seconds. Same data as the list, minus the history.
router.get("/quotes", async (req, res) => {
  try {
    const settings = await settingsService.get();
    const requested = String(req.query.tickers || "")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 50);

    const filter = requested.length ? { ticker: { $in: requested } } : {};
    const companies = await exchange.loadMarket({ settings, filter });

    res.json({
      at: Date.now(),
      quotes: companies.map((c) => market.quoteFor(c, { settings })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load quotes." });
  }
});

// GET /api/companies/:ticker — full detail for the trading terminal.
router.get("/:ticker", async (req, res) => {
  try {
    const settings = await settingsService.get();
    const company = await exchange.loadTicker(req.params.ticker, { settings });
    if (!company) return res.status(404).json({ error: "Company not found." });

    const quote = market.quoteFor(company, { settings });
    const params = market.paramsFor(company);

    res.json({
      ...company.toJSON(),
      quote,
      fundamentals: {
        market_cap: company.price * company.sharesOutstanding,
        shares_outstanding: company.sharesOutstanding,
        listed_at: company.listedAt,
        annual_vol_pct: quote.annual_vol_pct,
        beta: params.beta,
        adv: params.adv,
        liquidity: company.liquidity,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load company." });
  }
});

// GET /api/companies/:ticker/candles?tf=5m&limit=240
router.get("/:ticker/candles", async (req, res) => {
  try {
    const settings = await settingsService.get();
    const company = await exchange.loadTicker(req.params.ticker, { settings });
    if (!company) return res.status(404).json({ error: "Company not found." });

    const timeframe = market.TIMEFRAMES[req.query.tf] ? req.query.tf : "5m";
    const candles = await market.getCandles(company.ticker, timeframe, req.query.limit);

    res.json({
      ticker: company.ticker,
      timeframe,
      candles,
      last: company.price,
      prev_close: company.sim?.prevClose || company.openPrice,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load price history." });
  }
});

// GET /api/companies/:ticker/news — the stories behind this ticker's jumps.
router.get("/:ticker/news", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 15, 50);
    const events = await MarketEvent.find({ companyId: req.params.ticker.toLowerCase() })
      .sort({ at: -1 })
      .limit(limit);
    res.json(events.map((e) => e.toJSON()));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load news." });
  }
});

// GET /api/companies/:ticker/tape — recent prints (time and sales).
router.get("/:ticker/tape", async (req, res) => {
  try {
    const settings = await settingsService.get();
    const company = await Company.findOne({ ticker: req.params.ticker.toLowerCase() });
    if (!company) return res.status(404).json({ error: "Company not found." });
    const quote = market.quoteFor(company, { settings });
    res.json({ ticker: company.ticker, prints: quote.prints });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the tape." });
  }
});

module.exports = router;
