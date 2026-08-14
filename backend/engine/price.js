/* ===========================================================================
   DONUT MARKET — engine/price.js
   The price process.

   Every company's price is a multi-factor stochastic path, evaluated on the
   5-second tick grid from engine/calendar.js:

     dlog(P) = [ mu - sigma^2/2 + kappa*(log(F) - log(P)) ] dt
               + beta_m * sigma_m * dW_m
               + beta_s * sigma_s * dW_s
               + sigma_i * dW_i
               + J dN

   In words, and in the order it shows up on a chart:

   * **A market factor.** One shared random walk drives the whole exchange, so
     on a red day most tickers are red. Each company's `beta` decides how hard
     it gets pulled along.
   * **A sector factor.** Bakery Tech can rip while Logistics bleeds.
   * **Idiosyncratic noise.** The part that is genuinely about this company.
   * **Volatility clustering.** Real volatility is not constant — quiet weeks
     and violent weeks come in runs. Both the market-wide and the per-company
     volatility multipliers are smooth value noise, so calm stretches and
     storms emerge on their own.
   * **Mean reversion to a fair value.** `F` grows at the company's long-run
     drift. Price wanders around it and gets pulled back, which is what stops
     a random walk from drifting to zero or the moon over a season.
   * **Jump diffusion.** Rare, fat-tailed shocks. Each jump is a news event —
     see engine/news.js, which turns the same deterministic draw into a
     headline, so the feed always explains the candle.
   * **Overnight gaps.** Time passes while the market is shut. The first tick
     of a session absorbs that variance in one move, which is why gaps happen.

   Everything here is a pure function of (company params, tick index) plus the
   small `sim` state carried on the company document, so the path is identical
   no matter who loads the page or when.
   =========================================================================== */

const { gaussian, uniform, hashString } = require("./rng");
const cal = require("./calendar");

// A "market year" is 252 regular sessions of 6.5 hours. Volatility inputs are
// annualised against that, the way real quoted vols are.
const SECONDS_PER_MARKET_YEAR = 252 * 6.5 * 3600;

// Extended-hours time carries less information than regular-hours time: the
// same five seconds moves the price less at 5am than at 10am. Overnight is a
// closed period but still accumulates variance, released as a gap at the open.
const TIME_WEIGHT = { [cal.SESSION.PRE]: 0.35, [cal.SESSION.REGULAR]: 1, [cal.SESSION.AFTER]: 0.3 };
const OVERNIGHT_DAY_FRACTION = 0.4; // gap variance as a share of a full session

// Market-wide factor. Sector factors reuse the same shape with their own seed.
const MARKET_SEED = hashString("donut-market:index");
const MARKET_VOL = 0.16; // annualised vol of the market factor
const MARKET_DRIFT = 0.06; // gentle long-run uptrend for the whole exchange
const SECTOR_VOL = 0.13;

// Temporary trade impact decays with a ~12 minute half-life of market time.
const IMPACT_HALFLIFE_YEARS = (12 * 60) / SECONDS_PER_MARKET_YEAR;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// --- Smooth noise ----------------------------------------------------------

// Value noise: hash the integer lattice, smoothstep between neighbours. Gives
// a continuous, deterministic wiggle with no stored state — used for slow
// regime variables (volatility levels, drift regimes) where white noise would
// look wrong and an OU process would need state we'd have to persist.
function smoothNoise(seed, x) {
  const i = Math.floor(x);
  const f = x - i;
  const a = uniform(seed, i, 7) * 2 - 1;
  const b = uniform(seed, i + 1, 7) * 2 - 1;
  const t = f * f * (3 - 2 * f);
  return a + (b - a) * t;
}

// Two octaves: a slow regime plus a faster ripple.
function volRegime(seed, tick, ticksPerCycle) {
  const slow = smoothNoise(seed, tick / ticksPerCycle);
  const fast = smoothNoise(seed ^ 0x5bf03635, tick / (ticksPerCycle / 4));
  return Math.exp(0.55 * slow + 0.22 * fast);
}

// Ticks in one regular session, used as the natural period for regime noise.
const TICKS_PER_SESSION = (6.5 * 3600) / (cal.TICK_MS / 1000);

// --- Intraday volume shape -------------------------------------------------

// Volume is not flat across the day: it spikes at the open, sags at lunch and
// ramps into the close. Classic U-shape (well, J-shape) — it makes intraday
// volume bars look like a real tape.
function intradayVolumeShape(ms) {
  const p = cal.localParts(ms);
  const minutes = p.hour * 60 + p.minute;
  const openMin = 9 * 60 + 30;
  const closeMin = 16 * 60;
  if (minutes < openMin || minutes > closeMin) return 0.5;
  const t = (minutes - openMin) / (closeMin - openMin);
  return 0.55 + 1.9 * Math.exp(-t / 0.12) + 1.15 * Math.exp(-(1 - t) / 0.13);
}

