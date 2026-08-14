/* ==========================================================================
   Market board — every listing, sortable, filterable, with live quotes.
   ========================================================================== */

(() => {
  let quotes = [];
  let search = '';
  let sector = 'all';
  let sortKey = 'name';
  let sortDir = 1;
  let view = 'table';

  /* --------------------------------------------------------------- filters */

  function visible() {
    const term = search.trim().toLowerCase();
    const filtered = quotes.filter((q) => {
      if (sector === 'gainers' && q.change_pct < 0) return false;
      if (sector === 'losers' && q.change_pct >= 0) return false;
      if (sector !== 'all' && sector !== 'gainers' && sector !== 'losers' && q.sector !== sector) return false;
      if (!term) return true;
      return q.name.toLowerCase().includes(term) || q.ticker.includes(term);
    });

    return filtered.sort((a, b) => {
      const av = sortKey === 'name' ? a.name.toLowerCase() : a[sortKey];
      const bv = sortKey === 'name' ? b.name.toLowerCase() : b[sortKey];
      if (av < bv) return -1 * sortDir;
      if (av > bv) return 1 * sortDir;
      return 0;
    });
  }

  function renderSectors() {
    const sectors = [...new Set(quotes.map((q) => q.sector))].sort();
    const chips = [
      { key: 'all', label: 'All' },
      { key: 'gainers', label: 'Gainers' },
      { key: 'losers', label: 'Losers' },
      ...sectors.map((s) => ({ key: s, label: s })),
    ];
    DM.$('#sector-filters').innerHTML = chips
      .map((c) => `<button class="chip ${c.key === sector ? 'active' : ''}" data-sector="${DM.esc(c.key)}">${DM.esc(c.label)}</button>`)
      .join('');
  }

  /* ---------------------------------------------------------------- render */

  function renderTable(list) {
    const body = DM.$('#market-table-body');
    if (!list.length) {
      body.innerHTML = '<tr><td colspan="11" class="table-empty">No companies match your filters.</td></tr>';
      return;
    }
    body.innerHTML = list
      .map(
        (q) => `<tr class="clickable" data-ticker="${DM.esc(q.ticker)}">
          <td>
            <div class="cell-company">
              <span class="ico">${DM.esc(q.icon)}</span>
              <span><span class="nm">${DM.esc(q.name)}</span><br /><span class="tk">$${DM.esc(q.ticker.toUpperCase())}</span></span>
            </div>
          </td>
          <td class="num" data-field="price" style="font-weight:600">${DM.price(q.price)}</td>
          <td class="num ${DM.dirClass(q.change_pct)}" data-field="change" style="font-weight:600">${DM.delta(q.change_pct)}</td>
          <td class="num up">${DM.price(q.bid)}</td>
          <td class="num down">${DM.price(q.ask)}</td>
          <td class="num muted">${q.spreadBps} bp</td>
          <td class="num">${DM.abbrev(q.day_volume)}</td>
          <td class="num">${DM.abbrev(q.market_cap)}</td>
          <td class="muted">${DM.esc(q.sector)}</td>
          <td>${DM_UI.statusPill(q)}</td>
          <td style="text-align:right">
            <button class="btn btn-xs btn-buy" data-buy="${DM.esc(q.ticker)}" ${q.tradable ? '' : 'disabled'}>Buy</button>
            <button class="btn btn-xs btn-ghost" data-sell="${DM.esc(q.ticker)}" ${q.tradable ? '' : 'disabled'}>Sell</button>
          </td>
        </tr>`
      )
      .join('');
  }

  function render() {
    const list = visible();
    if (view === 'table') renderTable(list);
    else DM_UI.renderCards('#card-view', list);
  }

  function patch() {
    if (view === 'cards') return DM_UI.patchCards('#card-view', quotes);
    const body = DM.$('#market-table-body');
    for (const q of quotes) {
      const row = body.querySelector(`[data-ticker="${q.ticker}"]`);
      if (!row) continue;
      DM.setPrice(row.querySelector('[data-field="price"]'), q.price);
      const change = row.querySelector('[data-field="change"]');
      change.textContent = DM.delta(q.change_pct);
      change.className = `num ${DM.dirClass(q.change_pct)}`;
    }
  }

  function renderIndex(index) {
    if (!index) return;
    const stat = (k, v, cls = '') => `<div><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
    DM.$('#index-strip').innerHTML = [
      stat('Donut 500', DM.price(index.value)),
      stat('Change', `${DM.signed(index.change)} (${DM.pct(index.change_pct)})`, DM.dirClass(index.change)),
      stat('Advancing', String(index.advancers), 'up'),
      stat('Declining', String(index.decliners), 'down'),
      stat('Members', String(index.members)),
      stat('Total cap', `${DM.abbrev(index.market_cap)} DC`),
    ].join('');
  }

  function renderMovers(data) {
    const block = (title, rows, key) => `
      <div class="panel">
        <div class="panel-head"><h3>${title}</h3></div>
        <div class="panel-body flush">
          ${rows
            .map(
              (q) => `<a class="news-item" href="${DM_UI.companyHref(q.ticker)}">
                <span class="icon">${DM.esc(q.icon)}</span>
                <div style="flex:1;min-width:0">
                  <div class="headline">${DM.esc(q.name)}</div>
                  <div class="meta">$${DM.esc(q.ticker.toUpperCase())} · ${DM.price(q.price)} DC</div>
                </div>
                <div class="mono ${key === 'day_volume' ? '' : DM.dirClass(q.change_pct)}" style="font-weight:600;align-self:center">
                  ${key === 'day_volume' ? DM.abbrev(q.day_volume) : DM.delta(q.change_pct)}
                </div>
              </a>`
            )
            .join('')}
        </div>
      </div>`;

    DM.$('#movers').innerHTML =
      block('Top gainers', data.gainers.slice(0, 4), 'change_pct') +
      block('Top losers', data.losers.slice(0, 4), 'change_pct') +
      block('Most active', data.active.slice(0, 4), 'day_volume');
  }

  /* ------------------------------------------------------------------ load */

  async function loadAll() {
    const { data, error } = await DM_API.companies();
    if (error) {
      DM.showBanner(`Couldn't load the market: ${error.message}`, loadAll);
      return;
    }
    DM.clearBanner();
    const first = quotes.length === 0;
    quotes = data;
    if (first) renderSectors();
    render();
  }

  async function refresh() {
    const { data } = await DM_API.quotes();
    if (!data) return;
    const byTicker = Object.fromEntries(data.quotes.map((q) => [q.ticker, q]));
    quotes = quotes.map((q) => ({ ...q, ...(byTicker[q.ticker] || {}) }));
    patch();
  }

  async function loadSide() {
    const [{ data: index }, { data: movers }, { data: news }] = await Promise.all([
      DM_API.marketIndex('15m', 40),
      DM_API.movers(),
      DM_API.news(14),
    ]);
    if (index) renderIndex(index.index);
    if (movers) renderMovers(movers);
    if (news) DM_UI.renderNews('#market-news', news);
  }

  /* ---------------------------------------------------------------- events */

  function wire() {
    DM.$('#market-search').addEventListener('input', DM.debounce((e) => {
      search = e.target.value;
      render();
    }, 140));

    DM.$('#sector-filters').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-sector]');
      if (!chip) return;
      sector = chip.dataset.sector;
      renderSectors();
      render();
    });

    DM.$('#view-picker').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-view]');
      if (!btn) return;
      view = btn.dataset.view;
      DM.$$('#view-picker button').forEach((b) => b.classList.toggle('active', b === btn));
      DM.$('#table-view').hidden = view !== 'table';
      DM.$('#card-view').hidden = view !== 'cards';
      render();
    });

    DM.$$('.data-table th.sortable').forEach((th) => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        // Numbers are most useful biggest-first; names alphabetical.
        if (sortKey === key) sortDir *= -1;
        else { sortKey = key; sortDir = key === 'name' ? 1 : -1; }
        DM.$$('.data-table th.sortable').forEach((other) => other.classList.toggle('sorted', other === th));
        th.querySelector('.arrow').textContent = sortDir === 1 ? '▲' : '▼';
        render();
      });
    });

    DM.$('#market-table-body').addEventListener('click', (e) => {
      const buy = e.target.closest('[data-buy]');
      const sell = e.target.closest('[data-sell]');
      if (buy || sell) {
        e.preventDefault();
        const t = (buy || sell).dataset.buy || (buy || sell).dataset.sell;
        const quote = quotes.find((q) => q.ticker === t);
        if (quote) DM_TICKET.open(quote, buy ? 'buy' : 'sell');
        return;
      }
      const row = e.target.closest('[data-ticker]');
      if (row) window.location.href = DM_UI.companyHref(row.dataset.ticker);
    });

    document.addEventListener('dm:trade', () => { refresh(); loadSide(); });
  }

  document.addEventListener('DOMContentLoaded', () => {
    wire();
    loadAll();
    loadSide();
    DM.poll(refresh, 4000);
    DM.poll(loadSide, 30000);
  });
})();
