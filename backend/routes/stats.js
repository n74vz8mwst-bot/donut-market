const express = require("express");
const User = require("../models/User");
const Trade = require("../models/Trade");
const Order = require("../models/Order");
const cal = require("../engine/calendar");
const exchange = require("../services/exchange");
const market = require("../services/market");
const settingsService = require("../services/settings");

const router = express.Router();

// GET /api/stats — the homepage numbers. Every one of them is a real query
// against the database; nothing here is a decorative constant.
router.get("/", async (_req, res) => {
  try {
    const settings = await settingsService.get();
    const companies = await exchange.loadMarket({ settings });

    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const startOfYesterday = new Date(startOfToday);
    startOfYesterday.setDate(startOfYesterday.getDate() - 1);
    const startOfWeek = new Date(now.getTime() - 7 * 86400000);
    const startOfMonth = new Date(now.getTime() - 30 * 86400000);

    const [users, tradesToday, tradesYesterday, newUsersToday, activeTraderIds, restingOrders, volumeToday] =
      await Promise.all([
        User.find().select("balance holdings createdAt"),
        Trade.countDocuments({ createdAt: { $gte: startOfToday } }),
        Trade.countDocuments({ createdAt: { $gte: startOfYesterday, $lt: startOfToday } }),
        User.countDocuments({ createdAt: { $gte: startOfToday } }),
        Trade.distinct("user", { createdAt: { $gte: startOfWeek } }),
        Order.countDocuments({ status: { $in: ["open", "triggered"] } }),
        Trade.aggregate([
          { $match: { createdAt: { $gte: startOfToday } } },
          { $group: { _id: null, notional: { $sum: "$total" }, shares: { $sum: "$shares" } } },
        ]),
      ]);

    const priceMap = Object.fromEntries(companies.map((c) => [c.ticker, c.price]));

    // Total Donut Coins in the economy: every trader's cash plus the live
    // market value of everything they hold.
    const totalCoins = users.reduce((sum, u) => {
      const held = u.holdings.reduce((h, holding) => h + holding.shares * (priceMap[holding.companyId] || 0), 0);
      return sum + u.balance + held;
    }, 0);

    const index = market.computeIndex(companies);
    const session = cal.sessionAt(Date.now(), settings.marketMode);
    const newCompaniesThisMonth = companies.filter((c) => c.listedAt >= startOfMonth).length;

    res.json({
      totalCoins,
      companiesListed: companies.length,
      newCompaniesThisMonth,
      registeredTraders: users.length,
      activeTraders: activeTraderIds.length,
      newUsersToday,
      tradesToday,
      tradesDeltaPct: tradesYesterday > 0 ? ((tradesToday - tradesYesterday) / tradesYesterday) * 100 : null,
      volumeToday: volumeToday[0]?.notional || 0,
      sharesTradedToday: volumeToday[0]?.shares || 0,
      restingOrders,
      totalMarketCap: companies.reduce((sum, c) => sum + c.price * c.sharesOutstanding, 0),
      index,
      session: session.session,
      isOpen: session.isOpen,
      nextOpen: session.isOpen ? null : cal.nextOpen(Date.now(), settings.marketMode),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load market statistics." });
  }
});

module.exports = router;
