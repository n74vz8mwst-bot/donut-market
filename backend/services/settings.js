const Settings = require("../models/Settings");

/* ===========================================================================
   Settings cache.

   Every quote, every order and every candle write needs to know the fee
   schedule and whether the exchange is on the NYSE calendar or running 24/7.
   Reading that document on every request would put a database round trip in
   front of the whole API, so it is cached for a few seconds and invalidated
   the moment an admin changes it.
   =========================================================================== */

const TTL_MS = 5000;

let cached = null;
let cachedAt = 0;

async function get() {
  const now = Date.now();
  if (cached && now - cachedAt < TTL_MS) return cached;
  const doc = await Settings.getSingleton();
  cached = doc.toObject();
  cachedAt = now;
  return cached;
}

function invalidate() {
  cached = null;
  cachedAt = 0;
}

module.exports = { get, invalidate };
