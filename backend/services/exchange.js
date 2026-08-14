/* ===========================================================================
   DONUT MARKET — services/exchange.js
   The one call every route makes before it reads a price.

   "Syncing" a company means two things that always belong together: advance
   its simulated clock to now, then run every resting order on the ticker
   against the candles that produced. Doing them separately is how you end up
   with a limit order that should have filled an hour ago still sitting there.

   Settlement can't be skipped just because no new candle was produced, either:
   a price can move between bars (another trader's impact, an admin marking the
   price) and a resting order has to see that too. So the check always runs —
   but for multi-company loads it's driven by a single query that asks which
   tickers have anything resting at all, rather than one query per listing.
   =========================================================================== */

const Company = require("../models/Company");
const Order = require("../models/Order");
const market = require("./market");
const orders = require("./orders");
const settingsService = require("./settings");
const { sessionOpts } = require("./db");

async function syncCompany(company, options = {}) {
  const settings = options.settings || (await settingsService.get());
  const now = options.now || Date.now();

  const { bars } = await market.advanceCompany(company, { ...options, settings, now });
  await orders.settleResting(company, bars, { ...options, settings, now });
  return company;
}

async function syncAll(companies, options = {}) {
  const settings = options.settings || (await settingsService.get());
  const now = options.now || Date.now();
  if (!companies.length) return companies;

  const barsByTicker = new Map();
  for (const company of companies) {
    const { bars } = await market.advanceCompany(company, { ...options, settings, now });
    barsByTicker.set(company.ticker, bars);
  }

  // One query for the whole batch: which of these tickers has anything resting?
  const active = await Order.distinct(
    "ticker",
    { ticker: { $in: companies.map((c) => c.ticker) }, status: { $in: ["open", "triggered"] } },
    sessionOpts(options.session)
  );
  if (!active.length) return companies;

  const activeSet = new Set(active);
  for (const company of companies) {
    if (!activeSet.has(company.ticker)) continue;
    await orders.settleResting(company, barsByTicker.get(company.ticker) || [], { ...options, settings, now });
  }

  return companies;
}

// Loads every listing and brings the whole market current. Used by the list
// endpoints, the index, and the homepage statistics.
async function loadMarket(options = {}) {
  const companies = await Company.find(options.filter || {}).sort({ ticker: 1 });
  await syncAll(companies, options);
  return companies;
}

// Loads one ticker and brings it current, or returns null if it isn't listed.
async function loadTicker(ticker, options = {}) {
  const company = await Company.findOne({ ticker: String(ticker || "").toLowerCase() });
  if (!company) return null;
  await syncCompany(company, options);
  return company;
}

module.exports = { syncCompany, syncAll, loadMarket, loadTicker };
