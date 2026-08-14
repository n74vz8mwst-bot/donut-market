/* ===========================================================================
   DONUT MARKET — services/orders.js
   The matching engine: what happens when someone actually trades.

   A market order walks the book and fills at a volume-weighted price that gets
   worse with size (engine/book.js), pays commission, and leaves impact behind.
   A limit or stop order doesn't fill at all until the market comes to it — it
   rests here, and every time that company's clock is advanced the candles it
   just printed are checked against every resting order on the ticker. So a
   limit placed overnight fills at the open if the market gapped through it,
   whether or not anyone was watching.

   Cash and shares behind resting orders are reserved, so buying power is what
   you can actually spend rather than what you'd have if you cancelled
   everything first.
   =========================================================================== */

const Company = require("../models/Company");
const Order = require("../models/Order");
const Trade = require("../models/Trade");
const User = require("../models/User");
const cal = require("../engine/calendar");
const book = require("../engine/book");
const market = require("./market");
const { sessionOpts } = require("./db");

// Resting buy orders reserve a little more than the limit price implies, so a
// fill that lands with fees on top can't overdraw the account.
const RESERVE_BUFFER = 1.01;

class OrderError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const round2 = (n) => Math.round(n * 100) / 100;

// --- Validation ------------------------------------------------------------

function assertTradable(company, sessionInfo, settings, type) {
  if (company.status === "halted") {
    throw new OrderError(`${company.name} is halted — trading is suspended.`);
  }
  if (company.status !== "open") {
    throw new OrderError(`${company.name} is not currently listed for trading.`);
  }
  if (!sessionInfo.isOpen) {
    const next = cal.nextOpen(Date.now(), settings.marketMode);
    const when = next ? new Date(next).toLocaleString("en-US", { timeZone: cal.TZ }) : "soon";
    throw new OrderError(`The market is closed. Next open: ${when} ET.`);
  }
  // Extended-hours sessions have no market makers obliged to quote, so real
  // brokers only accept limit orders then. Same rule here.
  if (sessionInfo.session !== "regular" && type === "market") {
    throw new OrderError("Market orders aren't accepted outside regular hours — use a limit order.");
  }
  if (sessionInfo.session !== "regular" && !settings.allowExtendedHours) {
    throw new OrderError("Extended-hours trading is disabled on this exchange.");
  }
}

// Shares already promised to other resting sell orders on the same ticker.
async function reservedSharesFor(userId, ticker, session, excludeOrderId = null) {
  const filter = { user: userId, ticker, side: "sell", status: { $in: ["open", "triggered"] } };
  if (excludeOrderId) filter._id = { $ne: excludeOrderId };
  const open = await Order.find(filter).select("qty filledQty").lean(sessionOpts(session));
  return open.reduce((sum, o) => sum + (o.qty - (o.filledQty || 0)), 0);
}

// --- Fills -----------------------------------------------------------------

/**
 * Executes a fill against the current book and books every consequence of it:
 * cash, holdings, cost basis, realised P&L, fees, the trade record, and the
 * price impact the order leaves on the market.
 */
