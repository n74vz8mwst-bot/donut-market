/* ==========================================================================
   DONUT MARKET — trade-modal.js
   A single reusable Buy/Sell dialog. Any page can call:
     DM_TRADE.open({ id, name, icon, price }, 'buy' | 'sell')
   It talks to execute_trade() in Supabase, which is the only place prices
   and balances actually change — driven entirely by order size vs. demand.
   ========================================================================== */

const DM_TRADE = (() => {
  let current = null;

  function pagesPrefix() {
    return location.pathname.includes('/pages/') ? '' : 'pages/';
  }

  function ensureModal() {
    if (document.getElementById('dm-trade-modal')) return;

    const wrap = document.createElement('div');
    wrap.id = 'dm-trade-modal';
    wrap.className = 'modal-overlay';
    wrap.innerHTML = `
      <div class="modal-card glass">
        <button class="modal-close" type="button" aria-label="Close">&times;</button>
        <div class="modal-head">
          <span class="modal-icon" id="dm-trade-icon">🍩</span>
          <div>
            <div class="modal-title" id="dm-trade-title">Buy</div>
            <div class="modal-sub" id="dm-trade-sub">Price: 0 DC</div>
          </div>
        </div>
        <div class="form-group">
          <label for="dm-trade-shares">Shares</label>
          <input type="number" id="dm-trade-shares" min="1" step="1" value="1" />
        </div>
        <div class="modal-total-row">
          <span>Estimated total</span>
          <span id="dm-trade-total" class="mono">0 DC</span>
        </div>
        <div id="dm-trade-error" class="modal-error" style="display:none;"></div>
        <button class="btn btn-primary btn-block" id="dm-trade-confirm" type="button">Confirm</button>
      </div>
    `;
    document.body.appendChild(wrap);

    wrap.querySelector('.modal-close').addEventListener('click', close);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    wrap.querySelector('#dm-trade-shares').addEventListener('input', updateTotal);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }

  function updateTotal() {
    const shares = parseFloat(document.getElementById('dm-trade-shares').value) || 0;
    document.getElementById('dm-trade-total').textContent = DM.formatNumber(shares * current.price) + ' DC';
  }

  function showError(msg) {
    const el = document.getElementById('dm-trade-error');
    el.textContent = msg;
    el.style.display = 'block';
  }

  function open(company, type) {
    ensureModal();
    current = company;
    current.type = type;

    document.getElementById('dm-trade-icon').textContent = company.icon || '🍩';
    document.getElementById('dm-trade-title').textContent = `${type === 'buy' ? 'Buy' : 'Sell'} ${company.name}`;
    document.getElementById('dm-trade-sub').textContent = `Price: ${DM.formatNumber(company.price)} DC · $${company.id.toUpperCase()}`;
    document.getElementById('dm-trade-shares').value = 1;
    document.getElementById('dm-trade-error').style.display = 'none';

    const confirmBtn = document.getElementById('dm-trade-confirm');
    confirmBtn.textContent = type === 'buy' ? 'Confirm buy' : 'Confirm sell';
    confirmBtn.onclick = confirmTrade;

    updateTotal();
    document.getElementById('dm-trade-modal').classList.add('open');
    document.getElementById('dm-trade-shares').focus();
  }

  function close() {
    const modal = document.getElementById('dm-trade-modal');
    if (modal) modal.classList.remove('open');
  }

  async function confirmTrade() {
    if (!window.DM_DB || !DM_DB.isConfigured()) {
      showError('Backend not connected yet — see SETUP.md to go live.');
      return;
    }

    const { data: { session } } = await DM_DB.getSession();
    if (!session) {
      close();
      DM.openToast('Log in to place a trade.');
      window.location.href = pagesPrefix() + 'login.html';
      return;
    }

    const shares = parseFloat(document.getElementById('dm-trade-shares').value);
    if (!shares || shares <= 0) {
      showError('Enter a valid number of shares.');
      return;
    }

    const confirmBtn = document.getElementById('dm-trade-confirm');
    confirmBtn.textContent = 'Placing order…';
    confirmBtn.disabled = true;

    const { data, error } = await DM_DB.executeTrade(current.id, current.type, shares);

    confirmBtn.disabled = false;
    confirmBtn.textContent = current.type === 'buy' ? 'Confirm buy' : 'Confirm sell';

    if (error) {
      showError(error.message.replace(/^.*?:\s*/, ''));
      return;
    }

    close();
    DM.openToast(`${current.type === 'buy' ? 'Bought' : 'Sold'} ${shares} share${shares == 1 ? '' : 's'} of ${current.name}.`);
    document.dispatchEvent(new CustomEvent('dm:trade-complete', { detail: data }));
  }

  return { open, close };
})();

window.DM_TRADE = DM_TRADE;
