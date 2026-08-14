const PriceHistory = require("../models/PriceHistory");

// How often a company "ticks" on its own, and how many ticks we'll ever
// compound into a single request. If a company hasn't been looked at in a
// week, we don't want one giant jump — we cap it and let it catch up a bit
// more on the next request instead.
const TICK_INTERVAL_MS = 60 * 1000; // one ambient tick per minute
const MAX_TICKS_PER_CALL = 20;
const REVERSION_STRENGTH = 0.02; // gentle pull back toward the listing price

// Thinner (lower-liquidity) companies swing more on their own, same
// relationship used for trade price-impact in routes/trade.js.
function volatilityFor(liquidity) {
  return Math.min(Math.max(400 / liquidity, 0.002), 0.03); // 0.2%–3% per tick
}

// Applies any ambient drift a company has "earned" since it was last read,
// persists the new price, and records it in PriceHistory. This is a lazy
// on-read tick rather than a background cron job — the same request that
// asks for a company's price is what advances its clock, so it works
// identically on a free host with no worker process, and two people
// checking at different times still see a consistent, deterministic-on-time
// (aside from the random component) market rather than something that only
// moves when someone happens to trade.
//
// Pass `session` when calling inside a Mongo transaction (see routes/trade.js)
// so the drift and the trade it precedes commit together.
async function applyDrift(company, session) {
  if (company.status !== "open") return false;

  const now = new Date();
  const last = company.lastTickAt || company.createdAt || now;
  const elapsedMs = now - new Date(last);
  const ticksElapsed = Math.floor(elapsedMs / TICK_INTERVAL_MS);
  if (ticksElapsed < 1) return false;

  const ticks = Math.min(ticksElapsed, MAX_TICKS_PER_CALL);
  const vol = volatilityFor(company.liquidity);
  let price = company.price;

  for (let i = 0; i < ticks; i++) {
    const randomPct = (Math.random() - 0.5) * 2 * vol;
    const reversionPct = ((company.openPrice - price) / company.openPrice) * REVERSION_STRENGTH;
    price = Math.max(price * (1 + randomPct + reversionPct), 0.01);
  }

  company.price = price;
  company.lastTickAt = new Date(new Date(last).getTime() + ticks * TICK_INTERVAL_MS);

  await company.save(session ? { session } : undefined);

  if (session) {
    await PriceHistory.create([{ companyId: company.ticker, price: company.price }], { session });
  } else {
    await PriceHistory.create({ companyId: company.ticker, price: company.price });
  }

  return true;
}

module.exports = { applyDrift, TICK_INTERVAL_MS };
