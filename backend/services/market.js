/* ===========================================================================
   DONUT MARKET — services/market.js
   Where the simulation meets the database.

   There is no background worker. Whichever request happens to look at a
   company is the one that advances its clock — and because engine/price.js is
   a pure function of the tick index, that produces exactly the same path as a
   cron job would have. It also means the market keeps ticking on a free host
   that suspends idle processes, and two requests a millisecond apart agree on
   the price.

   Two requests arriving at the same instant would both compute the same bars,
   though, and both try to bank the volume. So the write is guarded by an
   optimistic claim on `sim.tick`: whoever gets there first persists the
   candles, the loser just reads the result.
   =========================================================================== */

const Company = require("../models/Company");
const Candle = require("../models/Candle");
const MarketEvent = require("../models/MarketEvent");
const cal = require("../engine/calendar");
const price = require("../engine/price");
const book = require("../engine/book");
const news = require("../engine/news");
const settingsService = require("./settings");
const { sessionOpts } = require("./db");

const TIMEFRAMES = {
  "1m": { unit: "minute", binSize: 1, ms: 60000 },
  "5m": { unit: "minute", binSize: 5, ms: 5 * 60000 },
  "15m": { unit: "minute", binSize: 15, ms: 15 * 60000 },
  "1h": { unit: "hour", binSize: 1, ms: 3600000 },
  "1d": { unit: "day", binSize: 1, ms: 86400000 },
};

// Merges a company's stored overrides into the shape engine/price.js wants.
// Nulls mean "derive it from liquidity", so they're stripped out.
function paramsFor(company) {
  const overrides = {};
  const stored = company.params || {};
  for (const [key, value] of Object.entries(stored.toObject ? stored.toObject() : stored)) {
    if (value !== null && value !== undefined) overrides[key] = value;
  }
  return price.normalizeParams({
    ticker: company.ticker,
    sector: company.sector,
    liquidity: company.liquidity,
    ...overrides,
  });
}

// Current annualised volatility including the clustering regime — this is what
// the order book prices its spread off, so quotes widen in choppy stretches.
function liveVol(company, params, tick) {
  const nameMult = price.volRegime(params.seed ^ 0x1f83d9ab, tick, price.TICKS_PER_SESSION * 2);
  const marketMult = price.volRegime(price.MARKET_SEED, tick, price.TICKS_PER_SESSION * 3);
  return params.annualVol * nameMult * marketMult;
}

/**
 * Advances one company to `now`, persisting the candles and news it passed
 * through. Safe to call from anywhere, as often as you like.
 *
 * @returns {{ company, bars, jumps, advanced }}
 */
async function advanceCompany(company, options = {}) {
  const now = options.now || Date.now();
  const settings = options.settings || (await settingsService.get());
  const session = options.session || null;

  // Halted and delisted names don't move. A halt is a real circuit breaker:
  // the clock catches up so the price doesn't leap when trading resumes.
  if (company.status !== "open") {
    if (company.sim) company.sim.tick = cal.tickAt(now - 1);
    return { company, bars: [], jumps: [], advanced: false };
  }

  const fromTick = company.sim.tick;
  const simState = company.sim.toObject ? company.sim.toObject() : company.sim;
  const result = price.advance(simState, paramsFor(company), now, { mode: settings.marketMode });

  if (!result.ticksAdvanced && result.sim.tick === fromTick) {
    return { company, bars: [], jumps: [], advanced: false };
  }

  const newPrice = Math.exp(result.sim.logPrice);

  // Optimistic claim: only the request that still sees the old tick writes.
  // Anyone racing it recomputed the identical path, so nothing is lost — we
  // just don't want the volume banked twice.
  const claim = await Company.updateOne(
    { _id: company._id, "sim.tick": fromTick },
    { $set: { sim: result.sim, price: newPrice } },
    sessionOpts(session)
  );

  company.sim = result.sim;
  company.price = newPrice;

  const won = claim.modifiedCount > 0 || claim.nModified > 0;
  if (!won) return { company, bars: result.bars, jumps: result.jumps, advanced: true, raced: true };

  await persistBars(company.ticker, result.bars, session);
  await fileNews(company, result.jumps, session);

  return { company, bars: result.bars, jumps: result.jumps, advanced: true };
}

