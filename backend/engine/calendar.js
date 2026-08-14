/* ===========================================================================
   DONUT MARKET — engine/calendar.js
   The exchange clock: trading sessions, holidays, half-days, and the tick
   grid the price path is defined on.

   A real exchange is not open 24/7, and a simulator that ignores that loses
   most of what makes markets feel like markets: the overnight gap, the
   opening auction rush, thin and jumpy pre-market prices, the 4pm close.
   Donut Market runs on the NYSE calendar in America/New_York — including
   the 1pm early closes around holidays.

   Admins can flip the exchange to `24/7` in settings if they'd rather have a
   crypto-style always-on market (see models/Settings.js).
   =========================================================================== */

const TZ = "America/New_York";

// The whole simulation is defined on a fixed 5-second grid anchored to this
// instant. Tick N is the same 5 seconds for everyone, forever.
const EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const TICK_MS = 5000;
const BAR_MS = 60000; // one candle = 60s = 12 ticks
const TICKS_PER_BAR = BAR_MS / TICK_MS;

// Session windows in exchange-local minutes-from-midnight.
const PRE_OPEN = 4 * 60; //  4:00 am
const REGULAR_OPEN = 9 * 60 + 30; //  9:30 am
const REGULAR_CLOSE = 16 * 60; //  4:00 pm
const EARLY_CLOSE = 13 * 60; //  1:00 pm on half-days
const AFTER_CLOSE = 20 * 60; //  8:00 pm

const SESSION = { CLOSED: "closed", PRE: "pre", REGULAR: "regular", AFTER: "after" };

// Extended-hours trading is real but thin: fewer participants, wider quotes,
// and each trade moves the price more. These multipliers feed the order book
// and the volume model rather than the volatility of the underlying path.
const SESSION_PROFILE = {
  [SESSION.PRE]: { spread: 3.2, volume: 0.06, impact: 2.4 },
  [SESSION.REGULAR]: { spread: 1.0, volume: 1.0, impact: 1.0 },
  [SESSION.AFTER]: { spread: 2.6, volume: 0.09, impact: 2.0 },
};

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
});

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Exchange-local calendar parts for a UTC instant.
function localParts(ms) {
  const parts = {};
  for (const p of partsFormatter.formatToParts(ms)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Node renders midnight as "24" in some ICU versions.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_INDEX[parts.weekday],
  };
}

// UTC instant for a wall-clock time in the exchange's timezone. Two passes
// so that days where the UTC offset changes (DST) still land correctly.
function localToUtc(year, month, day, minutesFromMidnight) {
  const hour = Math.floor(minutesFromMidnight / 60);
  const minute = minutesFromMidnight % 60;
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 2; i++) {
    const p = localParts(guess);
    const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const offset = asIfUtc - guess;
    guess = Date.UTC(year, month - 1, day, hour, minute, 0) - offset;
  }
  return guess;
}

const dayKey = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

// --- Holidays --------------------------------------------------------------

// Nth given weekday of a month, e.g. nthWeekday(2026, 1, 1, 3) = 3rd Monday
// of January (Martin Luther King Jr. Day).
function nthWeekday(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}

function lastWeekday(year, month, weekday) {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month - 1, daysInMonth)).getUTCDay();
  return daysInMonth - ((last - weekday + 7) % 7);
}

// Anonymous Gregorian algorithm — Good Friday is the only moving-date market
// holiday that isn't pinned to a weekday-of-month rule.
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

// A fixed-date holiday falling on a weekend is observed on the adjacent
// weekday, exactly as the NYSE does it.
function observed(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  const dow = date.getUTCDay();
  if (dow === 6) date.setUTCDate(date.getUTCDate() - 1); // Sat -> Fri
  if (dow === 0) date.setUTCDate(date.getUTCDate() + 1); // Sun -> Mon
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

const holidayCache = new Map();

// { holidays: Set<'YYYY-MM-DD'>, halfDays: Set<'YYYY-MM-DD'> } for a year.
function marketDays(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);

  const holidays = new Set();
  const halfDays = new Set();
  const add = (set, y, m, d) => set.add(dayKey(y, m, d));
  const addObserved = (m, d) => {
    const o = observed(year, m, d);
    add(holidays, o.year, o.month, o.day);
  };

  addObserved(1, 1); // New Year's Day
  add(holidays, year, 1, nthWeekday(year, 1, 1, 3)); // MLK Jr. Day
  add(holidays, year, 2, nthWeekday(year, 2, 1, 3)); // Presidents' Day

  const easter = easterSunday(year);
  const goodFriday = new Date(Date.UTC(year, easter.month - 1, easter.day - 2));
  add(holidays, goodFriday.getUTCFullYear(), goodFriday.getUTCMonth() + 1, goodFriday.getUTCDate());

  add(holidays, year, 5, lastWeekday(year, 5, 1)); // Memorial Day
  addObserved(6, 19); // Juneteenth
  addObserved(7, 4); // Independence Day
  add(holidays, year, 9, nthWeekday(year, 9, 1, 1)); // Labor Day
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  add(holidays, year, 11, thanksgiving); // Thanksgiving
  addObserved(12, 25); // Christmas

  // Half-days: 1:00pm close, no after-hours session.
  add(halfDays, year, 11, thanksgiving + 1); // Black Friday
  const july3 = new Date(Date.UTC(year, 6, 3)).getUTCDay();
  if (july3 >= 1 && july3 <= 5) add(halfDays, year, 7, 3); // July 3rd
  const dec24 = new Date(Date.UTC(year, 11, 24)).getUTCDay();
  if (dec24 >= 1 && dec24 <= 5) add(halfDays, year, 12, 24); // Christmas Eve

  const result = { holidays, halfDays };
  holidayCache.set(year, result);
  return result;
}

