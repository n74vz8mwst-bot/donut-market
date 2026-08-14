const mongoose = require("mongoose");

// One-minute OHLCV bars — the market's tape of record.
//
// The simulation runs on a 5-second tick, but storing every tick forever would
// be a lot of rows for very little extra information, so the engine folds
// ticks into minute bars as it advances and this is what gets written. Every
// longer timeframe (5m, 15m, 1h, 1d) is aggregated up from these on read.
//
// Bars only exist for time the market was open, which is exactly why charts
// show a gap over nights and weekends instead of a flat line.
const candleSchema = new mongoose.Schema(
  {
    ticker: { type: String, required: true, lowercase: true },
    t: { type: Date, required: true }, // bar start, aligned to the minute
    o: { type: Number, required: true },
    h: { type: Number, required: true },
    l: { type: Number, required: true },
    c: { type: Number, required: true },
    v: { type: Number, default: 0 }, // shares traded in the bar
    session: { type: String, enum: ["pre", "regular", "after"], default: "regular" },
  },
  { versionKey: false }
);

// One bar per ticker per minute. The upsert in services/market.js relies on
// this being unique — a bar that is still forming gets merged into, not
// duplicated, when the next request advances the same minute further.
candleSchema.index({ ticker: 1, t: 1 }, { unique: true });

// Minute bars are only interesting for a few weeks; daily history is rebuilt
// from them into coarser timeframes on the way out. Expire the raw minutes
// after 45 days so the collection can't grow without bound.
candleSchema.index({ t: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 45 });

module.exports = mongoose.model("Candle", candleSchema);
