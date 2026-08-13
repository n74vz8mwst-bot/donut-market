const mongoose = require("mongoose");

// Holdings live embedded on the user document — simplest shape for a
// single-player-per-account game like this, and avoids extra joins for
// something we read constantly (portfolio page, leaderboard).
const holdingSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true }, // matches Company.ticker
    shares: { type: Number, required: true, default: 0, min: 0 },
    avgPrice: { type: Number, required: true, default: 0 },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    balance: { type: Number, required: true, default: 10000 },
    role: { type: String, enum: ["trader", "admin"], default: "trader" },
    holdings: { type: [holdingSchema], default: [] },
  },
  { timestamps: true }
);

// Never leak the password hash to the client.
userSchema.set("toJSON", {
  transform: (_doc, ret) => {
    delete ret.passwordHash;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("User", userSchema);
