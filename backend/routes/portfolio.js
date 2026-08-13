const express = require("express");
const User = require("../models/User");
const Company = require("../models/Company");
const Trade = require("../models/Trade");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Holdings joined with live company data (price, name, icon, status) so the
// portfolio page can show current value + P/L without a second round trip.
router.get("/holdings", requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "User not found." });

    const owned = user.holdings.filter((h) => h.shares > 0);
    const companies = await Company.find({ ticker: { $in: owned.map((h) => h.companyId) } });
    const companyMap = Object.fromEntries(companies.map((c) => [c.ticker, c]));

    const holdings = owned.map((h) => {
      const c = companyMap[h.companyId];
      return {
        companyId: h.companyId,
        shares: h.shares,
        avgPrice: h.avgPrice,
        companies: c
          ? { id: c.ticker, name: c.name, icon: c.icon, price: c.price, sector: c.sector, status: c.status }
          : null,
      };
    });

    res.json(holdings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load holdings." });
  }
});

router.get("/trades", requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const trades = await Trade.find({ user: req.userId }).sort({ createdAt: -1 }).limit(limit);
    res.json(
      trades.map((t) => ({
        id: t._id,
        type: t.type,
        shares: t.shares,
        price: t.price,
        total: t.total,
        created_at: t.createdAt,
        companies: { name: t.companyName, icon: t.companyIcon },
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load trade history." });
  }
});

module.exports = router;
