const express = require("express");
const User = require("../models/User");
const Company = require("../models/Company");

const router = express.Router();

const STARTING_BALANCE = 10000;

router.get("/", async (_req, res) => {
  try {
    const [users, companies] = await Promise.all([
      User.find().select("username balance holdings"),
      Company.find().select("ticker price"),
    ]);
    const priceMap = Object.fromEntries(companies.map((c) => [c.ticker, c.price]));

    const rows = users.map((u) => {
      const portfolioValue = u.holdings.reduce((sum, h) => {
        const price = priceMap[h.companyId] || 0;
        return sum + h.shares * price;
      }, 0);
      const netWorth = u.balance + portfolioValue;
      return {
        username: u.username,
        balance: u.balance,
        portfolio_value: portfolioValue,
        net_worth: netWorth,
        profit_pct: ((netWorth - STARTING_BALANCE) / STARTING_BALANCE) * 100,
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
