/* ===========================================================================
   DONUT MARKET — services/portfolio.js
   Account valuation and performance.

   The numbers here are the ones a brokerage statement would show, and they are
   deliberately kept apart:

   * **Unrealised P&L** — what the open positions are worth versus what they
     cost, fees included in the cost basis.
   * **Realised P&L** — profit actually booked by selling.
   * **Day change** — today's move only, measured from each position's previous
     close, so a good day still reads as a good day inside a bad month.
   * **Return** — net of any coins an admin handed out, so the leaderboard
     ranks trading rather than generosity.
   =========================================================================== */

const EquitySnapshot = require("../models/EquitySnapshot");

const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Values an account against a set of (already synced) companies.
 *
 * @param {object} user      a User document
 * @param {Array}  companies Company documents covering at least the holdings
 */
function valuate(user, companies) {
  const byTicker = Object.fromEntries(companies.map((c) => [c.ticker, c]));

  const positions = user.holdings
    .filter((h) => h.shares > 0)
    .map((h) => {
      const company = byTicker[h.companyId];
      const price = company ? company.price : 0;
      const prevClose = company ? company.sim?.prevClose || company.openPrice : price;
      const value = h.shares * price;
      const cost = h.shares * h.avgPrice;
      return {
        companyId: h.companyId,
        name: company ? company.name : h.companyId.toUpperCase(),
        icon: company ? company.icon : "🍩",
        sector: company ? company.sector : "—",
        status: company ? company.status : "closed",
        shares: h.shares,
        avgPrice: round2(h.avgPrice),
        price: round2(price),
        prevClose: round2(prevClose),
        value: round2(value),
        cost: round2(cost),
        unrealizedPnl: round2(value - cost),
        unrealizedPct: cost ? ((value - cost) / cost) * 100 : 0,
        dayChange: round2(h.shares * (price - prevClose)),
        dayChangePct: prevClose ? ((price - prevClose) / prevClose) * 100 : 0,
        realizedPnl: round2(h.realizedPnl || 0),
      };
    })
    .sort((a, b) => b.value - a.value);

  const positionsValue = positions.reduce((sum, p) => sum + p.value, 0);
  const cost = positions.reduce((sum, p) => sum + p.cost, 0);
  const netWorth = user.balance + positionsValue;
  const dayChange = positions.reduce((sum, p) => sum + p.dayChange, 0);

  // The yardstick is the starting balance plus anything an admin added or
  // removed since — otherwise a top-up would look like a great trade.
  const invested = (user.startingBalance || 10000) + (user.adminAdjustments || 0);

  // Share of the portfolio each position represents, for the allocation chart.
  for (const p of positions) {
    p.weightPct = netWorth ? (p.value / netWorth) * 100 : 0;
  }

  return {
    cash: round2(user.balance),
    buyingPower: round2(Math.max(0, user.balance - (user.reservedCash || 0))),
    reservedCash: round2(user.reservedCash || 0),
    positions,
    positionsValue: round2(positionsValue),
    positionsCost: round2(cost),
    netWorth: round2(netWorth),
    unrealizedPnl: round2(positionsValue - cost),
    unrealizedPct: cost ? ((positionsValue - cost) / cost) * 100 : 0,
    realizedPnl: round2(user.realizedPnl || 0),
    feesPaid: round2(user.feesPaid || 0),
    dayChange: round2(dayChange),
    dayChangePct: netWorth - dayChange ? (dayChange / (netWorth - dayChange)) * 100 : 0,
    totalReturn: round2(netWorth - invested),
    totalReturnPct: invested ? ((netWorth - invested) / invested) * 100 : 0,
    invested: round2(invested),
  };
}

/**
 * Records a point on the trader's equity curve, at most once every few
 * minutes. Net worth can't be reconstructed after the fact from trades alone,
 * so it has to be sampled while it's happening.
 */
async function recordSnapshot(user, valuation, now = Date.now()) {
  const bucket = new Date(Math.floor(now / SNAPSHOT_INTERVAL_MS) * SNAPSHOT_INTERVAL_MS);
  try {
    await EquitySnapshot.updateOne(
      { user: user._id, t: bucket },
      {
        $set: {
          cash: valuation.cash,
          positionsValue: valuation.positionsValue,
          netWorth: valuation.netWorth,
        },
      },
      { upsert: true }
    );
  } catch (err) {
    // A racing request already wrote this bucket — same numbers, no harm.
    if (err.code !== 11000) throw err;
  }
}

async function equityCurve(userId, limit = 180) {
  const rows = await EquitySnapshot.find({ user: userId })
    .sort({ t: -1 })
    .limit(Math.min(limit, 500))
    .select("t netWorth cash positionsValue -_id")
    .lean();
  return rows.reverse().map((r) => ({
    t: r.t.getTime(),
    v: round2(r.netWorth),
    cash: round2(r.cash),
    positions: round2(r.positionsValue),
  }));
}

module.exports = { valuate, recordSnapshot, equityCurve, SNAPSHOT_INTERVAL_MS };
