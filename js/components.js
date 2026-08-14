/* ==========================================================================
   DONUT MARKET — components.js
   Shared renderers. Anything that appears on more than one page is built
   here so a company card, a news item or an order book looks and behaves the
   same wherever it shows up.
   ========================================================================== */

const DM_UI = (() => {
  const companyHref = (ticker) => `${DM.link('company.html')}?t=${encodeURIComponent(ticker)}`;

  function statusPill(quote) {
    if (quote.status === 'halted') return '<span class="pill pill-halted">Halted</span>';
    if (quote.status === 'closed') return '<span class="pill pill-closed">Delisted</span>';
    if (quote.session === 'regular') return '<span class="pill pill-open">● Open</span>';
    if (quote.session === 'pre') return '<span class="pill pill-pre">Pre-market</span>';
    if (quote.session === 'after') return '<span class="pill pill-after">After hours</span>';
    return '<span class="pill pill-closed">Closed</span>';
  }

  /* -------------------------------------------------------------- card grid */

  function stockCard(quote) {
    const dir = DM.dirClass(quote.change_pct);
    return `
      <a class="stock-card card reveal" href="${companyHref(quote.ticker)}" data-ticker="${DM.esc(quote.ticker)}">
        <div class="stock-card-head">
          <div class="stock-logo">${DM.esc(quote.icon || '🍩')}</div>
          <div style="min-width:0">
            <div class="stock-name">${DM.esc(quote.name)}</div>
            <div class="stock-ticker">$${DM.esc(quote.ticker.toUpperCase())} · ${DM.esc(quote.sector || '—')}</div>
          </div>
          <span style="margin-left:auto">${statusPill(quote)}</span>
        </div>
        <div class="stock-sparkline">${DM.sparkline(quote.sparkline)}</div>
        <div class="stock-price-row">
          <span class="stock-price" data-field="price">${DM.price(quote.price)}</span>
          <span class="stock-change ${dir}" data-field="change">${DM.delta(quote.change_pct)}</span>
        </div>
        <div class="stock-quote-row">
          <span>${DM.price(quote.bid)} × ${DM.price(quote.ask)}</span>
          <span>Vol ${DM.abbrev(quote.day_volume)}</span>
        </div>
      </a>`;
  }

  function renderCards(container, quotes, emptyMessage = 'No companies match.') {
    const node = typeof container === 'string' ? DM.$(container) : container;
    if (!node) return;
    node.innerHTML = quotes.length
      ? quotes.map(stockCard).join('')
      : `<div class="card empty-state" style="grid-column:1/-1"><span class="donut-mark">🍩</span><h3>Nothing here</h3><p>${DM.esc(emptyMessage)}</p></div>`;
    DM.initReveal(node);
  }

  // Updates prices in place so a poll doesn't rebuild (and visually reset) the
  // whole grid — and flashes the ones that moved.
  function patchCards(container, quotes) {
    const node = typeof container === 'string' ? DM.$(container) : container;
    if (!node) return;
    for (const quote of quotes) {
      const card = node.querySelector(`[data-ticker="${quote.ticker}"]`);
      if (!card) continue;
      DM.setPrice(card.querySelector('[data-field="price"]'), quote.price);
      const change = card.querySelector('[data-field="change"]');
      if (change) {
        change.textContent = DM.delta(quote.change_pct);
        change.className = `stock-change ${DM.dirClass(quote.change_pct)}`;
      }
    }
  }

  /* ------------------------------------------------------------------- news */

  function newsItem(event) {
    const dir = DM.dirClass(event.impact_pct);
    return `
      <div class="news-item ${DM.esc(event.severity || '')}">
        <span class="icon">${DM.esc(event.companyIcon || '📰')}</span>
        <div style="min-width:0">
          <div class="headline">${DM.esc(event.headline)}</div>
          <div class="meta">
            ${event.company_id ? `<a href="${companyHref(event.company_id)}">$${DM.esc(event.company_id.toUpperCase())}</a>` : '<span>Market</span>'}
            ${event.impact_pct ? `<span class="${dir}">${DM.pct(event.impact_pct)}</span>` : ''}
            <span>${DM.ago(event.at)}</span>
            ${event.source === 'admin' ? '<span class="pill pill-neutral">Exchange notice</span>' : ''}
          </div>
        </div>
      </div>`;
  }

  function renderNews(container, events) {
    const node = typeof container === 'string' ? DM.$(container) : container;
    if (!node) return;
    node.innerHTML = events.length
      ? events.map(newsItem).join('')
      : '<div class="empty-state"><p>The wire is quiet. Headlines appear when the market makes a big move.</p></div>';
  }

  /* -------------------------------------------------------------- order book */

  function bookLadder(quote, levels = 6) {
    const asks = (quote.asks || []).slice(0, levels).reverse();
    const bids = (quote.bids || []).slice(0, levels);
    const max = Math.max(...[...asks, ...bids].map((l) => l.size), 1);

    const row = (level, side, cumulative) => `
      <div class="book-row ${side}">
        <span class="depth-bar" style="width:${(level.size / max) * 100}%"></span>
        <span class="px">${DM.price(level.price)}</span>
        <span class="sz">${DM.qty(level.size)}</span>
        <span class="tot">${DM.qty(cumulative)}</span>
      </div>`;

    let askTotal = asks.reduce((s, l) => s + l.size, 0);
    const askRows = asks.map((l) => {
      const html = row(l, 'ask', askTotal);
      askTotal -= l.size;
      return html;
    });

    let bidTotal = 0;
    const bidRows = bids.map((l) => {
      bidTotal += l.size;
      return row(l, 'bid', bidTotal);
    });

    return `
      <div class="book">
        <div class="book-head"><span>Price</span><span style="text-align:right">Size</span><span style="text-align:right">Total</span></div>
        ${askRows.join('')}
        <div class="book-spread">
          <span>Spread ${DM.price(quote.spread)}</span>
          <span>${quote.spreadBps} bps</span>
        </div>
        ${bidRows.join('')}
      </div>`;
  }

  /* ------------------------------------------------------------ time & sales */

  function tapeList(prints) {
    if (!prints || !prints.length) return '<div class="empty-state"><p>No prints yet.</p></div>';
    return `<div class="tape-list">${prints
      .map(
        (p) => `<div class="tape-row">
          <span class="t">${DM.timeSec(p.ms)}</span>
          <span class="p ${p.side === 'buy' ? 'up' : 'down'}">${DM.price(p.price)}</span>
          <span class="s">${DM.qty(p.size)}</span>
        </div>`
      )
      .join('')}</div>`;
  }

  /* ---------------------------------------------------------------- orders */

  function orderRow(order, { showTicker = true } = {}) {
    const price =
      order.type === 'market'
        ? 'Market'
        : order.type === 'stop'
        ? `Stop ${DM.price(order.stop_price)}`
        : order.type === 'stop_limit'
        ? `${DM.price(order.stop_price)} → ${DM.price(order.limit_price)}`
        : DM.price(order.limit_price);

    const statusPillClass =
      order.status === 'filled' ? 'pill-up' : order.status === 'open' || order.status === 'triggered' ? 'pill-neutral' : 'pill-closed';

    return `
      <tr data-order="${DM.esc(order.id)}">
        ${showTicker ? `<td><a href="${companyHref(order.ticker)}"><strong>$${DM.esc(order.ticker.toUpperCase())}</strong></a></td>` : ''}
        <td class="${order.side === 'buy' ? 'up' : 'down'}" style="text-transform:capitalize;font-weight:600">${DM.esc(order.side)}</td>
        <td style="text-transform:capitalize">${DM.esc(order.type.replace('_', ' '))}</td>
        <td class="num">${DM.qty(order.qty)}</td>
        <td class="num">${price}</td>
        <td><span class="pill ${statusPillClass}">${DM.esc(order.status)}</span></td>
        <td class="num muted">${DM.dateTime(order.created_at)}</td>
        <td style="text-align:right">
          ${['open', 'triggered'].includes(order.status)
            ? `<button class="btn btn-xs btn-ghost" data-cancel="${DM.esc(order.id)}">Cancel</button>`
            : DM.esc(order.note || '')}
        </td>
      </tr>`;
  }

  return { companyHref, statusPill, stockCard, renderCards, patchCards, newsItem, renderNews, bookLadder, tapeList, orderRow };
})();

window.DM_UI = DM_UI;
