/* ==========================================================================
   DONUT MARKET — main.js
   Shared interactions + mock market data used across all pages.
   Structured so a real backend/API can later replace DM.data with live calls.
   ========================================================================== */

const DM = (() => {

  /* ------------------------------------------------------------------------
     DEFAULT DATA
     The app is fully backed by the Express/MongoDB API now (see js/live.js).
     These empty defaults exist only so the render helpers below have a safe
     fallback if called with no argument — real data is always passed in
     explicitly by each page. No fake/demo values live here anymore.
  ------------------------------------------------------------------------ */
  const companies = [];
  const leaderboard = [];
  const stats = {
    totalCoins: 0,
    companiesListed: 0,
    activeTraders: 0,
    tradesToday: 0,
  };

  /* ------------------------------------------------------------------------
     UTILITIES
  ------------------------------------------------------------------------ */
  function formatNumber(n) {
    return new Intl.NumberFormat('en-US').format(Math.round(n));
  }

  function formatCompact(n) {
    return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  }

  // Seeded pseudo-random so sparklines look consistent per company rather than jumping every reload.
  function seededRandom(seed) {
    let s = seed;
    return () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
  }

  function generateSeries(seed, points = 20, volatility = 1) {
    const rand = seededRandom(seed);
    let value = 50;
    const series = [value];
    for (let i = 1; i < points; i++) {
      value += (rand() - 0.48) * 10 * volatility;
      value = Math.max(8, Math.min(92, value));
      series.push(value);
    }
    return series;
  }

  function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return h % 10000;
  }

  /* ------------------------------------------------------------------------
     NAVBAR: scroll state + mobile toggle
  ------------------------------------------------------------------------ */
  function initNavbar() {
    const nav = document.querySelector('.navbar');
    const toggle = document.querySelector('.nav-toggle');
    const mobileMenu = document.querySelector('.mobile-menu');

    if (nav) {
      const onScroll = () => {
        nav.classList.toggle('scrolled', window.scrollY > 12);
      };
      onScroll();
      window.addEventListener('scroll', onScroll, { passive: true });
    }

    if (toggle && mobileMenu) {
      toggle.addEventListener('click', () => {
        const isOpen = toggle.classList.toggle('open');
        mobileMenu.classList.toggle('open', isOpen);
        toggle.setAttribute('aria-expanded', String(isOpen));
      });

      mobileMenu.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', () => {
          toggle.classList.remove('open');
          mobileMenu.classList.remove('open');
        });
      });
    }
  }

  /* ------------------------------------------------------------------------
     SCROLL REVEAL
  ------------------------------------------------------------------------ */
  function initReveal() {
    const targets = document.querySelectorAll('.reveal');
    if (!targets.length) return;

    if (!('IntersectionObserver' in window)) {
      targets.forEach(t => t.classList.add('in-view'));
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in-view');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15 });

    targets.forEach(t => observer.observe(t));
  }

  /* ------------------------------------------------------------------------
     ANIMATED COUNTERS (stat cards)
  ------------------------------------------------------------------------ */
  // Counts an element up from 0 to its data-counter value. Exported as
  // DM.animateCounter so pages can trigger it manually once real data has
  // arrived from the API (see data-dynamic-stat handling below).
  function animateCounter(el) {
    const target = parseFloat(el.getAttribute('data-counter'));
    const decimals = el.getAttribute('data-decimals') ? parseInt(el.getAttribute('data-decimals'), 10) : 0;
    const prefix = el.getAttribute('data-prefix') || '';
    const suffix = el.getAttribute('data-suffix') || '';
    const duration = 1400;
    const start = performance.now();

    function tick(now) {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const value = target * eased;
      el.textContent = prefix + value.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }) + suffix;
      if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function initCounters() {
    // Elements marked data-dynamic-stat are populated from a live API call
    // (see index.html) and animated manually once real numbers arrive —
    // skip them here so they don't briefly count up to a stale value.
    const counters = document.querySelectorAll('[data-counter]:not([data-dynamic-stat])');
    if (!counters.length) return;

    if (!('IntersectionObserver' in window)) {
      counters.forEach(animateCounter);
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          animateCounter(entry.target);
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.4 });

    counters.forEach(c => observer.observe(c));
  }

  /* ------------------------------------------------------------------------
     SPARKLINE SVG GENERATOR — used on stock cards / market table
  ------------------------------------------------------------------------ */
  function sparklineSVG(series, isUp, width = 200, height = 56) {
    const min = Math.min(...series);
    const max = Math.max(...series);
    const range = max - min || 1;

    const points = series.map((v, i) => {
      const x = (i / (series.length - 1)) * width;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    const color = isUp ? 'var(--profit)' : 'var(--loss)';
    const gradId = `spark-grad-${Math.random().toString(36).slice(2, 9)}`;
    const areaPoints = `0,${height} ${points.join(' ')} ${width},${height}`;

    return `
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
        <defs>
          <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${color}" stop-opacity="0.35" />
            <stop offset="100%" stop-color="${color}" stop-opacity="0" />
          </linearGradient>
        </defs>
        <polygon points="${areaPoints}" fill="url(#${gradId})" />
        <polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    `;
  }

  /* ------------------------------------------------------------------------
     RENDER: featured stock cards (used on index.html + market.html)
  ------------------------------------------------------------------------ */
  function renderStockCards(containerSelector, list = companies) {
    const container = document.querySelector(containerSelector);
    if (!container) return;

    container.innerHTML = list.map(c => {
      const isUp = c.change >= 0;
      // Real recorded prices when we have them (see js/live.js, which pulls
      // these from /api/companies/history/all). A company with no trade
      // history yet just gets a flat line at its current price — honest
      // about "no movement recorded" rather than inventing a fake chart.
      const series = (c.history && c.history.length >= 2)
        ? c.history
        : [c.price, c.price];
      return `
        <article class="stock-card glass reveal" data-id="${c.id}">
          <div class="stock-card-head">
            <div class="stock-logo">${c.icon}</div>
            <div>
              <div class="stock-name">${c.name}</div>
              <div class="stock-ticker">$${c.id.toUpperCase()} · ${c.sector}</div>
            </div>
            <span class="stock-status ${c.status === 'closed' ? 'closed' : ''}">${c.status === 'open' ? '● Open' : 'Closed'}</span>
          </div>
          <div class="stock-sparkline">${sparklineSVG(series, isUp)}</div>
          <div class="stock-price-row">
            <span class="stock-price">${formatNumber(c.price)} <span style="font-size:12px;color:var(--ink-30);">DC</span></span>
            <span class="stock-change ${isUp ? 'up' : 'down'}">${isUp ? '▲' : '▼'} ${Math.abs(c.change).toFixed(1)}%</span>
          </div>
          <button class="btn btn-primary btn-block btn-sm buy-btn" data-id="${c.id}" ${c.status === 'closed' ? 'disabled' : ''}>
            ${c.status === 'closed' ? 'Market closed' : `Buy ${c.icon}`}
          </button>
        </article>
      `;
    }).join('');

    container.querySelectorAll('.buy-btn').forEach(btn => {
      if (btn.disabled) return;
      btn.addEventListener('click', () => {
        const company = list.find(c => c.id === btn.getAttribute('data-id'));
        if (!company) return;
        if (window.DM_TRADE) {
          DM_TRADE.open(company, 'buy');
        } else {
          openToast(`Order placed for ${company.name} — this is a preview build, trading engine coming soon.`);
        }
      });
    });
  }

  /* ------------------------------------------------------------------------
     RENDER: leaderboard rows (used on index.html preview + leaderboard.html)
  ------------------------------------------------------------------------ */
  function renderLeaderboard(containerSelector, list = leaderboard) {
    const container = document.querySelector(containerSelector);
    if (!container) return;

    const rankClass = (rank) => rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '';

    container.innerHTML = list.map(t => `
      <div class="leaderboard-row reveal">
        <div class="rank-badge ${rankClass(t.rank)}">${t.rank}</div>
        <div class="trader-cell">
          <div class="trader-avatar">${t.name.slice(0, 2).toUpperCase()}</div>
          <div>
            <div class="trader-name">${t.name}</div>
            <div class="trader-tag">${t.tag}</div>
          </div>
        </div>
        <div class="balance-cell">${formatCompact(t.balance)} DC</div>
        <div class="profit-cell up">+${t.profit.toFixed(1)}%</div>
      </div>
    `).join('');
  }

  /* ------------------------------------------------------------------------
     HERO CANVAS CHART — ambient animated candlestick-ish line chart
  ------------------------------------------------------------------------ */
  function initHeroChart() {
    const canvas = document.getElementById('hero-chart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let width, height, dpr;
    let series = [];
    const maxPoints = 60;

    function resize() {
      dpr = window.devicePixelRatio || 1;
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function seed() {
      let v = height * 0.6;
      series = [];
      for (let i = 0; i < maxPoints; i++) {
        v += (Math.random() - 0.47) * (height * 0.06);
        v = Math.max(height * 0.15, Math.min(height * 0.85, v));
        series.push(v);
      }
    }

    function step() {
      let last = series[series.length - 1];
      last += (Math.random() - 0.47) * (height * 0.06);
      last = Math.max(height * 0.15, Math.min(height * 0.85, last));
      series.push(last);
      if (series.length > maxPoints) series.shift();
    }

    function draw() {
      ctx.clearRect(0, 0, width, height);

      const stepX = width / (maxPoints - 1);
      const points = series.map((v, i) => [i * stepX, v]);

      // Area fill
      const grad = ctx.createLinearGradient(0, 0, 0, height);
      grad.addColorStop(0, 'rgba(255, 95, 168, 0.28)');
      grad.addColorStop(1, 'rgba(255, 95, 168, 0)');

      ctx.beginPath();
      ctx.moveTo(0, height);
      points.forEach(([x, y]) => ctx.lineTo(x, y));
      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      // Line
      ctx.beginPath();
      points.forEach(([x, y], i) => {
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      const lineGrad = ctx.createLinearGradient(0, 0, width, 0);
      lineGrad.addColorStop(0, '#ffb84d');
      lineGrad.addColorStop(1, '#ff5fa8');
      ctx.strokeStyle = lineGrad;
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();

      // Leading dot
      const [lx, ly] = points[points.length - 1];
      ctx.beginPath();
      ctx.arc(lx, ly, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ff5fa8';
      ctx.shadowColor = '#ff5fa8';
      ctx.shadowBlur = 12;
      ctx.fill();
      ctx.shadowBlur = 0;

      // Faint grid lines
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      for (let gy = 0; gy < 4; gy++) {
        const y = (height / 4) * gy;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
    }

    let frame = 0;
    function loop() {
      frame++;
      if (frame % 20 === 0) step();
      draw();
      requestAnimationFrame(loop);
    }

    resize();
    seed();
    draw();
    window.addEventListener('resize', () => { resize(); });
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      requestAnimationFrame(loop);
    }
  }

  /* ------------------------------------------------------------------------
     LIVE TICKER PRICE (hero head price) — cosmetic, ticks the featured price
  ------------------------------------------------------------------------ */
  function initLivePrice() {
    const priceEl = document.querySelector('[data-live-price]');
    const deltaEl = document.querySelector('[data-live-delta]');
    if (!priceEl) return;

    let price = parseFloat(priceEl.getAttribute('data-live-price'));
    const base = price;

    setInterval(() => {
      price += (Math.random() - 0.48) * 1.6;
      const change = ((price - base) / base) * 100;
      priceEl.textContent = formatNumber(price) + ' DC';
      if (deltaEl) {
        const up = change >= 0;
        deltaEl.textContent = `${up ? '▲' : '▼'} ${Math.abs(change).toFixed(2)}%`;
        deltaEl.classList.toggle('up', up);
        deltaEl.style.color = up ? 'var(--profit)' : 'var(--loss)';
        deltaEl.style.background = up ? 'var(--profit-dim)' : 'var(--loss-dim)';
      }
    }, 2200);
  }

  /* ------------------------------------------------------------------------
     TOAST — lightweight feedback for prototype actions (buy, login, etc.)
  ------------------------------------------------------------------------ */
  function openToast(message) {
    let toast = document.querySelector('.dm-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'dm-toast';
      Object.assign(toast.style, {
        position: 'fixed',
        bottom: '28px',
        left: '50%',
        transform: 'translateX(-50%) translateY(20px)',
        background: 'rgba(21,18,31,0.95)',
        border: '1px solid rgba(255,255,255,0.12)',
        backdropFilter: 'blur(16px)',
        color: '#f7f4ef',
        padding: '14px 22px',
        borderRadius: '999px',
        fontSize: '14px',
        fontFamily: "'Inter', sans-serif",
        boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
        zIndex: 1000,
        opacity: '0',
        transition: 'opacity 0.3s ease, transform 0.3s ease',
        maxWidth: '90vw',
        textAlign: 'center',
      });
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateX(-50%) translateY(0)';
    });
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-50%) translateY(20px)';
    }, 3200);
  }

  /* ------------------------------------------------------------------------
     ERROR BANNER — persistent (no auto-dismiss) notice shown when live data
     can't be loaded from the API. Used instead of silently falling back to
     fake/demo numbers, so a broken connection is never mistaken for real
     data. Optional retry button re-runs the page's load function.
  ------------------------------------------------------------------------ */
  function showErrorBanner(message, onRetry) {
    let banner = document.querySelector('.dm-error-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'dm-error-banner';
      Object.assign(banner.style, {
        position: 'sticky',
        top: '0',
        zIndex: '900',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '14px',
        padding: '10px 18px',
        background: '#3a1620',
        borderBottom: '1px solid rgba(255,95,95,0.35)',
        color: '#ffb4b4',
        fontFamily: "'Inter', sans-serif",
        fontSize: '13.5px',
        textAlign: 'center',
      });
      const main = document.querySelector('main');
      (main || document.body).prepend(banner);
    }

    banner.innerHTML = `<span>⚠️ ${message}</span>`;
    if (onRetry) {
      const btn = document.createElement('button');
      btn.textContent = 'Retry';
      Object.assign(btn.style, {
        background: 'rgba(255,255,255,0.12)',
        border: '1px solid rgba(255,255,255,0.2)',
        color: '#fff',
        borderRadius: '999px',
        padding: '4px 14px',
        fontSize: '12.5px',
        cursor: 'pointer',
      });
      btn.addEventListener('click', () => {
        clearErrorBanner();
        onRetry();
      });
      banner.appendChild(btn);
    }
  }

  function clearErrorBanner() {
    const banner = document.querySelector('.dm-error-banner');
    if (banner) banner.remove();
  }

  /* ------------------------------------------------------------------------
     INIT — run shared behaviors on every page
  ------------------------------------------------------------------------ */
  function init() {
    initNavbar();
    initReveal();
    initCounters();
    initHeroChart();
    initLivePrice();
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    data: { companies, leaderboard, stats },
    formatNumber,
    formatCompact,
    generateSeries,
    hashString,
    sparklineSVG,
    renderStockCards,
    renderLeaderboard,
    openToast,
    animateCounter,
    showErrorBanner,
    clearErrorBanner,
  };
})();
