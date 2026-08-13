const mongoose = require("mongoose");

// One row per price change. Written whenever a trade fills or an admin
// changes a price/publishes a market event — see routes/trade.js and
// routes/admin.js. This is what makes sparklines / charts real instead of
// randomly generated: we're recording the company's actual price over time.
const priceHistorySchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true, index: true }, // matches Company.ticker
    price: { type: Number, required: true },
  },
  { timestamps: true }
);

// Fast "give me the last N points for this ticker" queries.
priceHistorySchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("PriceHistory", priceHistorySchema);