// --- Company defaults ------------------------------------------------------

// Fills in the simulation parameters a company doesn't specify. Volatility and
// beta scale off liquidity: a thin, small listing is jumpier and less tied to
// the index than a mega-cap.
function normalizeParams(company) {
  // Idempotent: callers pass either a raw company or an already-normalised
  // param set, and normalising twice must not re-hash the seed into a
  // different stream.
  if (company && company.__normalized) return company;

  const liquidity = Math.max(Number(company.liquidity) || 5000, 1);
  const seedSource = company.seed || company.ticker || company.id || "dnut";
  return {
    __normalized: true,
    ticker: company.ticker || company.id,
    seed: hashString(String(seedSource)),
    sectorSeed: hashString("sector:" + (company.sector || "General")),
    liquidity,
    // Annualised idiosyncratic vol: ~28% for the deepest names, ~95% for the
    // thinnest. Meme-adjacent, but the ordering is the real-world one.
    annualVol: company.annualVol != null ? company.annualVol : clamp(2.6 / Math.sqrt(liquidity) + 0.22, 0.22, 1.1),
    beta: company.beta != null ? company.beta : clamp(0.45 + Math.log10(liquidity) * 0.22, 0.4, 1.6),
    sectorBeta: company.sectorBeta != null ? company.sectorBeta : 0.8,
    drift: company.drift != null ? company.drift : 0.05,
    meanReversion: company.meanReversion != null ? company.meanReversion : 0.9,
    jumpsPerYear: company.jumpsPerYear != null ? company.jumpsPerYear : 26,
    jumpVol: company.jumpVol != null ? company.jumpVol : 0.05,
    // Average daily volume in shares — drives the volume bars, the order-book
    // depth and the square-root impact of a trade.
    adv: company.adv != null ? company.adv : Math.round(liquidity * 4),
  };
}

// Fresh simulation state for a newly listed company.
function initSim(company, nowMs = Date.now()) {
  const price = Math.max(Number(company.price) || 1, 0.01);
  const startMs = nowMs;
  return {
    tick: cal.tickAt(startMs),
    logPrice: Math.log(price),
    fairLog: Math.log(price),
    tempImpact: 0,
    dayKey: null,
    prevClose: price,
    dayOpen: price,
    dayHigh: price,
    dayLow: price,
    dayVolume: 0,
    lastBarStart: cal.barStart(startMs),
  };
}

// --- The path ---------------------------------------------------------------

// One step of the log-price SDE. `dtYears` is market time, not wall time.
function stepLog(state, params, tick, dtYears, opts = {}) {
  const sqrtDt = Math.sqrt(dtYears);

  // Volatility regimes: one shared across the exchange, one per company.
  const marketVolMult = volRegime(MARKET_SEED, tick, TICKS_PER_SESSION * 3);
  const nameVolMult = volRegime(params.seed ^ 0x1f83d9ab, tick, TICKS_PER_SESSION * 2);
  const sigma = params.annualVol * nameVolMult * marketVolMult;

  // Factor returns. The market factor gets a slow drift regime of its own so
  // the whole exchange trends for weeks at a time instead of chopping.
  const marketRegime = smoothNoise(MARKET_SEED ^ 0x2545f491, tick / (TICKS_PER_SESSION * 12));
  const marketRet =
    (MARKET_DRIFT + marketRegime * 0.35) * dtYears +
    MARKET_VOL * marketVolMult * sqrtDt * gaussian(MARKET_SEED, tick, 1);
  const sectorRet = SECTOR_VOL * marketVolMult * sqrtDt * gaussian(params.sectorSeed, tick, 2);
  const idioRet = sigma * sqrtDt * gaussian(params.seed, tick, 3);

  // Pull back toward fair value, which itself compounds at the long-run drift.
  const fairLog = state.fairLog + params.drift * dtYears;
  const reversion = params.meanReversion * (fairLog - state.logPrice) * dtYears;

  // Total instantaneous variance, for the Itô correction.
  const totalVar =
    Math.pow(params.beta * MARKET_VOL * marketVolMult, 2) +
    Math.pow(params.sectorBeta * SECTOR_VOL * marketVolMult, 2) +
    sigma * sigma;

  let delta =
    -0.5 * totalVar * dtYears +
    reversion +
    params.beta * marketRet +
    params.sectorBeta * sectorRet +
    idioRet;

  // Jumps: rare, fat-tailed, and each one is a story (see engine/news.js).
  let jump = null;
  if (opts.allowJumps !== false) {
    const p = params.jumpsPerYear * dtYears;
    if (uniform(params.seed, tick, 5) < p) {
      const size = params.jumpVol * gaussian(params.seed, tick, 6) * 2.2;
      const capped = clamp(size, -0.28, 0.28);
      delta += capped;
      jump = { tick, size: capped };
    }
  }

  return { delta, fairLog, jump, sigma };
}

