/* ===========================================================================
   DONUT MARKET — engine/book.js
   Market microstructure: quotes, depth, slippage and price impact.

   The old engine filled every order at one number and then nudged the price by
   `shares / liquidity`. That is not how a fill works. Here an order interacts
   with a real (if synthetic) limit order book:

   * There is a **bid and an ask**, not a price. You buy at the offer and sell
     at the bid, and that spread is a genuine cost — wider for thin names, and
     several times wider outside regular hours.
   * The book has **depth**. A big market order walks up the ladder and fills
     at a volume-weighted average worse than the touch. Size costs money.
   * Trades leave **impact** that follows the square-root law observed in real
     markets: cost ~ sigma * sqrt(Q / ADV), split into a permanent component
     (information the market keeps) and a temporary one that decays over the
     next few minutes (liquidity that refills).

   The ladder is deterministic per tick — the same seeded stream as the price
   path — so quotes flicker like a live book but everyone sees the same one.
   =========================================================================== */

const { uniform, gaussian } = require("./rng");
const cal = require("./calendar");

const DEPTH_LEVELS = 8;

// Permanent share of trade impact. The rest decays with the half-life in
// engine/price.js — the market absorbs the flow and quotes drift back.
const PERMANENT_IMPACT_SHARE = 0.4;

// Coefficient on the square-root impact law, calibrated so that an order
// equal to 1% of average daily volume moves a 40%-vol name by roughly 0.4%.
const IMPACT_ETA = 0.6;

const round2 = (n) => Math.round(n * 100) / 100;

// Minimum price increment. Sub-dollar names quote in smaller increments, the
// same way real venues allow sub-penny quoting below $1.
function tickSize(price) {
  if (price >= 1) return 0.01;
  if (price >= 0.1) return 0.001;
  return 0.0001;
}

function roundToTick(price, size = tickSize(price)) {
  return Math.max(size, Math.round(price / size) * size);
}

/**
 * Half-spread in basis points. Driven by the same things that drive it in a
 * real book: how much volatility a market maker has to hedge, how much volume
 * they can expect to recycle it into, and what session it is.
 */
function spreadBps(params, sigmaAnnual, session) {
  const profile = cal.SESSION_PROFILE[session] || cal.SESSION_PROFILE.regular;
  const liquidityTerm = 2200 / Math.sqrt(Math.max(params.adv, 1));
  const volTerm = 1 + sigmaAnnual * 1.6;
  const raw = liquidityTerm * volTerm * profile.spread;
  // Floor at ~1bp (mega-cap tight) and cap at 250bps (barely tradeable).
  return Math.min(Math.max(raw, 1), 250);
}

/**
 * Builds the visible book around a mid price.
 * Sizes are lognormal around a depth scale derived from ADV, so the ladder
 * looks lumpy and asymmetric like a real one rather than a neat pyramid.
 */
function buildBook(mid, params, tick, session, sigmaAnnual) {
  const bps = spreadBps(params, sigmaAnnual, session);
  const ts = tickSize(mid);
  const half = Math.max(ts / 2, (mid * bps) / 20000);

  const bestBid = roundToTick(mid - half, ts);
  const bestAsk = roundToTick(Math.max(mid + half, bestBid + ts), ts);

  const spacing = Math.max(ts, roundToTick(mid * 0.0006, ts));
  const profile = cal.SESSION_PROFILE[session] || cal.SESSION_PROFILE.regular;
  const baseSize = Math.max(1, (params.adv * 0.0045) / profile.impact);

  const bids = [];
  const asks = [];
  for (let k = 0; k < DEPTH_LEVELS; k++) {
    // Depth thickens away from the touch, with a per-level random kick.
    const grow = 1 + k * 0.55;
    const bidNoise = Math.exp(0.5 * gaussian(params.seed, tick, 20 + k));
    const askNoise = Math.exp(0.5 * gaussian(params.seed, tick, 40 + k));
    bids.push({
      price: round2(Math.max(bestBid - k * spacing, ts)),
      size: Math.max(1, Math.round(baseSize * grow * bidNoise)),
    });
    asks.push({
      price: round2(bestAsk + k * spacing),
      size: Math.max(1, Math.round(baseSize * grow * askNoise)),
    });
  }

  return {
    mid: round2(mid),
    bid: bids[0].price,
    ask: asks[0].price,
    spread: round2(asks[0].price - bids[0].price),
    spreadBps: Math.round(((asks[0].price - bids[0].price) / mid) * 10000),
    bids,
    asks,
  };
}

/**
 * Walks a market order through the ladder.
 *
 * If the order is larger than everything displayed, the remainder still fills —
 * hidden liquidity and refreshing quotes are real — but at a progressively
 * worse price, so oversized orders are punished rather than silently free.
 *
 * @returns {{ filledQty, notional, avgPrice, worstPrice, sweptLevels, deep }}
 */
