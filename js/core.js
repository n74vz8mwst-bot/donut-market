/* ==========================================================================
   DONUT MARKET — core.js
   Formatting, theming and the small UI primitives every page uses.

   Number formatting lives here rather than in each page because consistency
   is the whole game on a trading screen: a price is always two decimals, a
   percentage always carries its sign, and every figure is tabular so columns
   don't wobble when a digit changes.
   ========================================================================== */

const DM = (() => {
  const money = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });

  /* ---------------------------------------------------------------- format */

  const nz = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);

  const price = (n) => money.format(nz(n));
  const coins = (n) => `${whole.format(Math.round(nz(n)))} DC`;
  const coinsExact = (n) => `${money.format(nz(n))} DC`;
  const qty = (n) => whole.format(nz(n));

  function abbrev(n) {
    const v = nz(n);
    if (Math.abs(v) >= 1000) return compact.format(v);
    return Number.isInteger(v) ? whole.format(v) : money.format(v);
  }

  function pct(n, decimals = 2) {
    const v = nz(n);
    return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(decimals)}%`;
  }

  function signed(n, decimals = 2) {
    const v = nz(n);
    return `${v >= 0 ? '+' : '−'}${money.format(Math.abs(v))}`;
  }

  // Arrow + magnitude, the way a tape prints it. Exactly flat gets no arrow —
  // "▲ 0.00%" reads as a gain that isn't there.
  function delta(n, decimals = 2) {
    const v = nz(n);
    const magnitude = `${Math.abs(v).toFixed(decimals)}%`;
    if (Math.abs(v) < 0.005) return magnitude;
    return `${v > 0 ? '▲' : '▼'} ${magnitude}`;
  }

  const dirClass = (n) => (nz(n) > 0 ? 'up' : nz(n) < 0 ? 'down' : '');

  const time = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const timeSec = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour12: false });
  const dateTime = (ms) =>
    new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  function ago(ms) {
    const secs = Math.max(0, (Date.now() - new Date(ms).getTime()) / 1000);
    if (secs < 60) return 'just now';
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return `${Math.floor(secs / 86400)}d ago`;
  }

  // Everything user-supplied goes through this before it touches innerHTML.
  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  /* ------------------------------------------------------------------- dom */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function el(tag, attrs = {}, html) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v != null) node.setAttribute(k, v);
    }
    if (html != null) node.innerHTML = html;
    return node;
  }

  function setText(node, text) {
    if (node && node.textContent !== String(text)) node.textContent = text;
  }

  // Writes a price and flashes it green or red if it moved — the small tell
  // that says "this screen is live" without needing a spinner.
  function setPrice(node, value, previous) {
    if (!node) return;
    const next = Number(value);
    const prev = previous != null ? Number(previous) : parseFloat(node.dataset.value);
    node.dataset.value = next;
    node.textContent = price(next);
    if (!Number.isFinite(prev) || prev === next) return;
    const cls = next > prev ? 'flash-up' : 'flash-down';
    node.classList.remove('flash-up', 'flash-down');
    void node.offsetWidth; // restart the animation
    node.classList.add(cls);
  }

  /* ----------------------------------------------------------------- theme */

  const THEME_KEY = 'dm_theme';

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
    document.dispatchEvent(new CustomEvent('dm:theme', { detail: theme }));
  }

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') || 'dark';
  }

  function initTheme() {
    const stored = localStorage.getItem(THEME_KEY);
    const preferred = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', stored || preferred);
  }

  function toggleTheme() {
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  }

  // Reads a CSS custom property — the chart draws with the same tokens as the
  // rest of the page, so it re-colours correctly when the theme flips.
  function token(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  /* ----------------------------------------------------------------- toast */

  function toast(message, kind = '') {
    let stack = $('.toast-stack');
    if (!stack) {
      stack = el('div', { class: 'toast-stack' });
      document.body.appendChild(stack);
    }
    const node = el('div', { class: `toast ${kind}` }, esc(message));
    stack.appendChild(node);
    requestAnimationFrame(() => node.classList.add('show'));
    setTimeout(() => {
      node.classList.remove('show');
      setTimeout(() => node.remove(), 400);
    }, 3600);
  }

  /* ---------------------------------------------------------------- banner */

  // A persistent, dismissable notice for "we couldn't load live data". Shown
  // instead of quietly rendering placeholder numbers that look real.
  function showBanner(message, onRetry, kind = 'error') {
    let banner = $('.banner');
    if (!banner) {
      banner = el('div', { class: 'banner' });
      const nav = $('.navbar');
      if (nav && nav.parentNode) nav.parentNode.insertBefore(banner, nav.nextSibling);
      else document.body.prepend(banner);
    }
    banner.className = `banner banner-${kind}`;
    banner.innerHTML = `<span>${kind === 'error' ? '⚠️' : '⏳'} ${esc(message)}</span>`;
    if (onRetry) {
      const btn = el('button', { class: 'btn btn-xs btn-ghost' }, 'Retry');
      btn.addEventListener('click', () => { clearBanner(); onRetry(); });
      banner.appendChild(btn);
    }
  }

  function clearBanner() {
    const banner = $('.banner');
    if (banner) banner.remove();
  }

  /* ---------------------------------------------------------------- reveal */

  function initReveal(root = document) {
    const targets = $$('.reveal:not(.in-view)', root);
    if (!targets.length) return;
    if (!('IntersectionObserver' in window)) {
      targets.forEach((t) => t.classList.add('in-view'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add('in-view'); io.unobserve(e.target); }
      }),
      { threshold: 0.12 }
    );
    targets.forEach((t) => io.observe(t));
  }

  function countUp(node, target, { decimals = 0, suffix = '', duration = 900 } = {}) {
    const start = performance.now();
    const from = parseFloat(node.dataset.value) || 0;
    node.dataset.value = target;

    const format = (v) =>
      v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + suffix;

    // Write the real value first. If this tab is in the background, requestAnimationFrame
    // never fires — the number must still be correct, just without the animation.
    node.textContent = format(target);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    function frame(now) {
      const p = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      const value = from + (target - from) * eased;
      node.textContent =
        value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + suffix;
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  /* ------------------------------------------------------------- sparkline */

  function sparkline(series, { width = 200, height = 44 } = {}) {
    const points = (series || []).filter((n) => Number.isFinite(n));
    if (points.length < 2) {
      return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
        <line x1="0" y1="${height / 2}" x2="${width}" y2="${height / 2}" stroke="var(--ink-4)" stroke-width="1.5" stroke-dasharray="3 4" />
      </svg>`;
    }

    const min = Math.min(...points);
    const max = Math.max(...points);
    const range = max - min || Math.abs(max) * 0.01 || 1;
    const isUp = points[points.length - 1] >= points[0];
    const color = isUp ? 'var(--up)' : 'var(--down)';
    const id = `sg${Math.random().toString(36).slice(2, 8)}`;

    const coords = points.map((v, i) => {
      const x = (i / (points.length - 1)) * width;
      const y = height - ((v - min) / range) * (height - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.28" />
        <stop offset="100%" stop-color="${color}" stop-opacity="0" />
      </linearGradient></defs>
      <polygon points="0,${height} ${coords.join(' ')} ${width},${height}" fill="url(#${id})" />
      <polyline points="${coords.join(' ')}" fill="none" stroke="${color}" stroke-width="1.75"
                stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
    </svg>`;
  }

  /* ------------------------------------------------------------------ misc */

  // Runs `fn` on an interval, but only while the tab is visible — a background
  // tab shouldn't keep hammering the exchange.
  function poll(fn, intervalMs) {
    let timer = null;
    const tick = async () => {
      if (document.visibilityState === 'visible') await fn();
      timer = setTimeout(tick, intervalMs);
    };
    timer = setTimeout(tick, intervalMs);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') fn();
    });
    return () => clearTimeout(timer);
  }

  function debounce(fn, wait = 180) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  const params = () => new URLSearchParams(location.search);
  const inPages = () => location.pathname.includes('/pages/');
  const link = (page) => (inPages() ? page : `pages/${page}`);
  const home = () => (inPages() ? '../index.html' : 'index.html');

  return {
    price, coins, coinsExact, qty, abbrev, pct, signed, delta, dirClass,
    time, timeSec, dateTime, ago, esc,
    $, $$, el, setText, setPrice,
    initTheme, applyTheme, toggleTheme, currentTheme, token,
    toast, showBanner, clearBanner,
    initReveal, countUp, sparkline,
    poll, debounce, params, inPages, link, home,
  };
})();

// Applied before first paint (this file is loaded in <head>) so the page never
// flashes the wrong theme.
DM.initTheme();

window.DM = DM;
