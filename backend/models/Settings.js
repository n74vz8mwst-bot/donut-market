const mongoose = require("mongoose");

// A single global settings document — there's only ever one. Everything an
// admin can tune about how the exchange behaves lives here, so the simulation's
// rules are data rather than constants buried in code.
const settingsSchema = new mongoose.Schema(
  {
    startingBalance: { type: Number, required: true, default: 10000, min: 0 },

    // exchange — NYSE calendar: pre-market, regular hours, after-hours,
    //            weekends and holidays closed (see engine/calendar.js)
    // 24/7     — crypto-style, always open
    marketMode: { type: String, enum: ["exchange", "24/7"], default: "exchange" },

    // Fee schedule, in basis points of notional. Defaults model a modern
    // low-cost broker: a thin commission with a floor, plus a token
    // regulatory fee charged to sellers only.
    commissionBps: { type: Number, default: 5, min: 0 },
    minCommission: { type: Number, default: 0.5, min: 0 },
    sellFeeBps: { type: Number, default: 1, min: 0 },

    // Risk limits. A single order can't be worth more than this, and no
    // position may exceed this share of the account's net worth — the same
    // kind of guardrails a real broker puts on a margin-free cash account.
    maxOrderNotional: { type: Number, default: 5000000, min: 1 },
    maxPositionPct: { type: Number, default: 100, min: 1, max: 100 },

    // Whether traders may place orders outside regular hours. Real brokers
    // allow it with limit orders only, which is exactly what we enforce.
    allowExtendedHours: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Fetches the one settings document, creating it with defaults on first use.
settingsSchema.statics.getSingleton = async function () {
  let doc = await this.findOne();
  if (!doc) doc = await this.create({});
  return doc;
};

module.exports = mongoose.model("Settings", settingsSchema);
