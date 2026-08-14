const express = require("express");
const User = require("../models/User");
const Company = require("../models/Company");

const router = express.Router();

router.get("/", async (_req, res) => {
  try {
    const [users, companies] = await Promise.all([
      User.find().select("username balance holdings startingBalance"),
      Company.find().select("ticker price"),
    ]);
    const priceMap = Object.fromEntries(companies.map((c) => [c.ticker, c.price]));

    const rows = users.map((u) => {
      const portfolioValue = u.holdings.reduce((sum, h) => {
        const price = priceMap[h.companyId] || 0;
        return sum + h.shares * price;
      }, 0);
      const netWorth = u.balance + portfolioValue;
      // Use this user's own recorded starting balance (set at signup from
      // the admin-configurable setting) rather than a fixed constant, so
      // profit % stays correct even for accounts created before/after an
      // admin changes the starting balance for new traders.
      const startingBalance = u.startingBalance || 10000;
      return {
        username: u.username,
        balance: u.balance,
        portfolio_value: portfolioValue,
        net_worth: netWorth,
        profit_pct: ((netWorth - startingBalance) / startingBalance) * 100,
      };
    });

    rows.sort((a, b) => b.net_worth - a.net_worth);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load leaderboard." });
  }
});

module.exports = router;
