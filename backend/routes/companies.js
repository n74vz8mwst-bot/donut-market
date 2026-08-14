const express = require("express");
const Company = require("../models/Company");
const PriceHistory = require("../models/PriceHistory");
const { applyDrift } = require("../utils/marketDrift");

const router = express.Router();

router.get("/", async (_req, res) => {
  try {
    const companies = await Company.find().sort({ name: 1 });
    // Catch each company up on any ambient drift it's earned since it was
    // last read — see backend/utils/marketDrift.js.
    await Promise.all(companies.map((c) => applyDrift(c)));
    res.json(companies.map((c) => c.toJSON()));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load companies." });
  }
});

// Bulk sparkline data for every listed company in one round trip, e.g.
// { dnut: [250.4, 251.1, ...], glz: [118.75, ...] }. Real recorded prices
// only — no generated/random points. A ticker with no trades yet returns a
// single-point array (its listing price), which the frontend renders as a
// flat line rather than inventing movement that never happened.
router.get("/history/all", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 200);
    const companies = await Company.find().select("ticker price liquidity openPrice status lastTickAt createdAt");
    // Catch up ambient drift first so the sparkline's latest point matches
    // what GET /api/companies would report right now.
    await Promise.all(companies.map((c) => applyDrift(c)));

    const results = await Promise.all(
      companies.map(async (c) => {
        const points = await PriceHistory.find({ companyId: c.ticker })
          .sort({ createdAt: -1 })
          .limit(limit)
          .select("price -_id");
        const prices = points.map((p) => p.price).reverse();
        return [c.ticker, prices.length ? prices : [c.price]];
      })
    );

    res.json(Object.fromEntries(results));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load price history." });
  }
});

router.get("/:ticker", async (req, res) => {
  try {
    const company = await Company.findOne({ ticker: req.params.ticker.toLowerCase() });
    if (!company) return res.status(404).json({ error: "Company not found." });
    await applyDrift(company);
    res.json(company.toJSON());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load company." });
  }
});

router.get("/:ticker/history", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const points = await PriceHistory.find({ companyId: req.params.ticker.toLowerCase() })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select("price createdAt -_id");
    res.json(points.reverse());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load price history." });
  }
});

module.exports = router;
