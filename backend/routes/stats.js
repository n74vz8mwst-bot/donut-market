const express = require("express");
const User = require("../models/User");
const Company = require("../models/Company");
const Trade = require("../models/Trade");

const router = express.Router();

// Real homepage market statistics — every number here comes from an actual
// query against MongoDB, no hardcoded/demo values. Replaces the static
// data-counter attributes that used to live directly in index.html.
router.get("/", async (_req, res) => {
  try {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const startOfYesterday = new Date(startOfToday);
    startOfYesterday.setDate(startOfYesterday.getDate() - 1);
    const startOfWeek = new Date(now);
    startOfWeek.setDate(startOfWeek.getDate() - 7);
    const startOfMonth = new Date(now);
    startOfMonth.setDate(startOfMonth.getDate() - 30);

    const [users, companies, tradesToday, tradesYesterday, newCompaniesThisMonth, newUsersToday, activeTraderIds] =
      await Promise.all([
        User.find().select("balance holdings"),
        Company.find().select("ticker price createdAt"),
        Trade.countDocuments({ createdAt: { $gte: startOfToday } }),
        Trade.countDocuments({ createdAt: { $gte: startOfYesterday, $lt: startOfToday } }),
        Company.countDocuments({ createdAt: { $gte: startOfMonth } }),
        User.countDocuments({ createdAt: { $gte: startOfToday } }),
        Trade.distinct("user", { createdAt: { $gte: startOfWeek } }),
      ]);

    const priceMap = Object.fromEntries(companies.map((c) => [c.ticker, c.price]));

    // Total Donut Coins in the economy: every user's cash balance plus the
    // live market value of everything they hold.
    const totalCoins = users.reduce((sum, u) => {
      const holdingsValue = u.holdings.reduce((hSum, h) => hSum + h.shares * (priceMap[h.companyId] || 0), 0);
      return sum + u.balance + holdingsValue;
    }, 0);

    const tradesDeltaPct =
      tradesYesterday > 0 ? ((tradesToday - tradesYesterday) / tradesYesterday) * 100 : null;

    res.json({
      totalCoins,
      companiesListed: companies.length,
      newCompaniesThisMonth,
      registeredTraders: users.length,
      activeTraders: activeTraderIds.length,
      newUsersToday,
      tradesToday,
      tradesDeltaPct,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load market statistics." });
  }
});

module.exports = router;