function isTradingDay(year, month, day) {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !marketDays(year).holidays.has(dayKey(year, month, day));
}

function isHalfDay(year, month, day) {
  return marketDays(year).halfDays.has(dayKey(year, month, day));
}

// --- Sessions --------------------------------------------------------------

// The open segments for one exchange-local calendar day, as UTC ranges.
// Returns [] for weekends and holidays.
function daySegments(year, month, day, mode = "exchange") {
  if (mode === "24/7") {
    return [
      {
        session: SESSION.REGULAR,
        start: localToUtc(year, month, day, 0),
        end: localToUtc(year, month, day, 24 * 60),
        dayKey: dayKey(year, month, day),
        isOpenOfDay: true,
      },
    ];
  }

  if (!isTradingDay(year, month, day)) return [];

  const half = isHalfDay(year, month, day);
  const close = half ? EARLY_CLOSE : REGULAR_CLOSE;
  const key = dayKey(year, month, day);

  const segments = [
    { session: SESSION.PRE, from: PRE_OPEN, to: REGULAR_OPEN },
    { session: SESSION.REGULAR, from: REGULAR_OPEN, to: close },
  ];
  // Half-days have no after-hours session.
  if (!half) segments.push({ session: SESSION.AFTER, from: close, to: AFTER_CLOSE });

  return segments.map((s, i) => ({
    session: s.session,
    start: localToUtc(year, month, day, s.from),
    end: localToUtc(year, month, day, s.to),
    dayKey: key,
    isOpenOfDay: i === 0,
  }));
}

// What's happening at this instant: which session (or closed), which trading
// day it belongs to, and when the market next opens / closes.
function sessionAt(ms, mode = "exchange") {
  const p = localParts(ms);
  for (const seg of daySegments(p.year, p.month, p.day, mode)) {
    if (ms >= seg.start && ms < seg.end) {
      return { session: seg.session, dayKey: seg.dayKey, segmentEnd: seg.end, isOpen: true };
    }
  }
  return { session: SESSION.CLOSED, dayKey: null, segmentEnd: null, isOpen: false };
}

// Walks forward from `ms` to the next instant the market is open, capped at
// `maxDays` so a bad clock can't spin forever.
function nextOpen(ms, mode = "exchange", maxDays = 10) {
  const p = localParts(ms);
  let cursor = Date.UTC(p.year, p.month - 1, p.day);
  for (let i = 0; i <= maxDays; i++) {
    const d = new Date(cursor + i * 86400000);
    const segments = daySegments(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), mode);
    for (const seg of segments) if (seg.start > ms) return seg.start;
  }
  return null;
}

// Every open segment overlapping [fromMs, toMs), oldest first, clipped to the
// requested window. This is the backbone of the price engine's catch-up loop:
// it advances only across time the market was actually open.
function openSegments(fromMs, toMs, mode = "exchange") {
  if (toMs <= fromMs) return [];
  const out = [];
  const startParts = localParts(fromMs);
  let cursor = Date.UTC(startParts.year, startParts.month - 1, startParts.day);
  // Guard against absurd ranges (a company untouched for years) — the caller
  // decides what to do with a truncated catch-up.
  const maxDays = 400;

  for (let i = 0; i <= maxDays; i++) {
    const d = new Date(cursor + i * 86400000);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    for (const seg of daySegments(y, m, day, mode)) {
      if (seg.end <= fromMs || seg.start >= toMs) continue;
      out.push({
        session: seg.session,
        dayKey: seg.dayKey,
        start: Math.max(seg.start, fromMs),
        end: Math.min(seg.end, toMs),
        // True only when the clipped segment still contains the real open —
        // the price engine uses this to apply the overnight gap exactly once.
        isOpenOfDay: seg.isOpenOfDay && seg.start >= fromMs,
      });
    }
    if (d.getTime() > toMs + 86400000) break;
  }
  return out;
}

// --- Tick grid -------------------------------------------------------------

const tickAt = (ms) => Math.floor((ms - EPOCH_MS) / TICK_MS);
const tickToMs = (tick) => EPOCH_MS + tick * TICK_MS;
const barStart = (ms) => Math.floor(ms / BAR_MS) * BAR_MS;

module.exports = {
  TZ,
  EPOCH_MS,
  TICK_MS,
  BAR_MS,
  TICKS_PER_BAR,
  SESSION,
  SESSION_PROFILE,
  localParts,
  localToUtc,
  isTradingDay,
  isHalfDay,
  daySegments,
  sessionAt,
  nextOpen,
  openSegments,
  tickAt,
  tickToMs,
  barStart,
};
