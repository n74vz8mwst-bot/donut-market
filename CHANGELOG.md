# Donut Market — Changelog

This documents the work done to take the project from "prototype with some
fake data" to a realistic, fully backend-driven stock-market simulator.
The stack was preserved throughout: **HTML/CSS/JS frontend, Node + Express
backend, MongoDB Atlas + Mongoose, deployable on Render.** No database swap,
no rewrite.

## Real market statistics
- Added `GET /api/stats` (`backend/routes/stats.js`) computing every homepage
  stat live from MongoDB: total Donut Coins in circulation (all balances +
  live holdings value), companies listed, active traders (distinct users who
  traded in the last 7 days), and trades today (with % change vs yesterday).
- Replaced the four hardcoded stat numbers in `index.html` (previously fixed
  values like "48,290,500 DC" and "12,842 active traders") with values
  fetched from `/api/stats` and animated in. Shows "Unavailable" on error
  rather than fake numbers.

## Real price history and charts
- Added `PriceHistory` model (`backend/models/PriceHistory.js`) — one record
  per price change.
- Every price change now records a history point: trades (`routes/trade.js`),
  admin price edits and news events (`routes/admin.js`), ambient drift, and
  initial listing (`seed.js`).
- Added `GET /api/companies/history/all` (bulk sparkline data) and
  `GET /api/companies/:ticker/history` (per-company detail).
- Stock-card sparklines (`js/main.js`, `js/live.js`) now draw from real
  recorded prices instead of seeded-random placeholder data. A company with
  no trades yet shows a flat line, not invented movement.

## No more silent fake-data fallback
- Rewrote `js/live.js` so `fetchCompanies` / `fetchLeaderboard` / `fetchStats`
  return `{ data, error }` and never fall back to demo arrays.
- Added a persistent error banner with a Retry button (`DM.showErrorBanner` /
  `DM.clearErrorBanner` in `js/main.js`).
- `index.html`, `pages/market.html`, `pages/leaderboard.html`, and
  `pages/portfolio.html` now surface a visible error on API failure instead of
  quietly rendering placeholder data.
- Removed the old mock `DM.data` company/leaderboard/stats arrays from
  `js/main.js` (replaced with empty defaults; they were no longer referenced).

## Realistic between-trade market movement
- Added `backend/utils/marketDrift.js`: a lazy, on-read drift model. When a
  company's price is read, elapsed time since its last update is converted into
  small random ticks with gentle mean-reversion toward the listing price;
  lower-liquidity companies are more volatile. Drift is capped per request so a
  long-idle company catches up gradually instead of jumping. No cron/worker
  required — works on a free host that sleeps.
- Wired into `routes/companies.js` (on read) and `routes/trade.js` (inside the
  trade transaction, so a trade fills at the caught-up price).
- Added a `lastTickAt` field to the `Company` model (hidden from the API).

## Admin: edit balances
- Added `PATCH /api/admin/users/:id/balance` — set an exact balance or apply a
  +/- delta; never allows a negative balance; admin-only.
- Added an "Edit balance" button per trader in the admin users table
  (`pages/admin.html`).

## Admin: real starting-balance setting
- Added `Settings` singleton model (`backend/models/Settings.js`) and
  `GET`/`PATCH /api/admin/settings`.
- Signup (`routes/auth.js`) now uses the configured starting balance, and
  stores it per-user (`User.startingBalance`) so leaderboard profit % stays
  accurate even if the setting changes later.
- The admin Settings tab's "Save settings" button is now wired to the real
  endpoint (was previously a preview-only toast).

## Cleanup
- Removed stale Supabase references from code comments in `js/auth-ui.js` and
  `js/trade-modal.js` (the code already used the Mongo/Express backend; only
  the comments were outdated).
- Updated `SETUP.md` to document all of the above and correct the old
  "falls back to demo data" note.

## Notes / possible future work
- The hero section's animated ticker and background chart on the landing page
  are still decorative random-walk animations (clearly ambient flair, not
  presented as real market data).
- Consider trimming old `PriceHistory` records on a schedule if the collection
  grows large over a long period of live use.

---

# v2 — A real market simulator

The previous version moved prices with a random walk plus a nudge proportional
to order size. This release replaces the whole market model, the trading
mechanics and the frontend. The stack is unchanged: HTML/CSS/JS frontend,
Node + Express, MongoDB + Mongoose, one process serving both.

## The simulation engine (new: `backend/engine/`)

Pure, deterministic, dependency-free modules, unit tested with `npm test`.

- **`rng.js`** — seeded hash-based randomness. Every draw is a pure function of
  (stream, tick, salt), which is what makes the whole market reproducible.
- **`calendar.js`** — the NYSE calendar in America/New_York: pre-market from
  4:00, regular hours 9:30–16:00, after-hours to 20:00, weekends, computed
  holidays (including Good Friday via the Gregorian Easter algorithm and
  weekend-observance shifting) and 1pm half-days. Also the 5-second tick grid
  the whole simulation is defined on. An admin can switch the exchange to 24/7.
