/* ===========================================================================
   Engine tests — run with:  npm test   (node --test, no dependencies)

   These cover the parts of the simulator that are pure math and therefore
   worth pinning down: the exchange calendar, the determinism of the price
   path, its statistical properties, and the order book's fill mechanics.
   =========================================================================== */

const test = require("node:test");
const assert = require("node:assert/strict");

const cal = require("../engine/calendar");
const price = require("../engine/price");
const book = require("../engine/book");
const news = require("../engine/news");

const COMPANY = {
  ticker: "dnut",
  name: "Donut Corp",
  sector: "Bakery Tech",
  price: 250,
  liquidity: 9000,
};

// A Wednesday, 10:30am New York time.
const WED_1030 = cal.localToUtc(2026, 3, 11, 10 * 60 + 30);

test("calendar: regular session recognised", () => {
  const s = cal.sessionAt(WED_1030);
  assert.equal(s.session, cal.SESSION.REGULAR);
  assert.equal(s.isOpen, true);
});

test("calendar: pre-market, after-hours and overnight are distinct", () => {
  assert.equal(cal.sessionAt(cal.localToUtc(2026, 3, 11, 5 * 60)).session, cal.SESSION.PRE);
  assert.equal(cal.sessionAt(cal.localToUtc(2026, 3, 11, 18 * 60)).session, cal.SESSION.AFTER);
  assert.equal(cal.sessionAt(cal.localToUtc(2026, 3, 11, 2 * 60)).session, cal.SESSION.CLOSED);
});

test("calendar: weekends and holidays are closed", () => {
  // 2026-03-14 is a Saturday.
  assert.equal(cal.sessionAt(cal.localToUtc(2026, 3, 14, 11 * 60)).isOpen, false);
  // New Year's Day 2026 (a Thursday) is a market holiday.
  assert.equal(cal.isTradingDay(2026, 1, 1), false);
  // Good Friday 2026 falls on April 3rd.
  assert.equal(cal.isTradingDay(2026, 4, 3), false);
  // Independence Day 2026 falls on a Saturday, so Friday July 3rd is observed.
  assert.equal(cal.isTradingDay(2026, 7, 3), false);
});

test("calendar: half-days close at 1pm with no after-hours session", () => {
  // Black Friday 2026 = 2026-11-27.
  assert.equal(cal.isHalfDay(2026, 11, 27), true);
  const segments = cal.daySegments(2026, 11, 27);
  assert.equal(segments.length, 2); // pre + regular only
  assert.equal(cal.sessionAt(cal.localToUtc(2026, 11, 27, 14 * 60)).isOpen, false);
});

test("calendar: 24/7 mode never closes", () => {
  assert.equal(cal.sessionAt(cal.localToUtc(2026, 3, 14, 3 * 60), "24/7").isOpen, true);
});

test("calendar: openSegments only covers time the market is open", () => {
  const from = cal.localToUtc(2026, 3, 13, 15 * 60); // Friday 3pm
  const to = cal.localToUtc(2026, 3, 16, 10 * 60); // Monday 10am
  const segments = cal.openSegments(from, to);
  const totalMs = segments.reduce((n, s) => n + (s.end - s.start), 0);
  // Friday 3pm-8pm + Monday 4am-10am = 11 hours; nothing over the weekend.
  assert.equal(totalMs, 11 * 3600 * 1000);
  assert.ok(segments.every((s) => s.session !== cal.SESSION.CLOSED));
});

test("price: advancing is deterministic and repeatable", () => {
  const start = cal.localToUtc(2026, 3, 11, 9 * 60 + 30);
  const sim = { ...price.initSim(COMPANY, start), tick: cal.tickAt(start) };
  const to = start + 45 * 60 * 1000;

  const a = price.advance(sim, COMPANY, to);
  const b = price.advance(sim, COMPANY, to);

  assert.equal(a.sim.logPrice, b.sim.logPrice);
  assert.equal(a.bars.length, b.bars.length);
  assert.deepEqual(a.bars[0], b.bars[0]);
});

test("price: advancing in two hops matches one big hop", () => {
  const start = cal.localToUtc(2026, 3, 11, 9 * 60 + 30);
  const sim = { ...price.initSim(COMPANY, start), tick: cal.tickAt(start) };
  const mid = start + 20 * 60 * 1000;
  const end = start + 40 * 60 * 1000;

  const oneShot = price.advance(sim, COMPANY, end);
  const hopA = price.advance(sim, COMPANY, mid);
  const hopB = price.advance(hopA.sim, COMPANY, end);

  // Same path whether one visitor loads the page once or two load it twice.
  assert.ok(Math.abs(oneShot.sim.logPrice - hopB.sim.logPrice) < 1e-9);
  assert.equal(oneShot.bars.length, hopA.bars.length + hopB.bars.length);
});

