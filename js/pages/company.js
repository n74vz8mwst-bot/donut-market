/* ==========================================================================
   Trading terminal for a single listing: chart, order book, time and sales,
   news, your position and the order ticket.

   Polling is split by how fast each thing actually changes — quotes and the
   book every three seconds, candles every fifteen, news every minute — so the
   screen feels live without hammering the exchange.
   ========================================================================== */

(() => {
  const ticker = (DM.params().get('t') || '').toLowerCase();

  let chart = null;
  let timeframe = '5m';
  let chartType = 'candles';
  let company = null;
  let quote = null;
  let lastPrice = null;
  let watching = false;

  function fail(message) {
    DM.$('#terminal-error').innerHTML = `
      <div class="card empty-state">
        <span class="donut-mark">🍩</span>
        <h3>${DM.esc(message)}</h3>
        <p>Pick a company from the market board and try again.</p>
        <a class="btn btn-primary" href="market.html">Back to the market</a>
      </div>`;
  }

  /* ------------------------------------------------------------ rendering */

  function renderQuote(q) {
    quote = q;
    DM.setText(DM.$('#q-icon'), q.icon || '🍩');
    DM.setText(DM.$('#q-name'), q.name);
    DM.setText(DM.$('#q-ticker'), `$${q.ticker.toUpperCase()}`);
    DM.setText(DM.$('#q-sector'), q.sector || '—');
    DM.$('#q-status').innerHTML = DM_UI.statusPill(q);
    document.title = `${q.ticker.toUpperCase()} ${DM.price(q.price)} — Donut Market`;

    DM.setPrice(DM.$('#q-price'), q.price, lastPrice);
    lastPrice = q.price;

    const change = DM.$('#q-change');
    change.textContent = `${DM.signed(q.change)} (${DM.pct(q.change_pct)}) today`;
    change.className = `chg ${DM.dirClass(q.change_pct)}`;

    const stat = (k, v, cls = '') => `<div><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
    DM.$('#q-stats').innerHTML = [
      stat('Bid', DM.price(q.bid), 'up'),
      stat('Ask', DM.price(q.ask), 'down'),
      stat('Spread', `${DM.price(q.spread)} · ${q.spreadBps}bp`),
      stat('Open', DM.price(q.day_open)),
      stat('High', DM.price(q.day_high)),
      stat('Low', DM.price(q.day_low)),
      stat('Prev close', DM.price(q.prev_close)),
      stat('Volume', DM.abbrev(q.day_volume)),
      stat('Mkt cap', DM.abbrev(q.market_cap)),
      stat('Volatility', `${q.annual_vol_pct.toFixed(0)}%`),
      stat('Beta', q.beta.toFixed(2)),
    ].join('');

    DM.$('#book-slot').innerHTML = DM_UI.bookLadder(q);
    DM.$('#tape-slot').innerHTML = DM_UI.tapeList(q.prints);

    const sessionLabel = { pre: 'Pre-market', regular: 'Regular hours', after: 'After hours', closed: 'Closed' }[q.session];
    DM.setText(DM.$('#ticket-session'), sessionLabel || '—');

    if (chart) chart.setPrevClose(q.prev_close);
  }

  function renderFundamentals(detail) {
    DM.setText(DM.$('#q-description'), detail.description || 'No description on file for this listing.');
    const f = detail.fundamentals;
    const stat = (k, v) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`;
    DM.$('#fundamentals').innerHTML = [
      stat('Shares out', DM.abbrev(f.shares_outstanding)),
      stat('Avg daily vol', DM.abbrev(f.adv)),
      stat('Listed', new Date(f.listed_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })),
      stat('Liquidity', DM.abbrev(f.liquidity)),
    ].join('');
  }

  async function loadCandles() {
    const { data, error } = await DM_API.candles(ticker, timeframe, timeframe === '1d' ? 120 : 240);
    if (error || !data) return;
    if (!chart) {
      chart = DM_CHART.create(DM.$('#price-chart'), { type: chartType, prevClose: data.prev_close });
    }
    chart.setData(data.candles, data.prev_close);
    DM.setText(
      DM.$('#chart-note'),
      data.candles.length
        ? `${data.candles.length} × ${timeframe} candles · includes extended-hours prints`
        : 'No candles for this timeframe yet'
    );
  }

  async function loadNews() {
    const { data } = await DM_API.companyNews(ticker, 12);
    if (data) DM_UI.renderNews('#company-news', data);
  }

  async function loadPosition() {
    if (!DM_API.isLoggedIn()) {
      DM.$('#position-panel').hidden = true;
      DM.$('#orders-panel').hidden = true;
      return;
    }

    const [{ data: positions }, { data: orders }] = await Promise.all([DM_API.holdings(), DM_API.orders('open')]);

    const position = (positions || []).find((p) => p.companyId === ticker);
    const panel = DM.$('#position-panel');
    if (position) {
      panel.hidden = false;
      const stat = (k, v, cls = '') => `<div><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
      DM.$('#position-stats').innerHTML = [
        stat('Shares', DM.qty(position.shares)),
        stat('Avg cost', DM.price(position.avgPrice)),
        stat('Market value', DM.coins(position.value)),
        stat('Unrealised', `${DM.signed(position.unrealizedPnl)} (${DM.pct(position.unrealizedPct)})`, DM.dirClass(position.unrealizedPnl)),
        stat('Today', DM.signed(position.dayChange), DM.dirClass(position.dayChange)),
        stat('Realised', DM.signed(position.realizedPnl), DM.dirClass(position.realizedPnl)),
      ].join('');
    } else {
      panel.hidden = true;
    }

    const mine = (orders || []).filter((o) => o.ticker === ticker);
    const ordersPanel = DM.$('#orders-panel');
    ordersPanel.hidden = mine.length === 0;
    if (mine.length) {
      DM.$('#orders-body').innerHTML = mine.map((o) => DM_UI.orderRow(o, { showTicker: false })).join('');
    }
  }

  async function loadWatch() {
    const btn = DM.$('#q-watch');
    if (!DM_API.isLoggedIn()) { btn.hidden = true; return; }
    btn.hidden = false;
    const { data } = await DM_API.watchlist();
    watching = Boolean(data && data.tickers.includes(ticker));
    btn.textContent = watching ? '★ Watching' : '☆ Watch';
  }

  /* ----------------------------------------------------------------- load */

  async function loadCompany() {
    const { data, error } = await DM_API.company(ticker);
    if (error) {
      fail(error.status === 404 ? 'That company isn’t listed.' : error.message);
      return false;
    }
    company = data;
    DM.$('#terminal').hidden = false;
    renderQuote(data.quote);
    renderFundamentals(data);
    return true;
  }

  async function refreshQuote() {
    const { data } = await DM_API.quotes([ticker]);
    if (data && data.quotes && data.quotes[0]) renderQuote(data.quotes[0]);
  }

  /* --------------------------------------------------------------- events */

  function wireControls() {
    DM.$('#tf-picker').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tf]');
      if (!btn) return;
      timeframe = btn.dataset.tf;
      DM.$$('#tf-picker button').forEach((b) => b.classList.toggle('active', b === btn));
      loadCandles();
    });

    DM.$('#type-picker').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-type]');
      if (!btn) return;
      chartType = btn.dataset.type;
      DM.$$('#type-picker button').forEach((b) => b.classList.toggle('active', b === btn));
      if (chart) chart.setType(chartType);
    });

    DM.$('#q-watch').addEventListener('click', async () => {
      const { data, error } = await DM_API.toggleWatch(ticker);
      if (error) return DM.toast(error.message, 'err');
      watching = data.watching;
      DM.$('#q-watch').textContent = watching ? '★ Watching' : '☆ Watch';
    });

    DM.$('#orders-body').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-cancel]');
      if (!btn) return;
      btn.disabled = true;
      const { error } = await DM_API.cancelOrder(btn.dataset.cancel);
      if (error) { DM.toast(error.message, 'err'); btn.disabled = false; return; }
      DM.toast('Order cancelled.', 'ok');
      loadPosition();
      DM_SHELL.refreshProfile();
    });

    document.addEventListener('dm:trade', () => {
      refreshQuote();
      loadPosition();
      loadCandles();
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    if (!ticker) return fail('No company selected.');

    const ok = await loadCompany();
    if (!ok) return;

    DM_TICKET.mount(DM.$('#ticket-slot'), { ticker, name: company.name, icon: company.icon, price: company.price }, {
      side: 'buy',
    });

    wireControls();
    loadCandles();
    loadNews();
    loadPosition();
    loadWatch();

    DM.poll(refreshQuote, 3000);
    DM.poll(loadCandles, 15000);
    DM.poll(loadNews, 60000);
    document.addEventListener('dm:profile', loadPosition);
  });
})();