- **`price.js`** — a multi-factor price process replacing the random walk:
  a market factor with its own slow drift regime, sector factors, idiosyncratic
  noise, volatility clustering via smooth value noise, mean reversion to a
  compounding fair value, jump diffusion for news, and an overnight gap that
  releases the variance accumulated while the market was shut. Emits 1-minute
  OHLCV candles as it advances, and can deterministically backfill history for
  a brand-new listing.
- **`book.js`** — market microstructure: a two-sided quote with a depth ladder,
  spreads that scale with volatility, liquidity and session; market orders that
  walk the book for a volume-weighted fill; square-root price impact
  (`σ·√(Q/ADV)`) split into permanent and decaying components; and the fee
  schedule.
- **`news.js`** — turns each jump the price process produces into a headline
  from the same deterministic draw, so the wire and the chart always agree.

## Lazy, worker-free advancement

Prices advance on read: whichever request looks at a company moves its clock,
and because the path is pure it computes exactly what a cron job would have.
This survives free hosts suspending idle processes. Concurrent readers are
resolved with an optimistic claim on `sim.tick` so volume is never double
counted.

## Trading

- **Order types**: market, limit, stop and stop-limit, day or GTC. Previously
  only immediate market orders existed.
- **Resting orders** are matched against the candles the engine produced, so a
  limit fills if the market genuinely traded through it, with price improvement
  when the market gapped past it. Settlement runs on every sync, not only when
  new candles appear.
- **Reservations**: resting buys reserve cash and resting sells reserve shares,
  so buying power reflects what's actually spendable.
- **Costs**: commission with a floor plus a sell-side regulatory fee, folded
  into cost basis so P&L is net.
- **Risk limits**: per-order notional cap and per-position concentration cap.
- **Extended hours** accept limit orders only, as real brokers do.
- Trades run in a MongoDB transaction where the deployment supports one, with a
  loud warning and a non-transactional fallback where it doesn't.

## Data model

- `Company` now carries simulation state (`sim`) and per-company parameters
  (volatility, beta, drift, mean reversion, jump intensity, ADV), plus shares
  outstanding for market cap and index weight.
- New `Candle` (1-minute OHLCV, 45-day TTL), `Order`, and `EquitySnapshot`
  (the portfolio's equity curve) collections.
- `Trade` records the reference quote, realised slippage, fees and realised P&L.
- `MarketEvent` is keyed by the tick that produced it, so re-advancing time
  can't double-post a story.
- `PriceHistory` was removed — candles supersede it.

## API

Replaced `POST /api/trade` with `/api/orders` (preview, place, list, cancel).
Added `/api/market/*` (status, index, movers, news, public tape),
`/api/companies/:t/candles` at five timeframes, `/api/companies/quotes` for
polling, and richer portfolio, leaderboard, stats and admin endpoints.

## Frontend

Rewritten. New design system with light and dark themes, a hand-written
canvas charting module (candlesticks, volume, crosshair, index-spaced x-axis so
closed sessions take no width), a per-company **trading terminal** with order
book, time and sales and an order ticket that prices the order before you send
it, a rebuilt market board, a portfolio with equity curve and allocation, and
an admin console for running the exchange. Navigation and footer are rendered
from one shared module instead of being copy-pasted across pages.

## Operations

- `npm run dev:memory` runs the entire app against a throwaway in-memory
  MongoDB replica set with no configuration at all.
- `npm test` runs the engine test suite.
- Security headers and a content-security policy; no inline scripts.
- Free-host awareness: a request still running after six seconds shows a
  "waking up" notice rather than an error.

## Upgrading a live database (fix)

The engine rewrite was verified against a freshly seeded database, which hid a
breaking change: companies created by the previous version have no `sim` state,
and every market read path starts from it. On an existing deployment that threw
on `/api/leaderboard`, `/api/companies`, `/api/stats` and `/api/market/*` — most
of the site at once.

- `services/market.js#ensureSim` repairs a pre-engine company in place on first
  read, initialising simulation state from its stored price and filling in the
  fields added since (`sharesOutstanding`, `listedAt`, `openPrice`).
- `services/migrate.js` runs on startup: `syncIndexes()` on every model (which,
  unlike Mongoose's automatic build, can change the options on an index that
  already exists), then repairs any stale companies and backfills a chart for
  tickers that have no candles, so upgraded listings don't show empty panels.
- `Company.sim` is no longer `required`, so a legacy document can be loaded and
  saved while it's being repaired.
- The `MarketEvent` uniqueness constraint is now partial (`tick` must be a
  number) rather than sparse. A sparse compound index stored admin-published
  headlines as `tick: null`, so a second manual headline about the same company
  collided with the first.
- Missing static assets now return 404 instead of the homepage with a 200,
  and HTML/JS/CSS are served `no-cache`, so a deploy isn't shadowed by a stale
  cached copy.
- `backend/test/migration.test.js` builds a database in the old shape — raw
  documents inserted underneath Mongoose — and covers all of the above.