async function executeFill(ctx) {
  const { user, company, side, qty, orderDoc, orderType, settings, now, session, limitPrice } = ctx;

  const params = market.paramsFor(company);
  const tick = cal.tickAt(now);
  const sessionInfo = cal.sessionAt(now, settings.marketMode);
  const sigma = market.liveVol(company, params, tick);
  const ladder = book.buildBook(company.price, params, tick, sessionInfo.session, sigma);
  const referencePrice = ladder.mid;

  // Resting limit orders fill at their limit (or better, if the market gapped
  // through it). Market orders take whatever the ladder gives them.
  let avgPrice;
  let notional;
  if (ctx.fillPrice != null) {
    avgPrice = ctx.fillPrice;
    notional = avgPrice * qty;
  } else {
    const walk = book.walkBook(ladder, side, qty);
    avgPrice = walk.avgPrice;
    notional = walk.notional;
    // A marketable limit order never fills worse than its limit.
    if (limitPrice != null) {
      if (side === "buy" && avgPrice > limitPrice) {
        avgPrice = limitPrice;
        notional = avgPrice * qty;
      }
      if (side === "sell" && avgPrice < limitPrice) {
        avgPrice = limitPrice;
        notional = avgPrice * qty;
      }
    }
  }

  avgPrice = round2(avgPrice);
  notional = round2(avgPrice * qty);
  const fees = book.feesFor(notional, side, settings);

  const holding = user.holdings.find((h) => h.companyId === company.ticker);
  let realizedPnl = 0;

  if (side === "buy") {
    const cost = notional + fees.total;
    // Any reservation belonging to *this* order has already been released by
    // the caller, so what's left committed belongs to other resting orders.
    const available = user.balance - (user.reservedCash || 0);
    if (cost > available + 1e-6) {
      throw new OrderError(
        `Not enough buying power: this order costs ${cost.toFixed(2)} DC and you have ${Math.max(available, 0).toFixed(2)} DC available.`
      );
    }
    user.balance = round2(user.balance - cost);
    if (holding) {
      const newShares = holding.shares + qty;
      // Cost basis carries the fees, so P&L is measured against what the
      // position really cost rather than the price on the screen.
      holding.avgPrice = (holding.shares * holding.avgPrice + cost) / newShares;
      holding.shares = newShares;
    } else {
      user.holdings.push({
        companyId: company.ticker,
        shares: qty,
        avgPrice: cost / qty,
        realizedPnl: 0,
        firstBoughtAt: new Date(now),
      });
    }
  } else {
    const owned = holding ? holding.shares : 0;
    const reserved = ctx.reservedShares || 0;
    if (owned - reserved < qty - 1e-9) {
      throw new OrderError(
        `You only have ${Math.max(owned - reserved, 0)} share(s) of ${company.name} available to sell.`
      );
    }
    const proceeds = notional - fees.total;
    realizedPnl = round2(proceeds - qty * holding.avgPrice);
    user.balance = round2(user.balance + proceeds);
    holding.shares = round2(holding.shares - qty);
    holding.realizedPnl = round2((holding.realizedPnl || 0) + realizedPnl);
    if (holding.shares <= 1e-9) {
      user.holdings = user.holdings.filter((h) => h.companyId !== company.ticker);
    }
  }

  user.realizedPnl = round2((user.realizedPnl || 0) + realizedPnl);
  user.feesPaid = round2((user.feesPaid || 0) + fees.total);
  user.tradeCount = (user.tradeCount || 0) + 1;

  // The trade moves the market: square-root impact, part of which the market
  // keeps and part of which decays over the next few minutes.
  const impact = book.impactOf(qty, params, sigma, sessionInfo.session);
  const nextSim = book.applyImpact(company.sim.toObject ? company.sim.toObject() : company.sim, side, impact);
  company.sim = nextSim;
  company.price = round2(Math.exp(nextSim.logPrice));

  await Company.updateOne(
    { _id: company._id },
    { $set: { sim: nextSim, price: company.price } },
    sessionOpts(session)
  );

  const [trade] = await Trade.create(
    [
      {
        user: user._id,
        order: orderDoc ? orderDoc._id : null,
        companyId: company.ticker,
        companyName: company.name,
        companyIcon: company.icon,
        type: side,
        orderType,
        shares: qty,
        price: avgPrice,
        referencePrice,
        slippagePct: referencePrice ? ((avgPrice - referencePrice) / referencePrice) * 100 : 0,
        fees: fees.total,
        total: round2(side === "buy" ? notional + fees.total : notional - fees.total),
        realizedPnl,
        session: sessionInfo.session,
      },
    ],
    sessionOpts(session)
  );

  return {
    avgPrice,
    notional,
    fees,
    realizedPnl,
    referencePrice,
    impactPct: (Math.exp(impact.total) - 1) * 100 * (side === "buy" ? 1 : -1),
    newPrice: company.price,
    trade,
  };
}

// --- Placing orders --------------------------------------------------------

/**
 * Validates and places an order. Market orders (and marketable limits) fill
 * immediately; everything else is stored and waits for the market.
 */
