const mongoose = require("mongoose");

const marketEventSchema = new mongoose.Schema(
  {
    headline: { type: String, required: true },
    companyId: { type: String, default: null },
    impactPct: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("MarketEvent", marketEventSchema);
