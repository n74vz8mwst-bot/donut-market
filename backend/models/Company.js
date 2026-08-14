const mongoose = require("mongoose");

// The live simulation state carried by every listing. It is small on purpose:
// because engine/price.js is a pure function of (params, tick), this is all we
// need to persist to reconstruct the price at any moment. See engine/price.js.
const simSchema = new mongoose.Schema(
  {
    tick: { type: Number, required: true }, // last advanced tick on the global grid
    logPrice: { type: Number, required: true },
    fairLog: { type: Number, required: true }, // log of fair value; price mean-reverts to it
    tempImpact: { type: Number, default: 0 }, // decaying share of recent trade impact
    dayKey: { type: String, default: null }, // exchange-local trading day, e.g. 2026-08-13
    prevClose: { type: Number, default: 0 },
    dayOpen: { type: Number, default: 0 },
    dayHigh: { type: Number, default: 0 },
    dayLow: { type: Number, default: 0 },
    dayVolume: { type: Number, default: 0 },
  },
  { _id: false }
);

// Per-company simulation parameters. Anything left null is derived from the
// company's liquidity by engine/price.js#normalizeParams — thin names get
// higher volatility and lower market beta, the way small caps really behave.
const paramsSchema = new mongoose.Schema(
  {
    annualVol: { type: Number, default: null }, // idiosyncratic vol, annualised
    beta: { type: Number, default: null }, // sensitivity to the market factor
    sectorBeta: { type: Number, default: null },
    drift: { type: Number, default: null }, // long-run expected return
    meanReversion: { type: Number, default: null }, // pull toward fair value
    jumpsPerYear: { type: Number, default: null }, // news-shock intensity
    jumpVol: { type: Number, default: null },
    adv: { type: Number, default: null }, // average daily volume, in shares
  },
  { _id: false }
);

const companySchema = new mongoose.Schema(
  {
    ticker: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true },
    icon: { type: String, default: "🍩" },
    sector: { type: String, default: "General" },
    description: { type: String, default: "" },

    // Denormalised copy of exp(sim.logPrice). The simulation is the source of
    // truth; this exists so the database can sort and filter on price without
    // waking every company up first.
    price: { type: Number, required: true, min: 0.0001 },
    openPrice: { type: Number, required: true }, // listing price, for lifetime change
    listedAt: { type: Date, default: Date.now },

    liquidity: { type: Number, required: true, default: 5000, min: 1 },
    sharesOutstanding: { type: Number, required: true, default: 1000000, min: 1 },

    // open   — trading normally
    // halted — quotes frozen, orders rejected (admin circuit breaker)
    // closed — permanently delisted from trading but still visible
    status: { type: String, enum: ["open", "halted", "closed"], default: "open" },

    sim: { type: simSchema, required: true },
    params: { type: paramsSchema, default: () => ({}) },
  },
  { timestamps: true }
);

companySchema.index({ sector: 1 });
companySchema.index({ status: 1 });

// The API speaks the frontend's dialect: `id` for the ticker and snake_case
// for the derived fields, so page code reads the same shape everywhere.
companySchema.set("toJSON", {
  transform: (_doc, ret) => {
    const sim = ret.sim || {};
    const prevClose = sim.prevClose || ret.openPrice;
    ret.id = ret.ticker;
    ret.open_price = ret.openPrice;
    ret.prev_close = prevClose;
    ret.day_open = sim.dayOpen || ret.price;
    ret.day_high = sim.dayHigh || ret.price;
    ret.day_low = sim.dayLow || ret.price;
    ret.day_volume = Math.round(sim.dayVolume || 0);
    ret.change_pct = prevClose ? ((ret.price - prevClose) / prevClose) * 100 : 0;
    ret.lifetime_change_pct = ret.openPrice ? ((ret.price - ret.openPrice) / ret.openPrice) * 100 : 0;
    ret.market_cap = ret.price * ret.sharesOutstanding;
    ret.shares_outstanding = ret.sharesOutstanding;

    delete ret.openPrice;
    delete ret.sharesOutstanding;
    delete ret.sim; // internal bookkeeping, never leaves the server
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("Company", companySchema);
