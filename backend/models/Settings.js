const mongoose = require("mongoose");

// A single global settings document — there's only ever one. Holds
// market-wide configuration the admin can change, like the starting
// balance handed to new traders on signup.
const settingsSchema = new mongoose.Schema(
  {
    startingBalance: { type: Number, required: true, default: 10000, min: 0 },
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
