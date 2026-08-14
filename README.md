# 🍩 Donut Market

A simulated stock exchange. Fictional companies, fictional money, and a market
that behaves like a real one.

Most stock-market games move a number up and down at random. This one models
the parts that actually decide whether a trade was any good: you buy at the
offer and sell at the bid, size costs money, orders leave impact behind, and
the market closes at four o'clock.

```bash
cd backend
npm install
npm run dev:memory      # runs everything with a throwaway database, no setup
```

Then open <http://localhost:3000>. That's it — no account, no cluster, no
connection string. For a version that keeps your data, see [SETUP.md](SETUP.md).

---

## What's simulated

**Microstructure.** Every listing quotes a two-sided market with a depth
ladder behind it. A market order walks the book and fills at a volume-weighted
average price that gets worse with size; an order larger than the visible book
pays for the privilege. Spreads widen for thin names, and widen a lot more
outside regular hours.

**Price impact.** Trades move the price by the square-root law observed in real
markets — cost scales with `σ·√(Q/ADV)`, not linearly with share count. Part of
that move is permanent (information the market keeps) and part decays over the
following minutes as liquidity refills.

**The price process.** A market factor pulls the whole exchange around, sector
factors move related names together, and each company adds idiosyncratic noise
on top. Volatility clusters — quiet weeks and violent weeks come in runs.
Prices mean-revert toward a fair value that compounds at the company's drift,
and rare jumps arrive as fat-tailed shocks.

**News that matches the chart.** Every jump the price process produces is
captioned by the news engine from the same deterministic draw, so the wire and
the candles can never disagree. Each gap has a story; each story has a candle.

**Sessions.** Pre-market (4:00), regular hours (9:30–16:00), after-hours (until
20:00), on the NYSE calendar in America/New_York — weekends, holidays and the
1pm half-days included. Extended-hours sessions accept limit orders only, the
way real brokers handle them. Time still passes while the market is shut, and
it comes out as an overnight gap at the open.

**Order types.** Market, limit, stop and stop-limit, day or good-till-cancelled.
Resting orders are matched against the candles the engine produced, so a limit
fills if the market genuinely traded through it — even if nobody was watching.
Cash and shares behind resting orders are reserved, so buying power means what
it says.

**Costs.** Commission with a floor, plus a sell-side regulatory fee, both
configurable. Fees go into the cost basis, so the profit shown is the profit
you'd actually keep.

## How it stays live without a worker

There is no cron job and no background process. The price path is a pure
function of `(company parameters, tick index)`, so whichever request happens to
look at a company is what advances its clock — and it computes the same path a
worker would have. Candles and news are written as the engine passes through
them, and concurrent readers are settled by an optimistic claim on the tick
counter.

That means the market keeps working on free hosting that suspends idle
processes, and two people loading the page a millisecond apart agree on the
price.

## Layout

```
backend/
  engine/        the simulation — pure, deterministic, dependency-free
    rng.js       seeded hash-based randomness
    calendar.js  sessions, holidays, half-days, the tick grid
    price.js     the multi-factor price process and candle generation
    book.js      quotes, depth, slippage, square-root impact, fees
    news.js      headlines generated from the price process's own jumps
  services/      the engine wired to MongoDB (advance, match, value)
  routes/        the HTTP API
  models/        Mongoose schemas
  test/          engine tests — `npm test`, no dependencies
css/, js/, pages/   the frontend, served by the same Express process
```

## API

| Endpoint | What it gives you |
| --- | --- |
| `GET /api/companies` | Every listing with quote, day stats and a sparkline |
| `GET /api/companies/quotes?tickers=` | Just the quotes, for polling |
| `GET /api/companies/:t` | Full detail plus book, tape and fundamentals |
| `GET /api/companies/:t/candles?tf=5m` | OHLCV at 1m / 5m / 15m / 1h / 1d |
| `GET /api/companies/:t/news` | Headlines for one ticker |
| `GET /api/market/status` | Session, next open, exchange mode |
| `GET /api/market/index` | The Donut 500 and its curve |
| `GET /api/market/movers` | Gainers, losers, most active, widest spreads |
| `POST /api/orders/preview` | What an order would cost before you send it |
| `POST /api/orders` | Place market / limit / stop / stop-limit |
| `GET /api/orders` · `DELETE /api/orders/:id` | Resting orders, cancel |
| `GET /api/portfolio` | Valuation, positions, P&L, equity curve |
| `GET /api/leaderboard` | Ranked by net worth, with the detail behind it |
| `GET /api/admin/*` | Run the exchange (admin role required, checked server-side) |

## Tests

```bash
cd backend && npm test
```

Covers the calendar (sessions, holidays, half-days, DST), the determinism and
statistical properties of the price path, and the book's fill mechanics.

---

Donut Coins have no real-world value. This is a simulation for entertainment,
and nothing it produces is financial advice.
