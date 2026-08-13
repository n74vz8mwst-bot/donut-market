const mongoose = require("mongoose");

const tradeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    companyId: { type: String, required: true },
    companyName: { type: String, required: true },
    companyIcon: { type: String, default: "🍩" },
    type: { type: String, enum: ["buy", "sell"], required: true },
    shares: { type: Number, required: true, min: 0.000001 },
    price: { type: Number, required: true }, // fill price at time of trade
    total: { type: Number, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Trade", tradeSchema);
