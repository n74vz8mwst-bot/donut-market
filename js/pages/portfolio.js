/* ==========================================================================
   Portfolio — valuation, equity curve, allocation, positions, orders, fills.
   ========================================================================== */

(() => {
  let equityChart = null;
  let orderStatus = 'open';
  let positions = [];

  function renderKpis(p) {
    const set = (id, text, cls) => {
      const node = DM.$(id);
      node.textContent = text;
      node.className = `v ${cls || ''}`;
    };

    set('#kpi-networth', DM.coins(p.netWorth));
    DM.setText(DM.$('#kpi-networth-sub'), `${DM.coins(p.cash)} cash · ${DM.coins(p.positionsValue)} in positions`);

    set('#kpi-day', DM.signed(p.dayChange), DM.dirClass(p.dayChange));
    DM.setText(DM.$('#kpi-day-sub'), `${DM.pct(p.dayChangePct)} today`);

    set('#kpi-unrealized', DM.signed(p.unrealizedPnl), DM.dirClass(p.unrealizedPnl));
    DM.setText(DM.$('#kpi-unrealized-sub'), `${DM.pct(p.unrealizedPct)} on ${DM.coins(p.positionsCost)} of cost`);

    set('#kpi-realized', DM.signed(p.realizedPnl), DM.dirClass(p.realizedPnl));
    DM.setText(DM.$('#kpi-realized-sub'), `${DM.coinsExact(p.feesPaid)} paid in fees · total return ${DM.pct(p.totalReturnPct)}`);
  }

  function renderAllocation(p) {
    DM.setText(DM.$('#alloc-cash'), `${((p.cash / (p.netWorth || 1)) * 100).toFixed(0)}% cash`);
    const rows = [...p.positions];
    const node = DM.$('#allocation');
    if (!rows.length) {
      node.innerHTML = '<p class="muted tiny">No positions yet — your account is all cash.</p>';
      return;
    }
    node.innerHTML = rows
      .map(
        (row) => `<div class="alloc-row">
          <span>${DM.esc(row.icon)} <strong>${DM.esc(row.companyId.toUpperCase())}</strong> <span class="muted tiny">${DM.esc(row.name)}</span></span>
          <span class="mono">${row.weightPct.toFixed(1)}%</span>
          <span class="alloc-bar"><span style="width:${Math.min(100, row.weightPct)}%"></span></span>
        </div>`
      )
      .join('') +
      `<div class="alloc-row" style="opacity:.7">
        <span>🍩 <strong>CASH</strong></span>
        <span class="mono">${((p.cash / (p.netWorth || 1)) * 100).toFixed(1)}%</span>
        <span class="alloc-bar"><span style="width:${Math.min(100, (p.cash / (p.netWorth || 1)) * 100)}%;background:var(--ink-4)"></span></span>
      </div>`;
  }

  function renderPositions(p) {
    positions = p.positions;
    const body = DM.$('#positions-body');
    if (!positions.length) {
      body.innerHTML = `<tr><td colspan="9" class="table-empty">
        No open positions. <a href="market.html" style="color:var(--gold-2)">Browse the market →</a></td></tr>`;
      return;
    }
    body.innerHTML = positions
      .map(
        (row) => `<tr>
          <td>
            <a href="${DM_UI.companyHref(row.companyId)}" class="cell-company">
              <span class="ico">${DM.esc(row.icon)}</span>
              <span><span class="nm">${DM.esc(row.name)}</span><br /><span class="tk">$${DM.esc(row.companyId.toUpperCase())}</span></span>
            </a>
          </td>
          <td class="num">${DM.qty(row.shares)}</td>
          <td class="num">${DM.price(row.avgPrice)}</td>
          <td class="num" style="font-weight:600">${DM.price(row.price)}</td>
          <td class="num ${DM.dirClass(row.dayChange)}">${DM.signed(row.dayChange)}</td>
          <td class="num ${DM.dirClass(row.unrealizedPnl)}">${DM.signed(row.unrealizedPnl)} <span class="tiny">(${DM.pct(row.unrealizedPct)})</span></td>
          <td class="num" style="font-weight:600">${DM.coins(row.value)}</td>
          <td class="num muted">${row.weightPct.toFixed(1)}%</td>
          <td style="text-align:right">
            <button class="btn btn-xs btn-buy" data-buy="${DM.esc(row.companyId)}">Buy</button>
            <button class="btn btn-xs btn-sell" data-sell="${DM.esc(row.companyId)}">Sell</button>
          </td>
        </tr>`
      )
      .join('');
  }

  function renderEquity(points) {
    if (!points || points.length < 2) return;
    const candles = points.map((p) => ({ t: p.t, o: p.v, h: p.v, l: p.v, c: p.v, v: 0 }));
    if (!equityChart) {
      equityChart = DM_CHART.create(DM.$('#equity-chart'), { type: 'area', showVolume: false });
    }
    equityChart.setData(candles, points[0].v);
  }

  async function loadOrders() {
    const { data } = await DM_API.orders(orderStatus);
    const body = DM.$('#orders-body');
    if (!data || !data.length) {
      body.innerHTML = `<tr><td colspan="8" class="table-empty">${
        orderStatus === 'open' ? 'No resting orders. Limit and stop orders wait here until the market reaches them.' : 'No orders yet.'
      }</td></tr>`;
      return;
    }
    body.innerHTML = data.map((o) => DM_UI.orderRow(o)).join('');
  }

  async function loadFills() {
    const { data } = await DM_API.myTrades(40);
    const body = DM.$('#fills-body');
    if (!data || !data.length) {
      body.innerHTML = '<tr><td colspan="9" class="table-empty">No fills yet.</td></tr>';
      return;
    }
    body.innerHTML = data
      .map(
        (t) => `<tr>
          <td class="num muted">${DM.dateTime(t.created_at)}</td>
          <td class="${t.type === 'buy' ? 'up' : 'down'}" style="text-transform:capitalize;font-weight:600">${DM.esc(t.type)}</td>
          <td><a href="${DM_UI.companyHref(t.companyId)}">${DM.esc(t.companies.icon)} ${DM.esc(t.companies.name)}</a></td>
          <td class="num">${DM.qty(t.shares)}</td>
          <td class="num">${DM.price(t.price)}</td>
          <td class="num ${t.slippage_pct > 0 ? 'down' : 'up'}" title="Fill price versus the mid quote when the order was sent">${DM.pct(t.slippage_pct)}</td>
          <td class="num muted">${DM.coinsExact(t.fees)}</td>
          <td class="num" style="font-weight:600">${DM.coins(t.total)}</td>
          <td class="num ${DM.dirClass(t.realized_pnl)}">${t.realized_pnl ? DM.signed(t.realized_pnl) : '—'}</td>
        </tr>`
      )
      .join('');
  }

  async function load() {
    if (!DM_API.isLoggedIn()) {
      DM.$('#logged-out').hidden = false;
      DM.$('#content').hidden = true;
      return;
    }
    DM.$('#logged-out').hidden = true;
    DM.$('#content').hidden = false;

    const { data, error } = await DM_API.portfolio();
    if (error) {
      DM.showBanner(`Couldn't load your portfolio: ${error.message}`, load);
      return;
    }
    DM.clearBanner();

    renderKpis(data);
    renderAllocation(data);
    renderPositions(data);
    renderEquity(data.equity);
    loadOrders();
    loadFills();
  }

  function wire() {
    DM.$('#orders-filter').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-status]');
      if (!btn) return;
      orderStatus = btn.dataset.status;
      DM.$$('#orders-filter button').forEach((b) => b.classList.toggle('active', b === btn));
      loadOrders();
    });

    DM.$('#orders-body').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-cancel]');
      if (!btn) return;
      btn.disabled = true;
      const { error } = await DM_API.cancelOrder(btn.dataset.cancel);
      if (error) { DM.toast(error.message, 'err'); btn.disabled = false; return; }
      DM.toast('Order cancelled.', 'ok');
      load();
      DM_SHELL.refreshProfile();
    });

    DM.$('#positions-body').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-buy], [data-sell]');
      if (!btn) return;
      const ticker = btn.dataset.buy || btn.dataset.sell;
      const position = positions.find((p) => p.companyId === ticker);
      if (position) {
        DM_TICKET.open(
          { ticker, name: position.name, icon: position.icon, price: position.price },
          btn.dataset.buy ? 'buy' : 'sell'
        );
      }
    });

    document.addEventListener('dm:trade', load);
    document.addEventListener('dm:signed-out', load);
  }

  document.addEventListener('DOMContentLoaded', () => {
    wire();
    load();
    DM.poll(load, 12000);
  });
})();
