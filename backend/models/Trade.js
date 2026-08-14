const mongoose = require("mongoose");

// An execution. One order can only produce one of these here (Donut Market
// fills in full or not at all), but the record is kept fill-shaped so partial
// fills would slot in later without a migration.
//
// Note what's stored alongside the price: the quote at the moment of the fill,
// the slippage paid against it, and the fees. That's what lets the portfolio
// page show what an order actually cost versus what the screen said it would.
const tradeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
    companyId: { type: String, required: true, index: true },
    companyName: { type: String, required: true },
    companyIcon: { type: String, default: "🍩" },

    type: { type: String, enum: ["buy", "sell"], required: true },
    orderType: { type: String, enum: ["market", "limit", "stop", "stop_limit"], default: "market" },
    shares: { type: Number, required: true, min: 0.000001 },

    price: { type: Number, required: true }, // volume-weighted fill price
    referencePrice: { type: Number, default: 0 }, // mid at the moment of the order
    slippagePct: { type: Number, default: 0 }, // how far the fill landed from that mid
    fees: { type: Number, default: 0 },
    total: { type: Number, required: true }, // cash actually moved, fees included

    // Realised profit/loss booked by this trade, sells only (buys just move
    // cost basis around). Summed for the portfolio's realised P&L.
    realizedPnl: { type: Number, default: 0 },
    session: { type: String, default: "regular" },
  },
  { timestamps: true }
);

tradeSchema.index({ createdAt: -1 });
tradeSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("Trade", tradeSchema);
