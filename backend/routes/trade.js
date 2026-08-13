const express = require("express");
const mongoose = require("mongoose");
const Company = require("../models/Company");
const User = require("../models/User");
const Trade = require("../models/Trade");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Per-trade price impact is capped so no single order can send a price to
// the moon or to zero in one shot — real markets have depth, so do we.
const MAX_IMPACT_PER_TRADE = 0.25;

router.post("/", requireAuth, async (req, res) => {
  const { companyId, type, shares } = req.body;

  if (!companyId || !["buy", "sell"].includes(type)) {
    return res.status(400).json({ error: "companyId and a valid type (buy/sell) are required." });
  }
  const shareCount = Number(shares);
  if (!shareCount || shareCount <= 0) {
    return res.status(400).json({ error: "Shares must be a positive number." });
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const company = await Company.findOne({ ticker: companyId.toLowerCase() }).session(session);
      if (!company) throw Object.assign(new Error("Company not found."), { status: 404 });
      if (company.status !== "open") {
        throw Object.assign(new Error(`${company.name} is currently closed for trading.`), { status: 400 });
      }

      const user = await User.findById(req.userId).session(session);
      if (!user) throw Object.assign(new Error("User not found."), { status: 404 });

      const fillPrice = company.price;
      const total = fillPrice * shareCount;
      const impact = Math.min(shareCount / company.liquidity, MAX_IMPACT_PER_TRADE);

      let holding = user.holdings.find((h) => h.companyId === company.ticker);

      if (type === "buy") {
        if (user.balance < total) {
          throw Object.assign(
            new Error(`Insufficient balance: need ${total.toFixed(2)} DC, have ${user.balance.toFixed(2)} DC.`),
            { status: 400 }
          );
        }
        user.balance -= total;

        if (holding) {
          const newShares = holding.shares + shareCount;
          holding.avgPrice = (holding.shares * holding.avgPrice + total) / newShares;
          holding.shares = newShares;
        } else {
          user.holdings.push({ companyId: company.ticker, shares: shareCount, avgPrice: fillPrice });
        }

        company.price = fillPrice * (1 + impact);
      } else {
        if (!holding || holding.shares < shareCount) {
          throw Object.assign(
            new Error(`You only hold ${holding ? holding.shares : 0} shares of ${company.name}.`),
            { status: 400 }
          );
        }
        holding.shares -= shareCount;
        user.balance += total;
        company.price = Math.max(fillPrice * (1 - impact), 0.01);
      }

      await company.save({ session });
      await user.save({ session });
      await Trade.create(
        [
          {
            user: user._id,
            companyId: company.ticker,
            companyName: company.name,
            companyIcon: company.icon,
            type,
            shares: shareCount,
            price: fillPrice,
            total,
          },
        ],
        { session }
      );

      result = {
        success: true,
        type,
        shares: shareCount,
        fill_price: fillPrice,
        total,
        new_price: company.price,
        balance: user.balance,
      };
    });

    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: err.message || "Trade failed." });
  } finally {
    session.endSession();
  }
});

module.exports = router;
