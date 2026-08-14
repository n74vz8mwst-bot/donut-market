const mongoose = require("mongoose");

// A point on a trader's equity curve.
//
// Net worth can't be reconstructed after the fact from trades alone — you'd
// also need every price the market printed in between — so we sample it. A
// snapshot is written at most once every few minutes, whenever the trader (or
// the leaderboard) looks at their account, which is cheap and gives the
// portfolio page a real performance chart instead of a single number.
const equitySnapshotSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    t: { type: Date, required: true },
    cash: { type: Number, required: true },
    positionsValue: { type: Number, required: true },
    netWorth: { type: Number, required: true },
  },
  { versionKey: false }
);

equitySnapshotSchema.index({ user: 1, t: 1 }, { unique: true });
// A year of history per trader is plenty for a seasonal game.
equitySnapshotSchema.index({ t: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 365 });

module.exports = mongoose.model("EquitySnapshot", equitySnapshotSchema);
