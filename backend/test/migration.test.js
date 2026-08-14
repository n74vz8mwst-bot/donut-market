/* ===========================================================================
   Upgrading a live database.

   The engine rewrite changed the Company schema, and a deployment that has
   been running since before it has companies with no simulation state at all.
   Every market read path starts from that state, so a database like that took
   down the leaderboard, the market board and the homepage statistics at once.

   These tests build exactly that database — raw documents in the old shape,
   inserted underneath Mongoose so no schema defaults are applied — and check
   that the app repairs itself instead of throwing.

   Requires mongodb-memory-server (a devDependency). Skipped if it isn't
   installed, so `npm test` still works on a production install.
   =========================================================================== */

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

let MongoMemoryReplSet;
try {
  ({ MongoMemoryReplSet } = require("mongodb-memory-server"));
} catch (_err) {
  MongoMemoryReplSet = null;
}

const suite = MongoMemoryReplSet ? test : test.skip;

suite("legacy database upgrade", async (t) => {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(replSet.getUri("donutmarket_test"));

  const Company = require("../models/Company");
  const User = require("../models/User");
  const MarketEvent = require("../models/MarketEvent");
  const migrate = require("../services/migrate");
  const market = require("../services/market");
  const exchange = require("../services/exchange");
  const portfolio = require("../services/portfolio");

  // A company exactly as the pre-engine version wrote it: no `sim`, no
  // `sharesOutstanding`, no `listedAt`, plus a `lastTickAt` field that no
  // longer exists in the schema.
  const legacy = (ticker, price) => ({
    ticker,
    name: `${ticker.toUpperCase()} Holdings`,
    icon: "🍩",
    sector: "Bakery Tech",
    price,
    openPrice: price,
    liquidity: 5000,
    status: "open",
    lastTickAt: new Date(),
    createdAt: new Date(Date.now() - 30 * 86400000),
    updatedAt: new Date(),
  });

  t.after(async () => {
    await mongoose.disconnect();
    await replSet.stop();
  });

  await t.test("startup migration repairs pre-engine companies", async () => {
    await Company.collection.insertOne(legacy("old1", 120.5));
    await migrate.run();

    const upgraded = await Company.findOne({ ticker: "old1" });
    assert.ok(upgraded.sim, "sim state should have been created");
    assert.ok(Number.isFinite(upgraded.sim.tick));
    assert.ok(Math.abs(Math.exp(upgraded.sim.logPrice) - 120.5) < 0.01, "price should be preserved exactly");
    assert.equal(upgraded.sharesOutstanding, 1000000);
    assert.ok(upgraded.listedAt);
  });

  await t.test("a repaired company gets a chart instead of an empty panel", async () => {
    const Candle = require("../models/Candle");
    const candles = await market.getCandles("old1", "1h", 100);
    assert.ok(candles.length > 20, `expected backfilled history, got ${candles.length} bars`);
    assert.ok(candles.every((c) => c.h >= c.l && Number.isFinite(c.c)));

    // The backfill must land on the company's real current price, not drift
    // off to wherever the simulation happened to wander.
    const company = await Company.findOne({ ticker: "old1" });
    const raw = await Candle.find({ ticker: "old1" }).sort({ t: -1 }).limit(1);
    assert.ok(Math.abs(raw[0].c - company.price) / company.price < 0.02);
  });

  await t.test("a legacy company inserted later is repaired on first read", async () => {
    // The lazy path matters as much as the startup one: a document can arrive
    // after boot (a restored backup, a second app instance mid-deploy).
    await Company.collection.insertOne(legacy("old2", 88.25));

    const companies = await exchange.loadMarket();
    const repaired = companies.find((c) => c.ticker === "old2");
    assert.ok(repaired.sim, "reading the market should have repaired it");

    const quote = market.quoteFor(repaired, { settings: { marketMode: "24/7" } });
    assert.ok(quote.bid > 0 && quote.ask > quote.bid, "should produce a real two-sided quote");
    assert.ok(Number.isFinite(quote.market_cap) && quote.market_cap > 0, "market cap must not be NaN");
    assert.ok(Number.isFinite(quote.change_pct));
  });

  await t.test("the index is computable from repaired companies", async () => {
    const companies = await exchange.loadMarket();
    const index = market.computeIndex(companies);
    assert.ok(Number.isFinite(index.value), "index value must not be NaN");
    assert.ok(index.value > 0);
    assert.equal(index.members, companies.length);
  });

  await t.test("the leaderboard values a pre-engine user document", async () => {
    // The old user shape: no reservedCash, no realizedPnl, no adminAdjustments.
    await User.collection.insertOne({
      username: "veteran",
      email: "veteran@donut.market",
      passwordHash: "x",
      balance: 4000,
      startingBalance: 10000,
      role: "trader",
      holdings: [{ companyId: "old1", shares: 10, avgPrice: 100 }],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const companies = await exchange.loadMarket();
    const user = await User.findOne({ username: "veteran" });
    const valuation = portfolio.valuate(user, companies);

    assert.ok(Number.isFinite(valuation.netWorth), "net worth must not be NaN");
    assert.ok(valuation.netWorth > 4000, "should include the value of the holding");
    assert.equal(valuation.reservedCash, 0);
    assert.ok(Number.isFinite(valuation.totalReturnPct));
    assert.equal(valuation.positions.length, 1);
    assert.ok(Number.isFinite(valuation.positions[0].value));
  });

  await t.test("two admin headlines about one company don't collide", async () => {
    // Both have no tick. Under a *sparse* unique index they'd both be stored
    // as tick:null and the second insert would fail with a duplicate key.
    const base = { companyId: "old1", source: "admin", severity: "moderate", at: new Date() };
    await MarketEvent.create({ ...base, headline: "First notice", impactPct: 1 });
    await MarketEvent.create({ ...base, headline: "Second notice", impactPct: 2 });

    assert.equal(await MarketEvent.countDocuments({ companyId: "old1", source: "admin" }), 2);
  });

  await t.test("engine headlines stay idempotent per tick", async () => {
    const doc = { companyId: "old1", tick: 4242, headline: "Engine story", source: "market", at: new Date() };
    await MarketEvent.create(doc);
    await assert.rejects(() => MarketEvent.create(doc), /duplicate key/i);
    assert.equal(await MarketEvent.countDocuments({ companyId: "old1", tick: 4242 }), 1);
  });
});