async function placeOrder(input) {
  const { user, company, settings, session } = input;
  const now = input.now || Date.now();
  const side = input.side;
  const type = input.type || "market";
  const tif = input.tif || (type === "market" ? "day" : "gtc");

  const qty = Number(input.qty);
  if (!Number.isFinite(qty) || qty <= 0) throw new OrderError("Enter a positive number of shares.");
  if (Math.abs(qty - Math.round(qty)) > 1e-9) throw new OrderError("Donut Market trades whole shares only.");
  if (!["buy", "sell"].includes(side)) throw new OrderError("Side must be buy or sell.");
  if (!["market", "limit", "stop", "stop_limit"].includes(type)) throw new OrderError("Unknown order type.");

  const sessionInfo = cal.sessionAt(now, settings.marketMode);
  assertTradable(company, sessionInfo, settings, type);

  const limitPrice = input.limitPrice != null ? round2(Number(input.limitPrice)) : null;
  const stopPrice = input.stopPrice != null ? round2(Number(input.stopPrice)) : null;

  if ((type === "limit" || type === "stop_limit") && !(limitPrice > 0)) {
    throw new OrderError("A limit order needs a limit price.");
  }
  if ((type === "stop" || type === "stop_limit") && !(stopPrice > 0)) {
    throw new OrderError("A stop order needs a stop price.");
  }

  const params = market.paramsFor(company);
  const tick = cal.tickAt(now);
  const sigma = market.liveVol(company, params, tick);
  const ladder = book.buildBook(company.price, params, tick, sessionInfo.session, sigma);

  // Stops have to be placed on the far side of the market — a buy stop below
  // the current price would trigger instantly, which is never what was meant.
  if (stopPrice != null) {
    if (side === "buy" && stopPrice <= ladder.ask) {
      throw new OrderError(`A buy stop must be above the current offer (${ladder.ask.toFixed(2)} DC).`);
    }
    if (side === "sell" && stopPrice >= ladder.bid) {
      throw new OrderError(`A sell stop must be below the current bid (${ladder.bid.toFixed(2)} DC).`);
    }
  }

  const estimatedPrice = limitPrice != null ? limitPrice : side === "buy" ? ladder.ask : ladder.bid;
  const notional = estimatedPrice * qty;
  if (notional > settings.maxOrderNotional) {
    throw new OrderError(
      `Order too large: the per-order limit is ${settings.maxOrderNotional.toLocaleString("en-US")} DC.`
    );
  }

  const reservedShares = side === "sell" ? await reservedSharesFor(user._id, company.ticker, session) : 0;

  if (side === "sell") {
    const holding = user.holdings.find((h) => h.companyId === company.ticker);
    const available = (holding ? holding.shares : 0) - reservedShares;
    if (available < qty) {
      throw new OrderError(
        `You only have ${Math.max(available, 0)} share(s) of ${company.name} available to sell.` +
          (reservedShares > 0 ? ` (${reservedShares} are committed to resting orders.)` : "")
      );
    }
  }

  // Position concentration limit, checked against net worth the same way a
  // broker checks it against account equity.
  if (side === "buy" && settings.maxPositionPct < 100) {
    const holding = user.holdings.find((h) => h.companyId === company.ticker);
    const existingValue = (holding ? holding.shares : 0) * company.price;
    const netWorth = await estimateNetWorth(user, session);
    const cap = (netWorth * settings.maxPositionPct) / 100;
    if (existingValue + notional > cap) {
      throw new OrderError(
        `Position limit: no single holding may exceed ${settings.maxPositionPct}% of your net worth.`
      );
    }
  }

  const marketable =
    type === "market" ||
    (type === "limit" && side === "buy" && limitPrice >= ladder.ask) ||
    (type === "limit" && side === "sell" && limitPrice <= ladder.bid);

  const orderDoc = new Order({
    user: user._id,
    ticker: company.ticker,
    side,
    type,
    qty,
    limitPrice,
    stopPrice,
    tif,
    status: "open",
    placedDayKey: sessionInfo.dayKey,
  });

  if (marketable) {
    const fill = await executeFill({
      user,
      company,
      side,
      qty,
      orderDoc,
      orderType: type,
      settings,
      now,
      session,
      limitPrice: type === "limit" ? limitPrice : null,
      reservedShares,
    });

    orderDoc.status = "filled";
    orderDoc.filledQty = qty;
    orderDoc.avgFillPrice = fill.avgPrice;
    orderDoc.fees = fill.fees.total;
    orderDoc.filledAt = new Date(now);
    orderDoc.closedAt = new Date(now);

    await orderDoc.save(sessionOpts(session));
    await user.save(sessionOpts(session));

    return { order: orderDoc, fill, resting: false };
  }

  // Resting: commit the cash or the shares so they can't be spent twice.
  if (side === "buy") {
    const reserve = round2(notional * RESERVE_BUFFER);
    const available = user.balance - (user.reservedCash || 0);
    if (reserve > available) {
      throw new OrderError(
        `Not enough buying power to reserve this order: it needs ${reserve.toFixed(2)} DC and you have ${Math.max(available, 0).toFixed(2)} DC available.`
      );
    }
    orderDoc.reservedCash = reserve;
    user.reservedCash = round2((user.reservedCash || 0) + reserve);
  } else {
    orderDoc.reservedShares = qty;
  }

  await orderDoc.save(sessionOpts(session));
  await user.save(sessionOpts(session));

  return { order: orderDoc, fill: null, resting: true };
}