function walkBook(book, side, qty) {
  const levels = side === "buy" ? book.asks : book.bids;
  let remaining = qty;
  let notional = 0;
  let sweptLevels = 0;
  let worstPrice = levels[0].price;

  for (const level of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, level.size);
    notional += take * level.price;
    remaining -= take;
    worstPrice = level.price;
    sweptLevels++;
  }

  let deep = false;
  if (remaining > 0) {
    // Past the displayed book. Hidden liquidity and refreshing quotes are
    // real, so the remainder does fill — but each extra book's worth of size
    // costs another ~1.2%, capped at 15%. Oversized orders get punished
    // instead of silently sweeping the market for free.
    deep = true;
    const displayed = levels.reduce((s, l) => s + l.size, 0);
    const extraBooks = remaining / Math.max(displayed, 1);
    const slip = Math.min(0.15, 0.012 * (1 + extraBooks));
    const price = worstPrice * (1 + (side === "buy" ? slip : -slip));
    notional += remaining * price;
    worstPrice = price;
    remaining = 0;
  }

  const filledQty = qty - remaining;
  return {
    filledQty,
    notional,
    avgPrice: filledQty > 0 ? notional / filledQty : 0,
    worstPrice,
    sweptLevels,
    deep,
  };
}

/**
 * Square-root price impact of trading `qty` shares.
 * Returns the move in log space, split into the part the market keeps and the
 * part that decays away.
 */
function impactOf(qty, params, sigmaAnnual, session) {
  const profile = cal.SESSION_PROFILE[session] || cal.SESSION_PROFILE.regular;
  const sigmaDaily = sigmaAnnual / Math.sqrt(252);
  const participation = Math.max(qty, 0) / Math.max(params.adv, 1);
  const total = IMPACT_ETA * sigmaDaily * Math.sqrt(participation) * profile.impact;
  // Hard cap so a single whale order can't dislocate a name by more than 20%.
  const capped = Math.min(total, 0.2);
  return {
    total: capped,
    permanent: capped * PERMANENT_IMPACT_SHARE,
    temporary: capped * (1 - PERMANENT_IMPACT_SHARE),
  };
}

/**
 * Applies a fill's impact to simulation state. The permanent part also moves
 * the company's fair value, so mean reversion doesn't immediately undo the
 * information the trade revealed.
 */
function applyImpact(sim, side, impact) {
  const sign = side === "buy" ? 1 : -1;
  const next = { ...sim };
  next.logPrice += sign * impact.total;
  next.fairLog += sign * impact.permanent;
  next.tempImpact = (next.tempImpact || 0) + sign * impact.temporary;
  const price = Math.exp(next.logPrice);
  next.dayHigh = Math.max(next.dayHigh || price, price);
  next.dayLow = Math.min(next.dayLow || price, price);
  return next;
}

/**
 * Commission and fees for a fill. Defaults model a modern low-cost broker:
 * a small percentage commission with a floor, plus a token regulatory fee on
 * sells (the real one is charged to sellers only, which is a nice detail to
 * keep — it makes round-trip costs asymmetric).
 */
function feesFor(notional, side, settings = {}) {
  const commissionBps = settings.commissionBps != null ? settings.commissionBps : 5;
  const minCommission = settings.minCommission != null ? settings.minCommission : 0.5;
  const sellFeeBps = settings.sellFeeBps != null ? settings.sellFeeBps : 1;

  const commission = Math.max((notional * commissionBps) / 10000, notional > 0 ? minCommission : 0);
  const regulatory = side === "sell" ? (notional * sellFeeBps) / 10000 : 0;
  return {
    commission: round2(commission),
    regulatory: round2(regulatory),
    total: round2(commission + regulatory),
  };
}

// Deterministic "prints" — the recent time-and-sales tape shown next to the
// book. Reconstructed from the tick stream rather than stored, so any window
// of the tape can be rebuilt on demand.
function recentPrints(book, params, tick, count = 12) {
  const prints = [];
  for (let i = 0; i < count; i++) {
    const t = tick - i;
    const buy = uniform(params.seed, t, 60) > 0.5;
    const price = buy ? book.ask : book.bid;
    const size = Math.max(1, Math.round(Math.exp(1.1 * gaussian(params.seed, t, 61) + 3)));
    prints.push({ ms: cal.tickToMs(t), price: round2(price), size, side: buy ? "buy" : "sell" });
  }
  return prints;
}

module.exports = {
  DEPTH_LEVELS,
  PERMANENT_IMPACT_SHARE,
  IMPACT_ETA,
  tickSize,
  roundToTick,
  spreadBps,
  buildBook,
  walkBook,
  impactOf,
  applyImpact,
  feesFor,
  recentPrints,
};
