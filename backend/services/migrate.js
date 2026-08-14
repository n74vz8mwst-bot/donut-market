const mongoose = require("mongoose");

/* ===========================================================================
   Startup migration.

   This project has been deployed against a live database since before the
   simulation engine existed, so upgrading can't assume a clean slate. Two
   things have to happen when a new version boots against an old database:

   1. **Indexes are brought in line with the schemas.** Mongoose's automatic
      index build refuses to change the options on an index that already
      exists (it raises IndexOptionsConflict and logs it as a connection
      error), which is exactly what happens when a constraint is tightened or
      loosened between versions. `syncIndexes()` drops what no longer matches
      and rebuilds it.

   2. **Legacy documents are repaired.** Companies created by the old version
      have no simulation state, and every market read path starts from it. The
      repair itself lives in services/market.js#ensureSim and also runs lazily
      on first read, so this pass is belt-and-braces: it means the very first
      request after a deploy isn't the one paying for the migration.

   Failures here are logged, never fatal. A migration problem should degrade
   the exchange, not stop it from booting.
   =========================================================================== */

const Company = require("../models/Company");
const Candle = require("../models/Candle");
const Order = require("../models/Order");
const Trade = require("../models/Trade");
const User = require("../models/User");
const MarketEvent = require("../models/MarketEvent");
const EquitySnapshot = require("../models/EquitySnapshot");

const MODELS = [Company, Candle, Order, Trade, User, MarketEvent, EquitySnapshot];

async function syncIndexes() {
  for (const model of MODELS) {
    try {
      await model.syncIndexes();
    } catch (err) {
      console.warn(`⚠️  Could not sync indexes for ${model.modelName}: ${err.message}`);
    }
  }
}

async function upgradeCompanies() {
  // Required late: services/market.js pulls in the engine, which we only want
  // loaded once the connection is up.
  const market = require("./market");

  const stale = await Company.find({
    $or: [{ sim: { $exists: false } }, { sim: null }, { "sim.tick": { $exists: false } }],
  });
  if (!stale.length) return 0;

  console.log(`↻ Upgrading ${stale.length} compan${stale.length === 1 ? "y" : "ies"} from the pre-engine schema…`);
  let upgraded = 0;
  for (const company of stale) {
    try {
      if (await market.ensureSim(company)) upgraded++;
      await backfillIfEmpty(company);
    } catch (err) {
      console.warn(`⚠️  Could not upgrade ${company.ticker}: ${err.message}`);
    }
  }
  return upgraded;
}

/**
 * Gives a repaired company a chart.
 *
 * The old version stored a thin trail of price points in a separate
 * collection; the engine works in candles, and a ticker with none shows an
 * empty chart until enough minutes accumulate to fill one. So a company that
 * arrives with no candles gets the same deterministic backfill a brand-new
 * listing does — the shape is simulated, and the final bar lands exactly on
 * the price the company actually has right now.
 */
async function backfillIfEmpty(company) {
  const price = require("../engine/price");
  const cal = require("../engine/calendar");
  const market = require("./market");

  if (await Candle.exists({ ticker: company.ticker })) return false;

  const now = Date.now();
  const bars = price.backfill(company, company.sim, now - 10 * 86400000, now, { barMs: cal.BAR_MS });
  if (!bars.length) return false;

  await market.persistBars(company.ticker, bars.slice(-4000), null);
  console.log(`↻ ${company.ticker}: backfilled ${Math.min(bars.length, 4000)} candles.`);
  return true;
}

async function run() {
  if (mongoose.connection.readyState !== 1) return;
  await syncIndexes();
  await upgradeCompanies();
}

module.exports = { run, syncIndexes, upgradeCompanies, backfillIfEmpty };
