/* ===========================================================================
   DONUT MARKET — engine/news.js
   Turns the price process's jumps into a news feed.

   Nothing here invents price movement. The jump already happened inside
   engine/price.js as part of the stochastic path; this module reads the same
   deterministic draw and writes the headline that explains it. So the feed and
   the chart can never disagree — every gap on the chart has a story next to
   it, and every story has a candle.

   Headlines are picked by (ticker, tick), so re-generating the feed for a past
   window produces exactly the same wire copy.
   =========================================================================== */

const { pick, uniform } = require("./rng");
const { hashString } = require("./rng");

// Buckets by absolute move size. Each bucket has its own register — a 1% drift
// higher is "shares edge up", a 20% collapse is not.
const TEMPLATES = {
  major: {
    up: [
      "{name} smashes quarterly glaze targets, guides higher",
      "Buyout chatter sends {name} vertical",
      "{name} lands exclusive supply deal — {sector} rivals scramble",
      "Regulators clear {name}'s expansion; shares gap up",
      "{name} unveils next-gen product line to standing ovation",
    ],
    down: [
      "{name} slashes full-year outlook, shares crater",
      "Accounting irregularities surface at {name}",
      "Mass recall hits {name} production line",
      "{name} loses flagship contract to a {sector} rival",
      "Surprise resignation of {name}'s chief executive rattles holders",
    ],
  },
  moderate: {
    up: [
      "{name} beats on volume, margins hold",
      "Analysts upgrade {name} to Overweight",
      "{name} expands into three new districts",
      "Insider buying reported at {name}",
      "{sector} tailwinds lift {name}",
    ],
    down: [
      "{name} misses on margins as input costs bite",
      "Analysts trim {name} price target",
      "Supply delays flagged at {name}",
      "Insider selling disclosed at {name}",
      "{sector} weakness weighs on {name}",
    ],
  },
  minor: {
    up: [
      "{name} ticks higher on light volume",
      "Bargain hunters nibble at {name}",
      "{name} recovers earlier losses",
      "Quiet accumulation spotted in {name}",
    ],
    down: [
      "{name} drifts lower in thin trade",
      "Profit-taking clips {name}",
      "{name} gives back yesterday's gains",
      "{name} fades into the close",
    ],
  },
};

const OVERNIGHT_PREFIX = ["Pre-market:", "Overnight:", "Before the bell:"];

function bucketFor(absPct) {
  if (absPct >= 8) return "major";
  if (absPct >= 2.5) return "moderate";
  return "minor";
}

/**
 * Builds the headline for one jump.
 *
 * @param {object} company  { ticker, name, sector }
 * @param {object} jump     { tick, size, ms, overnight } from engine/price.js
 */
function headlineFor(company, jump) {
  const pct = (Math.exp(jump.size) - 1) * 100;
  const bucket = bucketFor(Math.abs(pct));
  const direction = pct >= 0 ? "up" : "down";
  const pool = TEMPLATES[bucket][direction];
  const seed = hashString(String(company.ticker || company.id || "dnut"));

  let text = pool[pick(seed, jump.tick, 70, pool.length)]
    .replace("{name}", company.name)
    .replace("{sector}", company.sector || "the sector");

  if (jump.overnight && uniform(seed, jump.tick, 71) > 0.45) {
    text = `${OVERNIGHT_PREFIX[pick(seed, jump.tick, 72, OVERNIGHT_PREFIX.length)]} ${text[0].toLowerCase()}${text.slice(1)}`;
  }

  return {
    headline: text,
    companyId: company.ticker || company.id,
    impactPct: Number(pct.toFixed(2)),
    severity: bucket,
    source: "market",
    at: new Date(jump.ms),
  };
}

// Convenience: map a batch of jumps from one advance() call into feed items.
function headlinesFor(company, jumps) {
  return jumps.map((j) => headlineFor(company, j));
}

module.exports = { headlineFor, headlinesFor, bucketFor, TEMPLATES };