// Writes minute bars. A bar that is still forming gets merged into rather than
// replaced: the open is kept, the high/low extend, the close moves and the
// volume accumulates.
async function persistBars(ticker, bars, session) {
  if (!bars.length) return;
  const ops = bars.map((b) => ({
    updateOne: {
      filter: { ticker, t: new Date(b.t) },
      update: {
        $setOnInsert: { ticker, t: new Date(b.t), o: b.o },
        $max: { h: b.h },
        $min: { l: b.l },
        $set: { c: b.c, session: b.session || "regular" },
        $inc: { v: Math.round(b.v) },
      },
      upsert: true,
    },
  }));
  try {
    await Candle.bulkWrite(ops, { ordered: false, ...sessionOpts(session) });
  } catch (err) {
    // Two writers upserting the same brand-new bar can collide on the unique
    // index. The loser's data is already in the winner's write.
    if (err.code !== 11000) throw err;
  }
}

// Files the headline for every jump the path produced. Keyed by tick, so
// re-advancing the same stretch of time can't double-post a story.
async function fileNews(company, jumps, session) {
  if (!jumps.length) return;
  const docs = jumps.map((jump) => ({
    ...news.headlineFor(company, jump),
    companyName: company.name,
    companyIcon: company.icon,
    tick: jump.tick,
  }));
  try {
    await MarketEvent.insertMany(docs, { ordered: false, ...sessionOpts(session) });
  } catch (err) {
    if (err.code !== 11000 && !err.writeErrors) throw err;
  }
}

// Advances a batch of companies together. Used by every list endpoint so the
// whole market is current in one pass.
async function advanceAll(companies, options = {}) {
  const settings = options.settings || (await settingsService.get());
  const now = options.now || Date.now();
  const out = [];
  for (const company of companies) {
    out.push(await advanceCompany(company, { ...options, settings, now }));
  }
  return out;
}

/**
 * The full quote for a company: two-sided market, depth ladder, day statistics
 * and where the price sits against its own recent range.
 */
function quoteFor(company, options = {}) {
  const now = options.now || Date.now();
  const settings = options.settings || {};
  const sessionInfo = cal.sessionAt(now, settings.marketMode || "exchange");
  const params = paramsFor(company);
  const tick = cal.tickAt(now);
  const sigma = liveVol(company, params, tick);

  const tradable = company.status === "open" && sessionInfo.isOpen;
  const ladder = book.buildBook(company.price, params, tick, sessionInfo.session, sigma);
  const sim = company.sim || {};
  const prevClose = sim.prevClose || company.openPrice || company.price;

  return {
    ticker: company.ticker,
    name: company.name,
    icon: company.icon,
    sector: company.sector,
    status: company.status,
    price: round2(company.price),
    ...ladder,
    prev_close: round2(prevClose),
    change: round2(company.price - prevClose),
    change_pct: prevClose ? ((company.price - prevClose) / prevClose) * 100 : 0,
    day_open: round2(sim.dayOpen || company.price),
    day_high: round2(sim.dayHigh || company.price),
    day_low: round2(sim.dayLow || company.price),
    day_volume: Math.round(sim.dayVolume || 0),
    market_cap: company.price * company.sharesOutstanding,
    shares_outstanding: company.sharesOutstanding,
    annual_vol_pct: sigma * 100,
    adv: params.adv,
    beta: round2(params.beta),
    session: sessionInfo.session,
    is_open: sessionInfo.isOpen,
    tradable,
    next_open: sessionInfo.isOpen ? null : cal.nextOpen(now, settings.marketMode || "exchange"),
    prints: book.recentPrints(ladder, params, tick),
  };
}

/**
 * OHLCV history at a chosen timeframe, aggregated out of the stored minute
 * bars by the database. Daily bars are bucketed in exchange-local time so a
 * "day" means a trading day, not a UTC one.
 */
async function getCandles(ticker, timeframe = "5m", limit = 240) {
  const tf = TIMEFRAMES[timeframe] || TIMEFRAMES["5m"];
  const capped = Math.min(Math.max(parseInt(limit, 10) || 240, 1), 1000);

  // Look back far enough to fill the request even across weekends and nights,
  // when no bars exist at all.
  const lookbackMs = tf.ms * capped * (tf.ms >= 86400000 ? 2 : 4) + 7 * 86400000;

  const rows = await Candle.aggregate([
    { $match: { ticker: ticker.toLowerCase(), t: { $gte: new Date(Date.now() - lookbackMs) } } },
    { $sort: { t: 1 } },
    {
      $group: {
        _id: { $dateTrunc: { date: "$t", unit: tf.unit, binSize: tf.binSize, timezone: cal.TZ } },
        o: { $first: "$o" },
        h: { $max: "$h" },
        l: { $min: "$l" },
        c: { $last: "$c" },
        v: { $sum: "$v" },
      },
    },
    { $sort: { _id: -1 } },
    { $limit: capped },
    { $sort: { _id: 1 } },
  ]);

  return rows.map((r) => ({
    t: r._id.getTime(),
    o: round2(r.o),
    h: round2(r.h),
    l: round2(r.l),
    c: round2(r.c),
    v: Math.round(r.v),
  }));
}

