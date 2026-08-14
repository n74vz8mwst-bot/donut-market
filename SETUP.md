# Donut Market — Setup & Deployment

Two ways to run it. Start with the first one.

---

## 1. Run it right now (no database, no accounts)

```bash
cd backend
npm install
npm run dev:memory
```

Open <http://localhost:3000>.

This boots a real MongoDB in a temporary folder — as a single-node replica set,
so trades still run in proper transactions — seeds twelve companies with ten
days of backfilled candles, creates an admin account, and starts the server
against it. The first run downloads the database binary (~90 MB); after that
it's instant.

It prints the admin login on startup:

```
🔑  Admin login: admin@donut.market / donutdonut
```

Everything is thrown away when you stop it. Use this for trying the simulator
and for development.

---

## 2. Run it for real (MongoDB Atlas)

Use this when you want the market to persist.

### Create the database

1. Sign up at <https://www.mongodb.com/cloud/atlas/register> and create a free
   **M0** cluster.
2. **Database Access** → add a database user with a username and password.
3. **Network Access** → **Add IP Address** → **Allow Access From Anywhere**
   (`0.0.0.0/0`). A free host's outbound IP isn't fixed, so a narrower rule
   will lock you out.
4. **Database** → **Connect** → **Drivers** → copy the connection string, and
   put a database name in the path:

   ```
   mongodb+srv://user:password@cluster0.xxxxx.mongodb.net/donutmarket?retryWrites=true&w=majority
   ```

Atlas gives you a replica set, which is what lets order placement run inside a
transaction. A bare standalone `mongod` doesn't — the server will still run,
but it warns on startup that a crash mid-order could leave it half-applied.

### Configure and seed

Create `backend/.env` from the example:

```
MONGODB_URI=mongodb+srv://…/donutmarket?retryWrites=true&w=majority
JWT_SECRET=a-long-random-string
PORT=3000
```

Generate a real secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then:

```bash
cd backend
npm install
npm run seed        # lists the starting companies with backfilled history
npm run dev         # http://localhost:3000
```

`npm run seed` is safe to re-run — it skips tickers that already exist.
`npm run seed:reset` wipes companies, candles and news and starts over,
and also creates an admin account if there isn't one.

### Make yourself an admin

Sign up on the site first, then in Atlas: **Database → Browse Collections →
donutmarket → users**, find your document, change `"role": "trader"` to
`"role": "admin"`, and save. Reload `/pages/admin.html`.

Or just run `npm run seed:reset`, which creates `admin@donut.market`.

---

## Deploying to a free host

The Express server serves the frontend too, so one service runs the whole site.

**Render** (or Railway, Fly, anything similar):

| Setting | Value |
| --- | --- |
| Root directory | `backend` |
| Build command | `npm install` |
| Start command | `npm start` |
| Environment | `MONGODB_URI`, `JWT_SECRET` |

Notes that matter on a free tier:

- **The instance sleeps.** Free hosts suspend a service that hasn't had traffic
  for a while, and the next request waits 30–60 seconds for it to wake. The
  site handles this: any request still running after six seconds shows a
  "waking the exchange up" notice instead of looking broken. If a page seems to
  hang on first load, that's what's happening.
- **The market doesn't stop while it sleeps.** Prices advance lazily from the
  tick grid, so when the server wakes it catches up to exactly the path it
  would have taken had it been running the whole time. No worker needed.
- **Redeploy after pulling changes.** The host runs whatever commit it last
  built — a fixed bug locally is still broken in production until you push and
  it rebuilds.
- **Dev dependencies are skipped.** Hosts set `NODE_ENV=production`, so the
  in-memory database used by `dev:memory` isn't installed there, and its
  binary download is disabled in `package.json` regardless.
- **Storage.** Minute candles expire after 45 days automatically, and equity
  snapshots after a year, so an M0 cluster won't fill up.

---

## Running the exchange

The admin console (`/pages/admin.html`) is where the market gets managed.
Every endpoint behind it re-checks your role server-side.

- **Listings** — list a company, tune its volatility, beta, drift, news
  intensity and average daily volume, mark a price by hand, or halt trading.
  A halt is a real circuit breaker: quotes freeze and orders are rejected.
- **News wire** — publish a headline, optionally with a price shock. The shock
  moves fair value along with the price, so it sticks instead of being pulled
  straight back by mean reversion.
- **Exchange rules** — starting balance, commission and fees, per-order and
  per-position limits, extended-hours trading, and the trading calendar.
  Switching the calendar to **24/7** makes the market always open, which is
  worth doing if you'd rather people could play on a Sunday.

---

## Upgrading an existing database

If your database predates the simulation engine, its companies have no
simulation state and none of the new fields. **You don't have to do anything**:
on boot the server brings the indexes in line with the schemas, gives every
old company simulation state initialised from its current price, and backfills
a chart for any ticker that has no candles. Anything it misses is repaired
lazily the first time that company is read.

The startup log tells you what happened:

```
↻ Upgrading 8 companies from the pre-engine schema…
↻ dnut: upgraded to the simulation engine (sim).
↻ dnut: backfilled 4000 candles.
```

Prices, balances, holdings and trade history are all preserved. The old
`priceHistory` collection is left untouched — candles replace it, and you can
drop it whenever you like.

## Troubleshooting

**"MONGODB_URI is not set"** — fill in `backend/.env`, or run
`npm run dev:memory` to skip the database entirely.

**The leaderboard, market board and stats all fail at once after an upgrade** —
this was a real bug: companies created by the pre-engine version had no
simulation state, and every market endpoint read it. Fixed — the server now
repairs those documents itself. If you're seeing it, you're running a build
from before the fix; redeploy.

**Pages load but every panel is empty** — the API isn't reachable. Check
<http://localhost:3000/api/health>; it reports whether the database is
connected.

**"The market is closed"** — it probably is. The exchange runs the NYSE
calendar by default. Check the chip in the header for the next open, or switch
the calendar to 24/7 in the admin console.

**Nothing moves and volume is zero** — same thing. Prices only advance while
the market is open; that's the point.

**Orders rejected with "not enough buying power" when you clearly have cash** —
resting limit orders reserve their cash. Cancel them, or check the reserved
figure on the portfolio page.

**Port 3000 already in use** — something else is on it. Run with a different
port: `PORT=3001 npm run dev:memory`.

**Debugging order matching** — set `DM_DEBUG_ORDERS=1` and the server logs
every settlement pass: which orders it looked at, and whether each triggered.