// Shares printed in one tick. Deterministic, lognormal around the ADV-implied
// rate, shaped by the time of day and thinned outside regular hours.
function tickVolume(params, tick, ms, session) {
  const profile = cal.SESSION_PROFILE[session] || cal.SESSION_PROFILE.regular;
  const perTick = params.adv / ((6.5 * 3600) / (cal.TICK_MS / 1000));
  const shape = intradayVolumeShape(ms);
  const noise = Math.exp(0.85 * gaussian(params.seed, tick, 9) - 0.36);
  return Math.max(0, perTick * shape * profile.volume * noise);
}

/**
 * Advances a company's simulation state up to `toMs`, emitting the 1-minute
 * candles it passed through on the way.
 *
 * This is called lazily: whatever request happens to look at a company is what
 * moves its clock forward. Because the randomness is a pure function of the
 * tick index, it doesn't matter who calls it or how often — the resulting path
 * is the same, and two requests a millisecond apart agree on the price.
 *
 * @returns {{ sim, bars, jumps, ticksAdvanced, session }}
 */
function advance(sim, company, toMs = Date.now(), options = {}) {
  const params = normalizeParams(company);
  const mode = options.mode || "exchange";
  const maxBars = options.maxBars || 2880; // ~2 sessions of 1-minute candles

  const state = { ...sim };
  const fromMs = cal.tickToMs(state.tick + 1);
  const bars = [];
  const jumps = [];
  let ticksAdvanced = 0;

  if (toMs <= fromMs) {
    return { sim: state, bars, jumps, ticksAdvanced: 0, session: cal.sessionAt(toMs, mode).session };
  }

  const segments = cal.openSegments(fromMs, toMs, mode);

  // A company nobody has looked at in a very long time would otherwise mean
  // millions of tick iterations. Past a threshold we step at candle resolution
  // instead of tick resolution — the same process, coarser sampling — and only
  // emit candles for the recent tail.
  const totalTicks = segments.reduce((n, s) => n + Math.ceil((s.end - s.start) / cal.TICK_MS), 0);
  const coarse = totalTicks > 60000;
  const stride = coarse ? cal.TICKS_PER_BAR : 1;

  let bar = null;

  const closeBar = () => {
    if (!bar) return;
    bars.push(bar);
    if (bars.length > maxBars) bars.shift();
    bar = null;
  };

  for (const seg of segments) {
    // New trading day: roll the daily stats and release the overnight gap.
    if (seg.isOpenOfDay && seg.dayKey !== state.dayKey) {
      const prevClose = Math.exp(state.logPrice);
      state.prevClose = prevClose;
      state.dayVolume = 0;

      const gapTick = cal.tickAt(seg.start);
      const gapDt = OVERNIGHT_DAY_FRACTION / 252;
      const gapStep = stepLog(state, params, gapTick, gapDt, { allowJumps: true });
      state.logPrice += gapStep.delta;
      state.fairLog = gapStep.fairLog;
      if (gapStep.jump) jumps.push({ ...gapStep.jump, ms: seg.start, overnight: true });

      const openPrice = Math.exp(state.logPrice);
      state.dayOpen = openPrice;
      state.dayHigh = openPrice;
      state.dayLow = openPrice;
      state.dayKey = seg.dayKey;
    } else if (seg.dayKey !== state.dayKey && state.dayKey === null) {
      state.dayKey = seg.dayKey;
    }

    const weight = TIME_WEIGHT[seg.session] || 1;
    const dtPerTick = ((cal.TICK_MS / 1000) * weight * stride) / SECONDS_PER_MARKET_YEAR;

    const startTick = cal.tickAt(seg.start);
    const endTick = cal.tickAt(seg.end - 1);

    for (let tick = startTick; tick <= endTick; tick += stride) {
      const ms = cal.tickToMs(tick);

      const step = stepLog(state, params, tick, dtPerTick);
      state.logPrice += step.delta;
      state.fairLog = step.fairLog;
      if (step.jump) jumps.push({ ...step.jump, ms, overnight: false });

      // Temporary trade impact bleeds off toward zero.
      if (state.tempImpact) {
        const decay = Math.pow(0.5, dtPerTick / IMPACT_HALFLIFE_YEARS);
        const before = state.tempImpact;
        state.tempImpact *= decay;
        state.logPrice -= before - state.tempImpact;
      }

      const price = Math.exp(state.logPrice);
      const vol = tickVolume(params, tick, ms, seg.session) * stride;
      state.dayVolume += vol;
      state.dayHigh = Math.max(state.dayHigh || price, price);
      state.dayLow = Math.min(state.dayLow || price, price);

      // Candle accumulation. Bars are only produced for open time, so charts
      // show a real gap over nights and weekends instead of a flat line.
      const bStart = cal.barStart(ms);
      if (!bar || bar.t !== bStart) {
        closeBar();
        bar = { t: bStart, o: price, h: price, l: price, c: price, v: 0, session: seg.session };
      }
      bar.h = Math.max(bar.h, price);
      bar.l = Math.min(bar.l, price);
      bar.c = price;
      bar.v += vol;

      state.tick = tick;
      ticksAdvanced += stride;
    }
    closeBar();
  }

  // Move the clock to the last tick that has actually started, including any
  // closed time we skipped over, so the next call resumes cleanly instead of
  // rescanning the weekend. Ticks that haven't begun yet are left alone —
  // that is what makes "advance to A then to B" identical to "advance to B".
  state.tick = Math.max(state.tick, cal.tickAt(toMs - 1));

  return {
    sim: state,
    bars,
    jumps,
    ticksAdvanced,
    coarse,
    session: cal.sessionAt(toMs, mode).session,
  };
}

