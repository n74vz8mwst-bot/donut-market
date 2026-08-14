const express = require("express");
const Order = require("../models/Order");
const User = require("../models/User");
const cal = require("../engine/calendar");
const book = require("../engine/book");
const exchange = require("../services/exchange");
const market = require("../services/market");
const orderService = require("../services/orders");
const settingsService = require("../services/settings");
const { withTransaction } = require("../services/db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// The client may speak either dialect: the old { companyId, type: 'buy' } or
// the current { ticker, side, type: 'limit' }.
function readOrderInput(body) {
  const side = (body.side || body.type || "").toLowerCase();
  const type = (body.orderType || (["buy", "sell"].includes(body.type) ? "market" : body.type) || "market").toLowerCase();
  return {
    ticker: String(body.ticker || body.companyId || "").toLowerCase(),
    side: side === "sell" ? "sell" : "buy",
    type,
    qty: Number(body.qty != null ? body.qty : body.shares),
    limitPrice: body.limitPrice != null && body.limitPrice !== "" ? Number(body.limitPrice) : null,
    stopPrice: body.stopPrice != null && body.stopPrice !== "" ? Number(body.stopPrice) : null,
    tif: body.tif === "gtc" ? "gtc" : "day",
  };
}

/**
 * POST /api/orders/preview
 * What this order would cost if you sent it right now — the expected fill
 * price after walking the book, the slippage against the mid, the commission,
 * and whether you can actually afford it. No state changes.
 */
router.post("/preview", requireAuth, async (req, res) => {
  try {
    const input = readOrderInput(req.body);
    const settings = await settingsService.get();
    const company = await exchange.loadTicker(input.ticker, { settings });
    if (!company) return res.status(404).json({ error: "Company not found." });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "User not found." });

    const now = Date.now();
    const sessionInfo = cal.sessionAt(now, settings.marketMode);
    const params = market.paramsFor(company);
    const sigma = market.liveVol(company, params, cal.tickAt(now));
    const ladder = book.buildBook(company.price, params, cal.tickAt(now), sessionInfo.session, sigma);

    const qty = Math.max(0, Math.floor(input.qty || 0));
    const walk = qty > 0 ? book.walkBook(ladder, input.side, qty) : null;

    let expectedPrice = input.type === "market" || !input.limitPrice ? (walk ? walk.avgPrice : ladder.mid) : input.limitPrice;
    if (input.type === "limit" && input.limitPrice) {
      expectedPrice =
        input.side === "buy" ? Math.min(input.limitPrice, walk ? walk.avgPrice : ladder.ask) : Math.max(input.limitPrice, walk ? walk.avgPrice : ladder.bid);
    }

    const notional = expectedPrice * qty;
    const fees = book.feesFor(notional, input.side, settings);
    const impact = book.impactOf(qty, params, sigma, sessionInfo.session);
    const holding = user.holdings.find((h) => h.companyId === company.ticker);
    const reservedShares = await orderService.reservedSharesFor(user._id, company.ticker, null);

    res.json({
      ticker: company.ticker,
      side: input.side,
      type: input.type,
      qty,
      quote: { bid: ladder.bid, ask: ladder.ask, mid: ladder.mid, spread: ladder.spread, spread_bps: ladder.spreadBps },
      expected_price: Math.round(expectedPrice * 100) / 100,
      notional: Math.round(notional * 100) / 100,
      fees,
      total: Math.round((input.side === "buy" ? notional + fees.total : notional - fees.total) * 100) / 100,
      slippage_pct: ladder.mid ? ((expectedPrice - ladder.mid) / ladder.mid) * 100 : 0,
      estimated_impact_pct: (Math.exp(impact.total) - 1) * 100,
      sweeps_levels: walk ? walk.sweptLevels : 0,
      beyond_book: walk ? walk.deep : false,
      buying_power: Math.max(0, user.balance - (user.reservedCash || 0)),
      shares_available: Math.max(0, (holding ? holding.shares : 0) - reservedShares),
      session: sessionInfo.session,
      is_open: sessionInfo.isOpen,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not price that order." });
  }
});

/**
 * POST /api/orders
 * Places an order. Market orders (and marketable limits) fill immediately;
 * limits and stops rest until the market reaches them.
 */
router.post("/", requireAuth, async (req, res) => {
  const input = readOrderInput(req.body);
  try {
    const settings = await settingsService.get();

    const result = await withTransaction(async (session) => {
      const company = await exchange.loadTicker(input.ticker, { settings, session });
      if (!company) throw Object.assign(new Error("Company not found."), { status: 404 });

      const user = await User.findById(req.userId, null, session ? { session } : {});
      if (!user) throw Object.assign(new Error("User not found."), { status: 404 });

      const placed = await orderService.placeOrder({ ...input, user, company, settings, session });
      const quote = market.quoteFor(company, { settings });
      return { placed, user, quote };
    });

    const { placed, user, quote } = result;
    res.status(placed.resting ? 202 : 200).json({
      success: true,
      resting: placed.resting,
      order: placed.order.toJSON(),
      fill: placed.fill
        ? {
            shares: placed.order.filledQty,
            price: placed.fill.avgPrice,
            notional: placed.fill.notional,
            fees: placed.fill.fees,
            total: placed.order.side === "buy" ? placed.fill.notional + placed.fill.fees.total : placed.fill.notional - placed.fill.fees.total,
            reference_price: placed.fill.referencePrice,
            slippage_pct: placed.fill.referencePrice
              ? ((placed.fill.avgPrice - placed.fill.referencePrice) / placed.fill.referencePrice) * 100
              : 0,
            realized_pnl: placed.fill.realizedPnl,
            impact_pct: placed.fill.impactPct,
          }
        : null,
      balance: user.balance,
      buying_power: Math.max(0, user.balance - (user.reservedCash || 0)),
      quote,
    });
  } catch (err) {
    const status = err.status || 400;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || "Order failed." });
  }
});

// GET /api/orders — resting orders by default, ?status=all for the full log.
router.get("/", requireAuth, async (req, res) => {
  try {
    // Sync the tickers this trader has orders on, so anything that should have
    // filled by now has filled before we report it.
    const settings = await settingsService.get();
    const openOrders = await Order.find({ user: req.userId, status: { $in: ["open", "triggered"] } }).select("ticker");
    const tickers = [...new Set(openOrders.map((o) => o.ticker))];
    if (tickers.length) await exchange.loadMarket({ settings, filter: { ticker: { $in: tickers } } });

    const filter = { user: req.userId };
    if (req.query.status !== "all") filter.status = { $in: ["open", "triggered"] };

    const orders = await Order.find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(parseInt(req.query.limit, 10) || 50, 200));

    res.json(orders.map((o) => o.toJSON()));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load orders." });
  }
});

// DELETE /api/orders/:id — cancel a resting order and release its reservation.
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const order = await withTransaction(async (session) => {
      const user = await User.findById(req.userId, null, session ? { session } : {});
      if (!user) throw Object.assign(new Error("User not found."), { status: 404 });
      return orderService.cancelOrder(user, req.params.id, session);
    });
    res.json({ success: true, order: order.toJSON() });
  } catch (err) {
    const status = err.status || 400;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || "Could not cancel that order." });
  }
});

module.exports = router;