// Net worth without a full portfolio join — good enough for a risk check.
async function estimateNetWorth(user, session) {
  const tickers = user.holdings.map((h) => h.companyId);
  if (!tickers.length) return user.balance;
  const companies = await Company.find({ ticker: { $in: tickers } })
    .select("ticker price")
    .lean(sessionOpts(session));
  const prices = Object.fromEntries(companies.map((c) => [c.ticker, c.price]));
  return user.holdings.reduce((sum, h) => sum + h.shares * (prices[h.companyId] || 0), user.balance);
}

async function cancelOrder(user, orderId, session) {
  const order = await Order.findOne({ _id: orderId, user: user._id }, null, sessionOpts(session));
  if (!order) throw new OrderError("Order not found.", 404);
  if (!["open", "triggered"].includes(order.status)) {
    throw new OrderError(`That order is already ${order.status}.`);
  }

  if (order.side === "buy" && order.reservedCash) {
    user.reservedCash = round2(Math.max(0, (user.reservedCash || 0) - order.reservedCash));
    await user.save(sessionOpts(session));
  }

  order.status = "cancelled";
  order.reservedCash = 0;
  order.reservedShares = 0;
  order.closedAt = new Date();
  await order.save(sessionOpts(session));
  return order;
}

// --- Resting order settlement ---------------------------------------------

// Did this bar trade through the order's trigger? Uses the bar's true high and
// low, so a wick that touched the level counts — the same way it would on a
// real exchange.
function barTouches(order, bar) {
  if (order.type === "limit") {
    return order.side === "buy" ? bar.l <= order.limitPrice : bar.h >= order.limitPrice;
  }
  if (order.type === "stop" || order.type === "stop_limit") {
    return order.side === "buy" ? bar.h >= order.stopPrice : bar.l <= order.stopPrice;
  }
  return false;
}

/**
 * Runs every resting order on a ticker against the candles the engine just
 * produced. Called right after a company is advanced, which is what makes
 * limit orders fill on time even when nobody is looking at the screen.
 */
