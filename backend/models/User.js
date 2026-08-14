const mongoose = require("mongoose");

// Holdings live embedded on the user document — the simplest shape for a
// single-account-per-player game, and it avoids a join on the two things we
// read constantly (the portfolio page and the leaderboard).
const holdingSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true }, // matches Company.ticker
    shares: { type: Number, required: true, default: 0, min: 0 },
    // Average cost per share, fees included — so unrealised P&L is measured
    // against what the position actually cost, not the screen price at the time.
    avgPrice: { type: Number, required: true, default: 0 },
    realizedPnl: { type: Number, default: 0 }, // booked profit on this name
    firstBoughtAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },

    balance: { type: Number, required: true, default: 10000 },
    // Cash committed to resting buy orders. Buying power is balance minus
    // this, so the same coins can't be promised to two orders at once.
    reservedCash: { type: Number, default: 0 },
    // Whatever the starting-balance setting was when this account was created.
    // Kept per user so leaderboard profit stays honest after an admin changes
    // the setting for future signups.
    startingBalance: { type: Number, required: true, default: 10000 },
    // Coins added or removed by an admin after signup. Netted out of profit so
    // a hand-out doesn't read as trading skill on the leaderboard.
    adminAdjustments: { type: Number, default: 0 },

    realizedPnl: { type: Number, default: 0 },
    feesPaid: { type: Number, default: 0 },
    tradeCount: { type: Number, default: 0 },

    role: { type: String, enum: ["trader", "admin"], default: "trader" },
    holdings: { type: [holdingSchema], default: [] },
    watchlist: { type: [String], default: [] },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Never leak the password hash to the client.
userSchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    ret.buying_power = Math.max(0, ret.balance - (ret.reservedCash || 0));
    ret.reserved_cash = ret.reservedCash || 0;
    ret.starting_balance = ret.startingBalance;
    ret.realized_pnl = ret.realizedPnl || 0;
    delete ret.passwordHash;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model("User", userSchema);