test("price: produces one candle per open minute, none while closed", () => {
  const start = cal.localToUtc(2026, 3, 11, 15 * 60); // 3pm Wednesday
  const sim = { ...price.initSim(COMPANY, start), tick: cal.tickAt(start) };
  // Run to 10am the next day: 1h regular + 4h after-hours + 6h pre/regular.
  const result = price.advance(sim, COMPANY, cal.localToUtc(2026, 3, 12, 10 * 60), { maxBars: 100000 });
  const expectedMinutes = 60 + 4 * 60 + (5 * 60 + 30) + 30;
  assert.equal(result.bars.length, expectedMinutes);
  assert.ok(result.bars.every((b) => b.h >= b.l && b.h >= b.o && b.h >= b.c && b.l <= b.o && b.l <= b.c));
  assert.ok(result.bars.every((b) => b.v > 0));
});

test("price: overnight gap opens away from the previous close", () => {
  const start = cal.localToUtc(2026, 3, 11, 15 * 60);
  const sim = { ...price.initSim(COMPANY, start), tick: cal.tickAt(start) };
  const afterOne = price.advance(sim, COMPANY, cal.localToUtc(2026, 3, 11, 19 * 60));
  const nextDay = price.advance(afterOne.sim, COMPANY, cal.localToUtc(2026, 3, 12, 10 * 60));
  assert.ok(nextDay.sim.prevClose > 0);
  assert.notEqual(nextDay.sim.dayOpen, nextDay.sim.prevClose);
});