async function settleResting(company, bars, options = {}) {
  const settings = options.settings;
  const now = options.now || Date.now();
  const session = options.session || null;
  if (company.status !== "open") return [];

  const open = await Order.find(
    { ticker: company.ticker, status: { $in: ["open", "triggered"] } },
    null,
    sessionOpts(session)
  );
  if (!open.length) return [];

  const sessionInfo = cal.sessionAt(now, settings.marketMode);
  const results = [];
  if (process.env.DM_DEBUG_ORDERS) {
    console.log("[settle]", company.ticker, "price", company.price, "bars", bars.length, "open", open.length);
  }

  for (const order of open) {
    // Day orders die at the end of the trading day they were placed in.
    if (order.tif === "day" && order.placedDayKey && sessionInfo.dayKey && order.placedDayKey !== sessionInfo.dayKey) {
      await releaseAndClose(order, "expired", "Day order expired at the close.", session);
      results.push({ order, expired: true });
      continue;
    }

    const hasLimit = order.type === "limit" || order.type === "stop_limit";
    const limitTouched = (bar) =>
      order.side === "buy" ? bar.l <= order.limitPrice : bar.h >= order.limitPrice;

    // Walk the bars in order. A stop has to be triggered by an earlier bar
    // before its limit (if any) can fill on a later one — the sequence matters,
    // which is exactly why we replay bars instead of only looking at the last
    // price.
    let triggerBar = null;
    for (const bar of bars) {
      if (order.status === "open" && (order.type === "stop" || order.type === "stop_limit")) {
        if (!barTouches(order, bar)) continue;
        order.status = "triggered";
      }
      if (hasLimit) {
        if (limitTouched(bar)) {
          triggerBar = bar;
          break;
        }
      } else if (order.status === "triggered") {
        triggerBar = bar; // plain stop: becomes a market order
        break;
      }
    }

    // The bars may have missed it: another trader's price impact moves the
    // price between bars, so check the live price too.
    if (!triggerBar) {
      const priceNow = company.price;
      const live = { o: priceNow, h: priceNow, l: priceNow, c: priceNow };
      if (order.status === "open" && (order.type === "stop" || order.type === "stop_limit") && barTouches(order, live)) {
        order.status = "triggered";
      }
      if (hasLimit) {
        // A limit rests until the price reaches it; a stop-limit has to have
        // been triggered first.
        const active = order.type === "limit" || order.status === "triggered";
        if (active && limitTouched(live)) triggerBar = live;
      } else if (order.status === "triggered") {
        triggerBar = live;
      }
    }

    if (process.env.DM_DEBUG_ORDERS) {
      console.log("  [order]", order.type, order.side, order.qty, "limit", order.limitPrice, "stop", order.stopPrice,
        "status", order.status, "trigger", Boolean(triggerBar));
    }

    if (!triggerBar) {
      if (order.isModified()) await order.save(sessionOpts(session));
      continue;
    }

    const owner = await User.findById(order.user, null, sessionOpts(session));
    if (!owner) {
      await releaseAndClose(order, "cancelled", "Account no longer exists.", session);
      continue;
    }

    // Price improvement: if the market gapped past the limit, the fill happens
    // at the better price the market actually opened at, not the limit.
    let fillPrice = null;
    if (order.type === "limit" || order.type === "stop_limit") {
      const limit = order.limitPrice;
      const open0 = triggerBar ? triggerBar.o : company.price;
      fillPrice = order.side === "buy" ? Math.min(limit, open0) : Math.max(limit, open0);
    }

    try {
      const reservedShares = await reservedSharesFor(owner._id, company.ticker, session, order._id);
      // Release this order's own reservation before the fill checks funds.
      const releaseCash = order.side === "buy" ? order.reservedCash : 0;
      if (releaseCash) {
        owner.reservedCash = round2(Math.max(0, (owner.reservedCash || 0) - releaseCash));
      }

      const fill = await executeFill({
        user: owner,
        company,
        side: order.side,
        qty: order.qty - (order.filledQty || 0),
        orderDoc: order,
        orderType: order.type,
        settings,
        now,
        session,
        limitPrice: order.type === "stop" ? null : order.limitPrice,
        fillPrice,
        reservedShares,
        releaseCash,
      });

      order.status = "filled";
      order.filledQty = order.qty;
      order.avgFillPrice = fill.avgPrice;
      order.fees = fill.fees.total;
      order.filledAt = new Date(now);
      order.closedAt = new Date(now);
      order.reservedCash = 0;
      order.reservedShares = 0;
      await order.save(sessionOpts(session));
      await owner.save(sessionOpts(session));
      results.push({ order, fill });
    } catch (err) {
      // The account can't honour it any more (cash spent, shares sold
      // elsewhere). Reject the order rather than letting it hang forever.
      // releaseAndClose gives the reservation back on the database copy — the
      // in-memory `owner` we mutated above is simply discarded.
      await releaseAndClose(order, "rejected", err.message, session);
      results.push({ order, error: err.message });
    }
  }

  return results;
}

async function releaseAndClose(order, status, note, session) {
  if (order.side === "buy" && order.reservedCash) {
    await User.updateOne({ _id: order.user }, { $inc: { reservedCash: -order.reservedCash } }, sessionOpts(session));
  }
  order.status = status;
  order.note = note;
  order.reservedCash = 0;
  order.reservedShares = 0;
  order.closedAt = new Date();
  await order.save(sessionOpts(session));
}

module.exports = {
  OrderError,
  placeOrder,
  cancelOrder,
  settleResting,
  executeFill,
  reservedSharesFor,
};