/**
 * Deterministic backfill: what this company's candles *would* have looked like
 * over a past window, given where it stands now.
 *
 * Used once, when a company is listed, to give a brand-new ticker a plausible
 * chart instead of a single flat point. It runs the same process backwards
 * from the current state and then rescales so the last bar lands exactly on
 * today's real price — the shape is simulated, the endpoint is true.
 */
function backfill(company, sim, fromMs, toMs, options = {}) {
  const params = normalizeParams(company);
  const mode = options.mode || "exchange";
  const barMs = options.barMs || cal.BAR_MS;

  const segments = cal.openSegments(fromMs, toMs, mode);
  const seed = { ...initSim({ ...company, price: Math.exp(sim.logPrice) }, fromMs), tick: cal.tickAt(fromMs) };
  const state = { ...seed };
  const bars = [];
  let bar = null;

  for (const seg of segments) {
    if (seg.isOpenOfDay && seg.dayKey !== state.dayKey) {
      const gapStep = stepLog(state, params, cal.tickAt(seg.start), OVERNIGHT_DAY_FRACTION / 252);
      state.logPrice += gapStep.delta;
      state.fairLog = gapStep.fairLog;
      state.dayKey = seg.dayKey;
    }
    const weight = TIME_WEIGHT[seg.session] || 1;
    const stride = Math.max(1, Math.round(barMs / cal.TICK_MS));
    const dt = ((cal.TICK_MS / 1000) * weight * stride) / SECONDS_PER_MARKET_YEAR;

    for (let tick = cal.tickAt(seg.start); tick <= cal.tickAt(seg.end - 1); tick += stride) {
      const step = stepLog(state, params, tick, dt);
      state.logPrice += step.delta;
      state.fairLog = step.fairLog;
      const price = Math.exp(state.logPrice);
      const ms = cal.tickToMs(tick);
      const bStart = Math.floor(ms / barMs) * barMs;
      const vol = tickVolume(params, tick, ms, seg.session) * stride;
      if (!bar || bar.t !== bStart) {
        if (bar) bars.push(bar);
        bar = { t: bStart, o: price, h: price, l: price, c: price, v: 0 };
      }
      bar.h = Math.max(bar.h, price);
      bar.l = Math.min(bar.l, price);
      bar.c = price;
      bar.v += vol;
    }
  }
  if (bar) bars.push(bar);
  if (!bars.length) return bars;

  // Rescale so the synthetic history ends exactly at the live price.
  const target = Math.exp(sim.logPrice);
  const factor = target / bars[bars.length - 1].c;
  for (const b of bars) {
    b.o *= factor;
    b.h *= factor;
    b.l *= factor;
    b.c *= factor;
    b.v = Math.round(b.v);
  }
  return bars;
}

module.exports = {
  SECONDS_PER_MARKET_YEAR,
  MARKET_SEED,
  MARKET_VOL,
  TIME_WEIGHT,
  normalizeParams,
  initSim,
  advance,
  backfill,
  stepLog,
  tickVolume,
  intradayVolumeShape,
  volRegime,
  smoothNoise,
  TICKS_PER_SESSION,
};