test("price: realised volatility lands near the configured annual vol", () => {
  // Two full weeks of regular-hours candles, measured as annualised stdev of
  // one-minute log returns. Wide bands: this is a stochastic check, not an
  // exact one, and vol clustering means any single window varies.
  const start = cal.localToUtc(2026, 3, 2, 9 * 60 + 30);
  const params = price.normalizeParams(COMPANY);
  const sim = { ...price.initSim(COMPANY, start), tick: cal.tickAt(start) };
  const result = price.advance(sim, COMPANY, cal.localToUtc(2026, 3, 13, 16 * 60), { maxBars: 100000 });

  const regular = result.bars.filter((b) => b.session === "regular");
  const rets = [];
  for (let i = 1; i < regular.length; i++) {
    if (regular[i].t - regular[i - 1].t !== 60000) continue; // skip day boundaries
    rets.push(Math.log(regular[i].c / regular[i - 1].c));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  const annualised = Math.sqrt(variance) * Math.sqrt(252 * 390);

  const expected = Math.sqrt(
    params.annualVol ** 2 + (params.beta * price.MARKET_VOL) ** 2 + (params.sectorBeta * 0.13) ** 2
  );
  assert.ok(
    annualised > expected * 0.4 && annualised < expected * 2.5,
    `annualised vol ${annualised.toFixed(3)} outside expected band around ${expected.toFixed(3)}`
  );
});

test("price: thinner companies are more volatile than deep ones", () => {
  const thin = price.normalizeParams({ ticker: "frst", liquidity: 1200 });
  const deep = price.normalizeParams({ ticker: "chz", liquidity: 20000 });
  assert.ok(thin.annualVol > deep.annualVol);
  assert.ok(thin.beta < deep.beta);
});

test("price: stays positive over a long, coarse catch-up", () => {
  const start = cal.localToUtc(2026, 1, 5, 9 * 60 + 30);
  const sim = { ...price.initSim(COMPANY, start), tick: cal.tickAt(start) };
  const result = price.advance(sim, COMPANY, cal.localToUtc(2026, 6, 5, 12 * 60));
  assert.equal(result.coarse, true);
  const finalPrice = Math.exp(result.sim.logPrice);
  assert.ok(finalPrice > 0 && Number.isFinite(finalPrice));
  // Mean reversion should keep half a year inside a sane band.
  assert.ok(finalPrice > 20 && finalPrice < 3000, `price drifted to ${finalPrice}`);
});

test("price: backfill ends exactly on the live price", () => {
  const now = cal.localToUtc(2026, 3, 11, 12 * 60);
  const sim = price.initSim(COMPANY, now);
  const bars = price.backfill(COMPANY, sim, now - 5 * 86400000, now, { barMs: 300000 });
  assert.ok(bars.length > 50);
  assert.ok(Math.abs(bars[bars.length - 1].c - Math.exp(sim.logPrice)) < 1e-6);
});

test("book: quotes straddle the mid and spread widens off-hours", () => {
  const params = price.normalizeParams(COMPANY);
  const regular = book.buildBook(250, params, 1000, cal.SESSION.REGULAR, 0.4);
  const pre = book.buildBook(250, params, 1000, cal.SESSION.PRE, 0.4);

  assert.ok(regular.bid < regular.ask);
  assert.ok(regular.bid <= regular.mid && regular.mid <= regular.ask);
  assert.ok(pre.spread > regular.spread, "pre-market spread should be wider");
  assert.equal(regular.bids.length, book.DEPTH_LEVELS);
  // Bids descend, asks ascend.
  assert.ok(regular.bids.every((l, i, arr) => i === 0 || l.price < arr[i - 1].price));
  assert.ok(regular.asks.every((l, i, arr) => i === 0 || l.price > arr[i - 1].price));
});

test("book: thin names quote wider than deep ones", () => {
  const thin = price.normalizeParams({ ticker: "frst", liquidity: 1200 });
  const deep = price.normalizeParams({ ticker: "chz", liquidity: 20000 });
  assert.ok(book.spreadBps(thin, 0.5, cal.SESSION.REGULAR) > book.spreadBps(deep, 0.3, cal.SESSION.REGULAR));
});

test("book: a market buy fills at or above the offer, and bigger is worse", () => {
  const params = price.normalizeParams(COMPANY);
  const b = book.buildBook(250, params, 1000, cal.SESSION.REGULAR, 0.4);

  const small = book.walkBook(b, "buy", 1);
  const large = book.walkBook(b, "buy", 5000);

  assert.equal(small.avgPrice, b.ask);
  assert.ok(large.avgPrice > small.avgPrice, "larger orders should slip");
  assert.equal(large.filledQty, 5000);
  assert.ok(large.sweptLevels > 1);
});

test("book: a market sell fills at or below the bid", () => {
  const params = price.normalizeParams(COMPANY);
  const b = book.buildBook(250, params, 1000, cal.SESSION.REGULAR, 0.4);
  const fill = book.walkBook(b, "sell", 4000);
  assert.ok(fill.avgPrice <= b.bid);
});

test("book: impact follows the square-root law and is capped", () => {
  const params = price.normalizeParams(COMPANY);
  const one = book.impactOf(params.adv * 0.01, params, 0.4, cal.SESSION.REGULAR).total;
  const four = book.impactOf(params.adv * 0.04, params, 0.4, cal.SESSION.REGULAR).total;

  // 4x the size should cost about 2x the impact, not 4x.
  assert.ok(Math.abs(four / one - 2) < 0.15, `ratio was ${(four / one).toFixed(3)}`);
  assert.ok(book.impactOf(params.adv * 500, params, 0.4, cal.SESSION.REGULAR).total <= 0.2);
});

test("book: buying pushes the price up, and part of it decays back", () => {
  const params = price.normalizeParams(COMPANY);
  const start = cal.localToUtc(2026, 3, 11, 10 * 60);
  const sim = { ...price.initSim(COMPANY, start), tick: cal.tickAt(start) };

  const impact = book.impactOf(params.adv * 0.05, params, 0.4, cal.SESSION.REGULAR);
  const after = book.applyImpact(sim, "buy", impact);
  assert.ok(after.logPrice > sim.logPrice);
  assert.ok(after.tempImpact > 0);

  const later = price.advance(after, COMPANY, start + 60 * 60 * 1000);
  assert.ok(Math.abs(later.sim.tempImpact) < Math.abs(after.tempImpact), "temporary impact should decay");
});

test("book: sell fees are charged, buy fees are commission only", () => {
  const buy = book.feesFor(10000, "buy");
  const sell = book.feesFor(10000, "sell");
  assert.equal(buy.regulatory, 0);
  assert.ok(sell.regulatory > 0);
  assert.equal(buy.commission, 5); // 5bps of 10,000
  assert.equal(book.feesFor(100, "buy").commission, 0.5); // minimum commission floor
});

test("news: headlines are deterministic and match the jump direction", () => {
  const jump = { tick: 12345, size: 0.12, ms: WED_1030, overnight: false };
  const a = news.headlineFor(COMPANY, jump);
  const b = news.headlineFor(COMPANY, jump);
  assert.equal(a.headline, b.headline);
  assert.ok(a.impactPct > 0);
  assert.equal(a.severity, "major");
  assert.ok(a.headline.includes("Donut Corp"));

  const down = news.headlineFor(COMPANY, { ...jump, size: -0.12 });
  assert.ok(down.impactPct < 0);
  assert.notEqual(down.headline, a.headline);
});

test("news: every jump the engine emits can be captioned", () => {
  const start = cal.localToUtc(2026, 2, 2, 9 * 60 + 30);
  const sim = { ...price.initSim(COMPANY, start), tick: cal.tickAt(start) };
  const result = price.advance(sim, COMPANY, cal.localToUtc(2026, 2, 20, 16 * 60));
  const items = news.headlinesFor(COMPANY, result.jumps);
  assert.equal(items.length, result.jumps.length);
  assert.ok(items.every((i) => typeof i.headline === "string" && i.headline.length > 10));
});
