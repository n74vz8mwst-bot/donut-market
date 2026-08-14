/* ==========================================================================
   DONUT MARKET — ticket.js
   The order ticket: market, limit, stop and stop-limit orders.

   Before anything is sent, the ticket asks the server to price the order
   (POST /api/orders/preview) and shows what it would actually cost — the fill
   price after walking the book, the slippage against the mid, the commission,
   and the estimated impact the order will leave behind. That's the honest
   version of "estimated total", and it's the number that differs most from
   what a naive simulator would tell you.

   The same component renders inline on a company page and inside a modal
   everywhere else.
   ========================================================================== */

const DM_TICKET = (() => {
  const TYPES = [
    { value: 'market', label: 'Market' },
    { value: 'limit', label: 'Limit' },
    { value: 'stop', label: 'Stop' },
    { value: 'stop_limit', label: 'Stop limit' },
  ];

  function template(company, side) {
    return `
      <form class="ticket" novalidate>
        <div class="seg seg-buy" data-role="side">
          <button type="button" data-side="buy" class="${side === 'buy' ? 'active' : ''}">Buy</button>
          <button type="button" data-side="sell" class="${side === 'sell' ? 'active' : ''}">Sell</button>
        </div>

        <div class="form-row">
          <div class="form-group" style="margin:0;">
            <label for="tk-type">Order type</label>
            <select id="tk-type" name="type">
              ${TYPES.map((t) => `<option value="${t.value}">${t.label}</option>`).join('')}
            </select>
          </div>
          <div class="form-group" style="margin:0;">
            <label for="tk-qty">Shares</label>
            <input id="tk-qty" name="qty" type="number" min="1" step="1" value="10" inputmode="numeric" />
          </div>
        </div>

        <div class="qty-quick" data-role="quick">
          <button type="button" data-pct="25">25%</button>
          <button type="button" data-pct="50">50%</button>
          <button type="button" data-pct="100">Max</button>
        </div>

        <div class="form-row" data-role="prices" hidden>
          <div class="form-group" data-role="limit-wrap" style="margin:0;" hidden>
            <label for="tk-limit">Limit price</label>
            <div class="input-affix">
              <input id="tk-limit" name="limitPrice" type="number" min="0.01" step="0.01" />
              <span class="affix">DC</span>
            </div>
          </div>
          <div class="form-group" data-role="stop-wrap" style="margin:0;" hidden>
            <label for="tk-stop">Stop price</label>
            <div class="input-affix">
              <input id="tk-stop" name="stopPrice" type="number" min="0.01" step="0.01" />
              <span class="affix">DC</span>
            </div>
          </div>
        </div>

        <div class="form-group" data-role="tif-wrap" style="margin:0;" hidden>
          <label for="tk-tif">Time in force</label>
          <select id="tk-tif" name="tif">
            <option value="day">Day — expires at the close</option>
            <option value="gtc">GTC — good till cancelled</option>
          </select>
        </div>

        <div class="ticket-summary" data-role="summary">
          <div class="ticket-row"><span>Bid / Ask</span><span class="v" data-k="quote">—</span></div>
          <div class="ticket-row"><span data-k="price-label">Est. fill price</span><span class="v" data-k="price">—</span></div>
          <div class="ticket-row"><span>Commission</span><span class="v" data-k="fees">—</span></div>
          <div class="ticket-row total"><span data-k="total-label">Estimated cost</span><span class="v" data-k="total">—</span></div>
        </div>

        <div data-role="notes"></div>
        <div data-role="error"></div>

        <button type="submit" class="btn btn-buy btn-block" data-role="submit">Buy ${DM.esc(company.name || company.ticker || '')}</button>
        <div class="tiny muted" data-role="power">—</div>
      </form>`;
  }

  /**
   * Renders a ticket into `root`.
   * @param {HTMLElement} root
   * @param {object} company  { ticker, name, icon, price }
   * @param {object} opts     { side, onDone }
   */
  function mount(root, company, opts = {}) {
    root.innerHTML = template(company, opts.side || 'buy');

    const form = root.querySelector('form');
    const els = {
      side: form.querySelector('[data-role="side"]'),
      type: form.querySelector('#tk-type'),
      qty: form.querySelector('#tk-qty'),
      limit: form.querySelector('#tk-limit'),
      stop: form.querySelector('#tk-stop'),
      tif: form.querySelector('#tk-tif'),
      prices: form.querySelector('[data-role="prices"]'),
      limitWrap: form.querySelector('[data-role="limit-wrap"]'),
      stopWrap: form.querySelector('[data-role="stop-wrap"]'),
      tifWrap: form.querySelector('[data-role="tif-wrap"]'),
      quick: form.querySelector('[data-role="quick"]'),
      notes: form.querySelector('[data-role="notes"]'),
      error: form.querySelector('[data-role="error"]'),
      submit: form.querySelector('[data-role="submit"]'),
      power: form.querySelector('[data-role="power"]'),
      k: (name) => form.querySelector(`[data-k="${name}"]`),
    };

    let side = opts.side || 'buy';
    let preview = null;
    let busy = false;

    function currentType() {
      return els.type.value;
    }

    function syncFields() {
      const type = currentType();
      const needsLimit = type === 'limit' || type === 'stop_limit';
      const needsStop = type === 'stop' || type === 'stop_limit';
      els.limitWrap.hidden = !needsLimit;
      els.stopWrap.hidden = !needsStop;
      els.prices.hidden = !needsLimit && !needsStop;
      els.tifWrap.hidden = type === 'market';

      els.k('price-label').textContent = type === 'market' ? 'Est. fill price' : 'Limit / trigger';
      els.k('total-label').textContent = side === 'buy' ? 'Estimated cost' : 'Estimated proceeds';

      els.submit.className = `btn btn-block ${side === 'buy' ? 'btn-buy' : 'btn-sell'}`;
      const verb = side === 'buy' ? 'Buy' : 'Sell';
      els.submit.textContent = type === 'market' ? `${verb} ${company.name}` : `Place ${verb.toLowerCase()} order`;

      form.querySelectorAll('[data-side]').forEach((b) => b.classList.toggle('active', b.dataset.side === side));
    }

    function payload() {
      const type = currentType();
      return {
        ticker: company.ticker || company.id,
        side,
        orderType: type,
        qty: Number(els.qty.value) || 0,
        limitPrice: type === 'limit' || type === 'stop_limit' ? Number(els.limit.value) || null : null,
        stopPrice: type === 'stop' || type === 'stop_limit' ? Number(els.stop.value) || null : null,
        tif: type === 'market' ? 'day' : els.tif.value,
      };
    }

    function showError(message) {
      els.error.innerHTML = message ? `<div class="alert alert-error">${DM.esc(message)}</div>` : '';
    }

    function renderNotes(p) {
      const notes = [];
      if (!p.is_open) {
        notes.push({ kind: 'warn', text: 'The market is closed. Orders will be rejected until it reopens.' });
      } else if (p.session !== 'regular') {
        notes.push({
          kind: 'warn',
          text: `${p.session === 'pre' ? 'Pre-market' : 'After-hours'} session — spreads are wide and only limit orders are accepted.`,
        });
      }
      if (p.beyond_book) {
        notes.push({ kind: 'warn', text: 'This order is bigger than the visible book — the tail will fill well past the touch.' });
      } else if (Math.abs(p.slippage_pct) > 0.5) {
        notes.push({ kind: 'warn', text: `Sweeping ${p.sweeps_levels} price levels — expect ${DM.pct(p.slippage_pct)} of slippage.` });
      }
      if (Math.abs(p.estimated_impact_pct) > 1) {
        notes.push({ kind: 'info', text: `An order this size should move the price about ${p.estimated_impact_pct.toFixed(2)}%.` });
      }
      els.notes.innerHTML = notes
        .map((n) => `<div class="alert alert-${n.kind}" style="margin-bottom:8px">${DM.esc(n.text)}</div>`)
        .join('');
    }

    async function refreshPreview() {
      if (!DM_API.isLoggedIn()) {
        els.power.innerHTML = `<a href="${DM.link('login.html')}" style="color:var(--gold-2);font-weight:600">Log in</a> to place an order.`;
        return;
      }
      const body = payload();
      if (!body.qty || body.qty <= 0) {
        els.k('price').textContent = '—';
        els.k('total').textContent = '—';
        return;
      }

      const { data, error } = await DM_API.previewOrder(body);
      if (error) { showError(error.message); return; }
      showError('');
      preview = data;

      els.k('quote').textContent = `${DM.price(data.quote.bid)} / ${DM.price(data.quote.ask)}`;
      els.k('price').textContent = DM.coinsExact(data.expected_price);
      els.k('fees').textContent = DM.coinsExact(data.fees.total);
      els.k('total').textContent = DM.coinsExact(Math.abs(data.total));

      els.power.textContent =
        side === 'buy'
          ? `Buying power ${DM.coins(data.buying_power)}`
          : `${DM.qty(data.shares_available)} share(s) available to sell`;

      renderNotes(data);
    }

    const debouncedPreview = DM.debounce(refreshPreview, 220);

    /* --------------------------------------------------------- interactions */

    els.side.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-side]');
      if (!btn) return;
      side = btn.dataset.side;
      syncFields();
      refreshPreview();
    });

    els.type.addEventListener('change', () => {
      const type = currentType();
      // Seed sensible defaults: a limit just inside the spread, a stop a few
      // percent away on the correct side of the market.
      if (preview && preview.quote) {
        if ((type === 'limit' || type === 'stop_limit') && !els.limit.value) {
          els.limit.value = (side === 'buy' ? preview.quote.bid : preview.quote.ask).toFixed(2);
        }
        if ((type === 'stop' || type === 'stop_limit') && !els.stop.value) {
          const ref = side === 'buy' ? preview.quote.ask * 1.03 : preview.quote.bid * 0.97;
          els.stop.value = ref.toFixed(2);
        }
      }
      syncFields();
      refreshPreview();
    });

    [els.qty, els.limit, els.stop].forEach((input) => input.addEventListener('input', debouncedPreview));

    els.quick.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pct]');
      if (!btn || !preview) return;
      const pct = Number(btn.dataset.pct) / 100;
      if (side === 'buy') {
        const unit = preview.quote.ask || preview.expected_price || company.price;
        els.qty.value = Math.max(1, Math.floor((preview.buying_power * pct) / (unit * 1.01)));
      } else {
        els.qty.value = Math.max(1, Math.floor(preview.shares_available * pct));
      }
      refreshPreview();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;

      if (!DM_API.isLoggedIn()) {
        window.location.href = `${DM.link('login.html')}?next=${encodeURIComponent(location.pathname + location.search)}`;
        return;
      }

      busy = true;
      const originalLabel = els.submit.textContent;
      els.submit.disabled = true;
      els.submit.innerHTML = '<span class="spinner"></span> Sending…';

      const { data, error } = await DM_API.placeOrder(payload());

      busy = false;
      els.submit.disabled = false;
      els.submit.textContent = originalLabel;

      if (error) { showError(error.message); return; }
      showError('');

      if (data.resting) {
        DM.toast(`${data.order.type.replace('_', '-')} order resting: ${data.order.side} ${DM.qty(data.order.qty)} ${data.order.ticker.toUpperCase()}`, 'ok');
      } else {
        const f = data.fill;
        DM.toast(
          `${data.order.side === 'buy' ? 'Bought' : 'Sold'} ${DM.qty(f.shares)} ${data.order.ticker.toUpperCase()} @ ${DM.price(f.price)} · fees ${DM.coinsExact(f.fees.total)}`,
          'ok'
        );
      }

      document.dispatchEvent(new CustomEvent('dm:trade', { detail: data }));
      if (opts.onDone) opts.onDone(data);
    });

    syncFields();
    refreshPreview();

    return { refresh: refreshPreview, form };
  }

  /* ------------------------------------------------------------------ modal */

  let overlay = null;

  function ensureModal() {
    if (overlay) return overlay;
    overlay = DM.el('div', { class: 'modal-overlay' });
    overlay.innerHTML = `
      <div class="modal-card">
        <button class="modal-close" type="button" aria-label="Close">&times;</button>
        <div class="modal-head">
          <span class="modal-icon" data-k="icon">🍩</span>
          <div>
            <div class="modal-title" data-k="name">—</div>
            <div class="modal-sub" data-k="sub">—</div>
          </div>
        </div>
        <div data-k="body"></div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    return overlay;
  }

  function open(company, side = 'buy') {
    const node = ensureModal();
    node.querySelector('[data-k="icon"]').textContent = company.icon || '🍩';
    node.querySelector('[data-k="name"]').textContent = company.name || company.ticker;
    node.querySelector('[data-k="sub"]').textContent =
      `$${String(company.ticker || company.id).toUpperCase()} · ${DM.price(company.price)} DC`;
    mount(node.querySelector('[data-k="body"]'), company, { side, onDone: close });
    node.classList.add('open');
  }

  function close() {
    if (overlay) overlay.classList.remove('open');
  }

  return { mount, open, close };
})();

window.DM_TICKET = DM_TICKET;
