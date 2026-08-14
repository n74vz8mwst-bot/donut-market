const express = require("express");
const User = require("../models/User");
const exchange = require("../services/exchange");
const portfolio = require("../services/portfolio");
const settingsService = require("../services/settings");

const router = express.Router();

// GET /api/leaderboard
// Ranked by net worth, but the row carries enough to judge *how* someone got
// there: today's move, realised versus unrealised profit, fees paid and how
// many trades it took. Return is measured against starting balance plus any
// admin top-ups, so handouts don't read as skill.
router.get("/", async (req, res) => {
  try {
    const settings = await settingsService.get();
    const companies = await exchange.loadMarket({ settings });
    const users = await User.find().select(
      "username balance reservedCash holdings startingBalance adminAdjustments realizedPnl feesPaid tradeCount createdAt"
    );

    const rows = users.map((user) => {
      const v = portfolio.valuate(user, companies);
      const best = v.positions[0];
      return {
        username: user.username,
        balance: v.cash,
        portfolio_value: v.positionsValue,
        net_worth: v.netWorth,
        profit: v.totalReturn,
        profit_pct: v.totalReturnPct,
        day_change: v.dayChange,
        day_change_pct: v.dayChangePct,
        realized_pnl: v.realizedPnl,
        unrealized_pnl: v.unrealizedPnl,
        fees_paid: v.feesPaid,
        trades: user.tradeCount || 0,
        positions: v.positions.length,
        top_holding: best ? { id: best.companyId, icon: best.icon, weight_pct: best.weightPct } : null,
        joined: user.createdAt,
      };
    });

    rows.sort((a, b) => b.net_worth - a.net_worth);
    rows.forEach((row, i) => {
      row.rank = i + 1;
    });

    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    res.json(rows.slice(0, limit));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the leaderboard." });
  }
});

module.exports = router;
