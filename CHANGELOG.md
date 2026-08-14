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
