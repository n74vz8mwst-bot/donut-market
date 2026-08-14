/* ===========================================================================
   Seeds the exchange.

     node seed.js              list any companies that don't exist yet
     node seed.js --reset      wipe companies, candles and news first
     node seed.js --admin      also create an admin account if none exists

   Safe to re-run: existing tickers are left alone unless --reset is passed.

   Each new listing gets ten days of deterministic backfilled candles (see
   engine/price.js#backfill) so a fresh exchange opens with real-looking charts
   instead of a single flat dot — the shape is simulated, and the last bar
   lands exactly on the listing price.
   =========================================================================== */

const mongoose = require("mongoose");
const dotenv = require("dotenv");
const bcrypt = require("bcrypt");

const Company = require("./models/Company");
const Candle = require("./models/Candle");
const MarketEvent = require("./models/MarketEvent");
const User = require("./models/User");
const cal = require("./engine/calendar");
const price = require("./engine/price");
const market = require("./services/market");

dotenv.config();

// liquidity drives volatility, spread and depth; sharesOutstanding sets market
// cap and the index weight. Together they give the board a real spread of
// character: mega-caps that barely move, thin names that whip around.
const COMPANIES = [
  { ticker: "dnut", name: "Donut Corp", icon: "🍩", sector: "Bakery Tech", price: 250.4, liquidity: 9000, sharesOutstanding: 4200000, description: "The original glazed conglomerate. Twelve hundred stores, one recipe, zero apologies." },
  { ticker: "glz", name: "Glaze Dynamics", icon: "🧁", sector: "Consumer", price: 118.75, liquidity: 4000, sharesOutstanding: 2800000, description: "Industrial icing systems and the patents that hold them together." },
  { ticker: "sprk", name: "Sprinkle Systems", icon: "✨", sector: "Tech", price: 74.2, liquidity: 2500, sharesOutstanding: 5100000, description: "Confetti-grade topping robotics. Ships more sprinkles per second than anyone alive." },
  { ticker: "krsp", name: "Krispy Holdings", icon: "🍪", sector: "Bakery Tech", price: 340.1, liquidity: 12000, sharesOutstanding: 3100000, description: "Quietly owns the ovens behind half the market's listed bakers." },
  { ticker: "jlly", name: "Jelly Filled Inc", icon: "🍮", sector: "Consumer", price: 52.6, liquidity: 1800, sharesOutstanding: 1400000, description: "One product, wildly beloved, catastrophically seasonal." },
  { ticker: "frst", name: "Frosting Freight", icon: "🚚", sector: "Logistics", price: 29.9, liquidity: 1200, sharesOutstanding: 900000, description: "Refrigerated haulage for perishable sugar. Thin margins, thinner ice." },
  { ticker: "chz", name: "Choco Zaibatsu", icon: "🍫", sector: "Conglomerate", price: 501.0, liquidity: 20000, sharesOutstanding: 6800000, description: "The exchange's heaviest weight. When it moves, the index moves." },
  { ticker: "mplg", name: "Maple Glow Co.", icon: "🍁", sector: "Consumer", price: 88.3, liquidity: 3000, sharesOutstanding: 1900000, description: "Single-origin syrup, vertically integrated from tree to tin." },
  { ticker: "yst", name: "Yeast Labs", icon: "🧫", sector: "Tech", price: 163.45, liquidity: 2200, sharesOutstanding: 1200000, description: "Fermentation biotech. Two thirds of revenue comes from patents nobody understands." },
  { ticker: "brew", name: "Bitter Brew Union", icon: "☕", sector: "Consumer", price: 41.2, liquidity: 5200, sharesOutstanding: 3600000, description: "Coffee to go with everything else on this exchange." },
  { ticker: "ovn", name: "Ovenworks Energy", icon: "🔥", sector: "Energy", price: 96.8, liquidity: 6400, sharesOutstanding: 2400000, description: "Supplies heat to every bakery on the board, and prices it accordingly." },
  { ticker: "vlt", name: "Vault & Vanilla", icon: "🏦", sector: "Finance", price: 212.55, liquidity: 15000, sharesOutstanding: 2100000, description: "Lends to bakers. Owns the collateral when they fail." },
];

