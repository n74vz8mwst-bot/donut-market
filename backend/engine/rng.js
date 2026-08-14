/* ===========================================================================
   DONUT MARKET — engine/rng.js
   Deterministic, stateless randomness.

   Every random number in the simulation is a pure function of (stream name,
   tick index, salt). Nothing is stored, nothing depends on wall-clock timing,
   and any process that knows a company's seed can reconstruct the exact same
   price path from any point in time.

   That property is what makes the rest of the engine work: the server has no
   background worker, so a company's price is "caught up" lazily whenever
   someone looks at it. If the randomness weren't reproducible, two people
   loading the page a second apart would each roll different dice and the
   market would depend on who happened to look at it.
   =========================================================================== */

// ---------------------------------------------------------------------------
// String -> 32-bit seed (FNV-1a). Used to turn "dnut" / "sector:Bakery Tech"
// into a stable numeric stream id.
// ---------------------------------------------------------------------------
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// SplitMix32 — small, fast, well-distributed integer hash. Given a seed and a
// counter it produces a uniform 32-bit value with no internal state, which is
// exactly what we need for "give me the noise for tick N".
// ---------------------------------------------------------------------------
function splitmix32(seed) {
  let z = (seed + 0x9e3779b9) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  return (z ^ (z >>> 15)) >>> 0;
}

// Uniform in [0, 1) for a given stream + tick + salt.
// `salt` lets one stream produce several independent draws per tick (e.g. the
// idiosyncratic shock, the volatility shock and the volume draw).
function uniform(streamSeed, tick, salt = 0) {
  const mixed = splitmix32(streamSeed ^ Math.imul(tick + 1, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35));
  return splitmix32(mixed) / 4294967296;
}

// Standard normal via Box–Muller. Two uniforms in, one normal out — we throw
// the second normal away so that changing how many draws a caller makes never
// shifts anyone else's stream.
function gaussian(streamSeed, tick, salt = 0) {
  const u1 = Math.max(uniform(streamSeed, tick, salt * 2), 1e-12);
  const u2 = uniform(streamSeed, tick, salt * 2 + 1);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// Integer in [0, n) — for picking headline templates, depth-ladder shapes, etc.
function pick(streamSeed, tick, salt, n) {
  return Math.floor(uniform(streamSeed, tick, salt) * n) % n;
}

module.exports = { hashString, splitmix32, uniform, gaussian, pick };
