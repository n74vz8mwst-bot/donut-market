const mongoose = require("mongoose");

const companySchema = new mongoose.Schema(
  {
    ticker: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true },
    icon: { type: String, default: "🍩" },
    sector: { type: String, default: "General" },
    price: { type: Number, required: true, min: 0.01 },
    openPrice: { type: Number, required: true }, // price at listing — used to show lifetime % change
    liquidity: { type: Number, required: true, default: 5000, min: 1 }, // higher = less sensitive to trades
    status: { type: String, enum: ["open", "closed"], default: "open" },
  },
  { timestamps: true }
);

// The frontend (js/live.js) expects `id`, `open_price` in snake_case to match
// how it was originally wired up — this transform keeps the API response
// shaped exactly how the UI already expects, no frontend changes needed.
companySchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = ret.ticker;
    ret.open_price = ret.openPrice;
    delete ret.openPrice;
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("Company", companySchema);