const args = process.argv.slice(2);
const wantsReset = args.includes("--reset");
const wantsAdmin = args.includes("--admin");

// Folds a run of one-minute bars into coarser buckets, properly: first open,
// highest high, lowest low, last close, summed volume.
function compress(bars, bucketMs) {
  const out = [];
  let current = null;
  for (const bar of bars) {
    const bucket = Math.floor(bar.t / bucketMs) * bucketMs;
    if (!current || current.t !== bucket) {
      if (current) out.push(current);
      current = { ...bar, t: bucket };
    } else {
      current.h = Math.max(current.h, bar.h);
      current.l = Math.min(current.l, bar.l);
      current.c = bar.c;
      current.v += bar.v;
    }
  }
  if (current) out.push(current);
  return out;
}

// Ten days of history: minute bars for the recent two days (so intraday charts
// have real resolution), fifteen-minute bars before that (so the collection
// doesn't balloon for history nobody zooms into).
async function seedHistory(company) {
  const now = Date.now();
  const bars = price.backfill(company, company.sim, now - 10 * 86400000, now, { barMs: cal.BAR_MS });
  const cutoff = now - 2 * 86400000;
  const recent = bars.filter((b) => b.t >= cutoff);
  const older = compress(bars.filter((b) => b.t < cutoff), 15 * 60000);
  await market.persistBars(company.ticker, [...older, ...recent], null);
  return older.length + recent.length;
}

async function seedCompanies() {
  let created = 0;
  for (const spec of COMPANIES) {
    const existing = await Company.findOne({ ticker: spec.ticker });
    if (existing) {
      // An older database may predate the simulation state — give it one so
      // the engine can pick the company up rather than crashing on it.
      if (!existing.sim || existing.sim.tick == null) {
        existing.sim = price.initSim({ price: existing.price }, Date.now());
        existing.sharesOutstanding = existing.sharesOutstanding || spec.sharesOutstanding;
        await existing.save();
        console.log(`~ ${spec.ticker} upgraded to the new simulation engine.`);
      } else {
        console.log(`- ${spec.ticker} already listed, skipping.`);
      }
      continue;
    }

    const now = Date.now();
    const company = await Company.create({
      ...spec,
      openPrice: spec.price,
      listedAt: new Date(now - 10 * 86400000),
      sim: price.initSim({ price: spec.price }, now),
    });

    const bars = await seedHistory(company);
    created++;
    console.log(`+ listed ${spec.ticker.padEnd(5)} ${spec.name.padEnd(20)} ${bars} candles backfilled`);
  }
  return created;
}

async function seedAdmin() {
  const existing = await User.findOne({ role: "admin" });
  if (existing) {
    console.log(`- admin already exists (${existing.username}), skipping.`);
    return null;
  }
  const password = process.env.SEED_ADMIN_PASSWORD || "donutdonut";
  const user = await User.create({
    username: "admin",
    email: process.env.SEED_ADMIN_EMAIL || "admin@donut.market",
    passwordHash: await bcrypt.hash(password, 10),
    role: "admin",
    balance: 100000,
    startingBalance: 100000,
  });
  console.log(`+ created admin ${user.email} / ${password}`);
  return user;
}

async function seed() {
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI is not set — check backend/.env, or use `npm run dev:memory`.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to MongoDB.");

  if (wantsReset) {
    await Promise.all([Company.deleteMany({}), Candle.deleteMany({}), MarketEvent.deleteMany({})]);
    console.log("Wiped companies, candles and news.");
  }

  const created = await seedCompanies();
  if (wantsAdmin) await seedAdmin();

  console.log(`Done. ${created} companies listed.`);
  await mongoose.disconnect();
  process.exit(0);
}

if (require.main === module) {
  seed().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { COMPANIES, seedCompanies, seedAdmin, seedHistory };