// Compact sparkline series for a list of tickers, in one round trip.
async function getSparklines(tickers, points = 40) {
  if (!tickers.length) return {};
  const since = new Date(Date.now() - 3 * 86400000);
  const rows = await Candle.aggregate([
    { $match: { ticker: { $in: tickers }, t: { $gte: since } } },
    { $sort: { t: 1 } },
    {
      $group: {
        _id: { ticker: "$ticker", bucket: { $dateTrunc: { date: "$t", unit: "minute", binSize: 15 } } },
        c: { $last: "$c" },
      },
    },
    { $sort: { "_id.bucket": 1 } },
    { $group: { _id: "$_id.ticker", series: { $push: "$c" } } },
  ]);

  const out = {};
  for (const row of rows) out[row._id] = row.series.slice(-points).map(round2);
  return out;
}

/**
 * The Donut 500 — a market-cap weighted index of every open listing, based at
 * 1000 on each company's listing price. It's the number the market factor in
 * engine/price.js is ultimately moving, so it's the honest way to answer "is
 * the market up today?".
 */
function computeIndex(companies) {
  const live = companies.filter((c) => c.status !== "closed");
  if (!live.length) return null;

  let cap = 0;
  let baseCap = 0;
  let prevCap = 0;
  for (const c of live) {
    const shares = c.sharesOutstanding || 1;
    cap += c.price * shares;
    baseCap += c.openPrice * shares;
    prevCap += (c.sim?.prevClose || c.openPrice) * shares;
  }

  const value = (cap / baseCap) * 1000;
  const prev = (prevCap / baseCap) * 1000;
  const advancers = live.filter((c) => c.price > (c.sim?.prevClose || c.openPrice)).length;

  return {
    symbol: "DNT500",
    name: "Donut 500",
    value,
    prev_close: prev,
    change: value - prev,
    change_pct: prev ? ((value - prev) / prev) * 100 : 0,
    market_cap: cap,
    members: live.length,
    advancers,
    decliners: live.length - advancers,
  };
}

// Index history, rebuilt from member candles and weighted by shares
// outstanding — same construction as computeIndex, applied bar by bar.
async function getIndexHistory(companies, timeframe = "15m", limit = 96) {
  const tf = TIMEFRAMES[timeframe] || TIMEFRAMES["15m"];
  const live = companies.filter((c) => c.status !== "closed");
  if (!live.length) return [];

  const weights = Object.fromEntries(live.map((c) => [c.ticker, c.sharesOutstanding || 1]));
  const baseCap = live.reduce((sum, c) => sum + c.openPrice * (c.sharesOutstanding || 1), 0);

  const rows = await Candle.aggregate([
    {
      $match: {
        ticker: { $in: live.map((c) => c.ticker) },
        t: { $gte: new Date(Date.now() - tf.ms * limit * 4 - 7 * 86400000) },
      },
    },
    { $sort: { t: 1 } },
    {
      $group: {
        _id: {
          ticker: "$ticker",
          bucket: { $dateTrunc: { date: "$t", unit: tf.unit, binSize: tf.binSize, timezone: cal.TZ } },
        },
        c: { $last: "$c" },
      },
    },
    { $sort: { "_id.bucket": 1 } },
  ]);

  const buckets = new Map();
  const lastSeen = new Map();
  for (const row of rows) {
    const key = row._id.bucket.getTime();
    if (!buckets.has(key)) buckets.set(key, new Map());
    buckets.get(key).set(row._id.ticker, row.c);
  }

  const series = [];
  for (const key of [...buckets.keys()].sort((a, b) => a - b)) {
    const prices = buckets.get(key);
    let cap = 0;
    for (const c of live) {
      // Carry the last print forward for names that didn't trade in the bucket.
      const p = prices.get(c.ticker) ?? lastSeen.get(c.ticker) ?? c.openPrice;
      lastSeen.set(c.ticker, p);
      cap += p * weights[c.ticker];
    }
    series.push({ t: key, v: (cap / baseCap) * 1000 });
  }
  return series.slice(-limit);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = {
  TIMEFRAMES,
  paramsFor,
  liveVol,
  advanceCompany,
  advanceAll,
  quoteFor,
  getCandles,
  getSparklines,
  computeIndex,
  getIndexHistory,
  persistBars,
};
