# Donut Market — Setup & Deployment Guide

Your site now has a real backend: **Node.js + Express + MongoDB**, with JWT
login, a shared leaderboard, and a real trading engine where buy/sell orders
move prices (not random numbers). This guide gets it running for free and
live on the internet.

The backend also serves your frontend (`index.html`, `css/`, `js/`, `pages/`)
directly — so one free host runs the whole site, API included.

---

## 1. Create a free MongoDB database (MongoDB Atlas)

1. Go to https://www.mongodb.com/cloud/atlas/register and create a free account.
2. Create a new **free (M0) cluster** — any provider/region is fine.
3. **Database Access** (left sidebar) → **Add New Database User** → set a
   username and password (save these, you'll need them next).
4. **Network Access** (left sidebar) → **Add IP Address** → **Allow Access
   From Anywhere** (`0.0.0.0/0`). This is required because your free host's
   server IP isn't fixed.
5. **Database** → **Connect** → **Drivers** → copy the connection string. It
   looks like:
   ```
   mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
6. Add a database name to the path so your data has its own space, e.g.
   `...mongodb.net/donutmarket?retryWrites=...`

## 2. Configure your backend locally

1. Open `backend/.env` and fill in:
   ```
   MONGODB_URI=mongodb+srv://yourUser:yourPassword@cluster0.xxxxx.mongodb.net/donutmarket?retryWrites=true&w=majority
   JWT_SECRET=some-long-random-string
   PORT=3000
   ```
   Generate a good `JWT_SECRET` with:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. Install dependencies and seed the starting companies:
   ```
   cd backend
   npm install
   npm run seed
   ```
3. Run it locally:
   ```
   npm run dev
   ```
   Then open **http://localhost:3000** — that's your whole site, frontend and
   API together. Sign up for an account, browse the market, place a trade.

## 3. Make yourself an admin

Sign up on the site normally first (this creates your user in MongoDB).
Then, in Atlas: **Database → Browse Collections → donutmarket → users** →
find your user document → edit it → change `"role": "trader"` to
`"role": "admin"` → save. Refresh `/pages/admin.html` and you're in.

## 4. Deploy for free and open to the public

**Render** (recommended, generous free tier for small Node apps):

1. Push this whole project to a GitHub repo.
2. Go to https://render.com → **New** → **Web Service** → connect your repo.
3. Settings:
   - **Root Directory:** `backend`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Add environment variables (same as your `.env`): `MONGODB_URI`,
   `JWT_SECRET`, and `PORT` (Render sets its own `PORT` automatically — you
   can leave yours as a fallback, `server.js` already handles both).
5. Deploy. Render gives you a public URL like
   `https://donut-market.onrender.com` — that's your live site.

Other equally free options if you prefer: **Railway**, **Cyclic**, **Fly.io**.
The steps are the same shape: point it at `backend/`, set the same two
environment variables, deploy.

> Free-tier note: most of these put your server to sleep after ~15 minutes
> of no traffic and take a few seconds to wake back up on the next request —
> totally fine for trying this out and sharing with people.

## 5. What's already wired up

- **Signup/Login** — real accounts, passwords hashed with bcrypt, JWT session
  stored in the browser (`pages/login.html`). New accounts start with the
  admin-configured starting balance (see below).
- **Trading** — `POST /api/trade` moves each company's price based on the
  size of the order relative to its `liquidity` value (bigger orders move
  price more), capped at 25% per single trade so nothing breaks. This runs
  inside a MongoDB transaction so balance, holdings, price, and the trade log
  all update together or not at all.
- **Live market movement** — companies also drift on their own between
  trades. Each time a company's price is read, any elapsed time since it was
  last updated is turned into small random ticks with a gentle pull back
  toward its listing price (thinner/low-liquidity companies swing more). This
  is a lazy on-read model — no background worker or cron needed, so it works
  on a free host that sleeps. See `backend/utils/marketDrift.js`.
- **Real price history & charts** — every price change (trade, drift, admin
  edit, news event) is recorded in a `PriceHistory` collection, so the
  sparklines on stock cards show the company's actual recorded prices. A
  brand-new company with no history yet shows an honest flat line rather than
  invented movement.
- **Real homepage stats** — the four stat cards on the landing page
  (`GET /api/stats`) are computed live from the database: total Donut Coins
  in circulation, companies listed, active traders (traded in the last 7
  days), and trades today. No hardcoded numbers.
- **Leaderboard** — `GET /api/leaderboard` ranks every trader by balance +
  live holdings value, shared across everyone. Profit % is measured against
  each trader's own starting balance.
- **Admin panel** (`pages/admin.html`) — create companies, edit prices,
  open/close markets, publish news events that move a stock's price, promote/
  demote traders, **edit any trader's balance** (set an exact amount or
  add/subtract a delta), and **set the starting balance** handed to new
  traders. Every admin route re-checks your role server-side.

## 6. Where things live

```
backend/
  server.js          — Express app, serves the frontend + mounts /api routes
  models/            — Mongoose schemas (User, Company, Trade, MarketEvent,
                       PriceHistory, Settings)
  middleware/auth.js — JWT verification, requireAuth / requireAdmin
  routes/            — auth, companies, trade, portfolio, leaderboard, admin, stats
  utils/marketDrift.js — ambient between-trade price movement
  seed.js            — populates the 8 starting companies (run once)

js/api.js       — frontend's connection to your backend (fetch + JWT)
js/live.js      — maps live company/leaderboard/stats data into the existing UI
js/main.js      — shared rendering (stock cards, sparklines, counters, banners)
js/trade-modal.js — the Buy/Sell popup used on the market and portfolio pages
js/auth-ui.js   — swaps the navbar's Login button for your balance once logged in
```

If the backend isn't running or isn't reachable, each page shows a visible
error banner (with a Retry button) rather than silently displaying fake data —
so a broken connection is never mistaken for a real, working market.

## 7. A note on "realism"

Because charts, stats, and the "active traders" count are now backed by real
recorded data, they start out sparse right after your first deploy and fill in
naturally as the market runs and people trade. That's the intended trade-off of
removing the old demo numbers — everything you see is real, even when that means
starting small.
