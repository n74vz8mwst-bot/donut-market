const mongoose = require("mongoose");

// An order is a standing instruction, not an instant transaction.
//
// Market orders fill immediately against the book. Limit and stop orders rest
// here until the price comes to them: every time a company's clock is advanced
// (see services/market.js) the bars it just passed through are checked against
// every open order on that ticker, so a limit fills if the market genuinely
// traded through it — even if nobody was looking at the time.
const orderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    ticker: { type: String, required: true, lowercase: true, index: true },
    side: { type: String, enum: ["buy", "sell"], required: true },

    // market      — take whatever the book offers, right now
    // limit       — fill only at this price or better
    // stop        — becomes a market order once the stop is touched
    // stop_limit  — becomes a limit order once the stop is touched
    type: { type: String, enum: ["market", "limit", "stop", "stop_limit"], required: true },

    qty: { type: Number, required: true, min: 1 },
    limitPrice: { type: Number, default: null },
    stopPrice: { type: Number, default: null },

    // day — cancelled automatically at the close of the session it was placed in
    // gtc — good till cancelled
    tif: { type: String, enum: ["day", "gtc"], default: "day" },

    status: {
      type: String,
      enum: ["open", "triggered", "filled", "cancelled", "expired", "rejected"],
      default: "open",
      index: true,
    },
    filledQty: { type: Number, default: 0 },
    avgFillPrice: { type: Number, default: 0 },
    fees: { type: Number, default: 0 },

    // Cash set aside for a resting buy so the same coins can't be spent twice
    // while the order waits. Released on cancel/expiry, or trued up on fill.
    reservedCash: { type: Number, default: 0 },
    // Shares set aside for a resting sell, for the same reason.
    reservedShares: { type: Number, default: 0 },

    note: { type: String, default: "" }, // why it was rejected/expired, if it was
    placedDayKey: { type: String, default: null }, // trading day, for day-order expiry
    filledAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

orderSchema.index({ ticker: 1, status: 1 });

orderSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    ret.created_at = ret.createdAt;
    ret.filled_at = ret.filledAt;
    ret.limit_price = ret.limitPrice;
    ret.stop_price = ret.stopPrice;
    ret.filled_qty = ret.filledQty;
    ret.avg_fill_price = ret.avgFillPrice;
    delete ret._id;
    delete ret.__v;
    delete ret.user;
    delete ret.reservedCash;
    delete ret.reservedShares;
    return ret;
  },
});

module.exports = mongoose.model("Order", orderSchema);
