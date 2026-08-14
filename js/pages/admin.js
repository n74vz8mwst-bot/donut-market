/* ==========================================================================
   Admin console. Every action here hits an endpoint that re-checks the
   caller's role server-side — hiding the UI is a convenience, not the
   security boundary.
   ========================================================================== */

(() => {
  let companies = [];

  /* ------------------------------------------------------------------ util */

  function errorInto(id, message) {
    DM.$(id).innerHTML = message ? `<div class="alert alert-error" style="margin-bottom:12px">${DM.esc(message)}</div>` : '';
  }

  async function run(promise, okMessage, errorTarget) {
    const { data, error } = await promise;
    if (error) {
      if (errorTarget) errorInto(errorTarget, error.message);
      else DM.toast(error.message, 'err');
      return null;
    }
    if (errorTarget) errorInto(errorTarget, '');
    if (okMessage) DM.toast(okMessage, 'ok');
    return data;
  }

  /* -------------------------------------------------------------- overview */

  async function loadOverview() {
    const { data } = await DM_API.admin.overview();
    if (!data) return;

    const kpi = (k, v, sub = '') =>
      `<div class="kpi-card card"><div class="k">${k}</div><div class="v">${v}</div><div class="sub">${sub}</div></div>`;

    DM.$('#admin-kpis').innerHTML = [
      kpi('Donut 500', data.index ? DM.price(data.index.value) : '—',
        data.index ? `${DM.pct(data.index.change_pct)} today` : ''),
      kpi('Coins in circulation', DM.abbrev(data.totalCoins), `${data.traders} traders · ${data.admins} admin`),
      kpi('Trades (24h)', DM.qty(data.trades24h), `${data.openOrders} orders resting`),
      kpi('Listings', String(data.companies), data.halted ? `${data.halted} halted` : 'none halted'),
    ].join('');

    const stat = (k, v) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`;
    DM.$('#admin-session').innerHTML = [
      stat('Session', data.session.session),
      stat('Open', data.session.isOpen ? 'Yes' : 'No'),
      stat('Trading day', data.session.dayKey || '—'),
      stat('News (24h)', String(data.events24h)),
    ].join('');
  }

  /* -------------------------------------------------------------- listings */

  async function loadCompanies() {
    const { data } = await DM_API.companies();
    if (!data) return;
    companies = data;

    DM.$('#admin-companies').innerHTML = data
      .map(
        (c) => `<tr data-ticker="${DM.esc(c.ticker)}">
          <td>
            <div class="cell-company"><span class="ico">${DM.esc(c.icon)}</span>
              <span><span class="nm">${DM.esc(c.name)}</span><br /><span class="tk">$${DM.esc(c.ticker.toUpperCase())}</span></span>
            </div>
          </td>
          <td class="num">${DM.price(c.price)}</td>
          <td class="num ${DM.dirClass(c.change_pct)}">${DM.delta(c.change_pct)}</td>
          <td class="num">${c.annual_vol_pct.toFixed(0)}%</td>
          <td class="num">${c.beta.toFixed(2)}</td>
          <td class="num">${DM.abbrev(c.adv)}</td>
          <td>${DM_UI.statusPill(c)}</td>
          <td style="text-align:right;white-space:nowrap">
            <button class="btn btn-xs btn-ghost" data-price="${DM.esc(c.ticker)}">Set price</button>
            <button class="btn btn-xs btn-ghost" data-tune="${DM.esc(c.ticker)}">Tune</button>
            <button class="btn btn-xs btn-ghost" data-halt="${DM.esc(c.ticker)}">${c.status === 'halted' ? 'Resume' : 'Halt'}</button>
          </td>
        </tr>`
      )
      .join('');

    const select = DM.$('#ev-company');
    const current = select.value;
    select.innerHTML =
      '<option value="">Market-wide (no price impact)</option>' +
      data.map((c) => `<option value="${DM.esc(c.ticker)}">${DM.esc(c.icon)} ${DM.esc(c.name)}</option>`).join('');
    select.value = current;
  }

  async function onCompanyAction(e) {
    const priceBtn = e.target.closest('[data-price]');
    const tuneBtn = e.target.closest('[data-tune]');
    const haltBtn = e.target.closest('[data-halt]');

    if (priceBtn) {
      const ticker = priceBtn.dataset.price;
      const company = companies.find((c) => c.ticker === ticker);
      const input = window.prompt(`New price for ${company.name} (currently ${DM.price(company.price)} DC):`, company.price);
      if (input === null) return;
      const value = Number(input);
      if (!Number.isFinite(value) || value <= 0) return DM.toast('That is not a valid price.', 'err');
      await run(DM_API.admin.setPrice(ticker, value), `${ticker.toUpperCase()} marked at ${DM.price(value)} DC.`);
      loadCompanies();
    }

    if (tuneBtn) {
      const ticker = tuneBtn.dataset.tune;
      const company = companies.find((c) => c.ticker === ticker);
      const vol = window.prompt(
        `Annual volatility for ${company.name}, as a decimal (0.35 = 35%).\nBlank resets it to the value derived from liquidity.`,
        (company.annual_vol_pct / 100).toFixed(2)
      );
      if (vol === null) return;
      await run(DM_API.admin.updateCompany(ticker, { annualVol: vol === '' ? '' : Number(vol) }), 'Simulation updated.');
      loadCompanies();
    }

    if (haltBtn) {
      const ticker = haltBtn.dataset.halt;
      const company = companies.find((c) => c.ticker === ticker);
      const next = company.status === 'halted' ? 'open' : 'halted';
      await run(
        DM_API.admin.setStatus(ticker, next),
        next === 'halted' ? `${ticker.toUpperCase()} halted — orders will be rejected.` : `${ticker.toUpperCase()} resumed.`
      );
      loadCompanies();
    }
  }

  async function onNewCompany(e) {
    e.preventDefault();
    const payload = {
      id: DM.$('#nc-id').value.trim(),
      name: DM.$('#nc-name').value.trim(),
      icon: DM.$('#nc-icon').value.trim() || '🍩',
      sector: DM.$('#nc-sector').value.trim() || 'General',
      description: DM.$('#nc-description').value.trim(),
      price: Number(DM.$('#nc-price').value),
      liquidity: Number(DM.$('#nc-liquidity').value) || undefined,
      sharesOutstanding: Number(DM.$('#nc-shares').value) || undefined,
      annualVol: DM.$('#nc-vol').value === '' ? undefined : Number(DM.$('#nc-vol').value),
    };
    const data = await run(DM_API.admin.createCompany(payload), null, '#nc-error');
    if (!data) return;
    DM.toast(`${data.name} listed with ten days of backfilled history.`, 'ok');
    e.target.reset();
    loadCompanies();
  }

  /* ------------------------------------------------------------------ news */

  async function loadNews() {
    const { data } = await DM_API.admin.events();
    if (data) DM_UI.renderNews('#admin-news', data);
  }

  async function onPublish(e) {
    e.preventDefault();
    const data = await run(
      DM_API.admin.publishEvent(
        DM.$('#ev-headline').value.trim(),
        DM.$('#ev-company').value || null,
        Number(DM.$('#ev-impact').value) || 0
      ),
      null,
      '#ev-error'
    );
    if (!data) return;
    DM.toast('Published to the wire.', 'ok');
    DM.$('#ev-headline').value = '';
    DM.$('#ev-impact').value = '';
    loadNews();
    loadCompanies();
  }

  /* --------------------------------------------------------------- traders */

  async function loadUsers() {
    const { data } = await DM_API.admin.users();
    if (!data) return;
    DM.$('#admin-users').innerHTML = data
      .map(
        (u) => `<tr data-user="${DM.esc(u.id)}">
          <td>
            <div class="trader-cell">
              <div class="trader-avatar">${DM.esc(u.username.slice(0, 2).toUpperCase())}</div>
              <div><div class="trader-name">${DM.esc(u.username)}</div><div class="trader-tag">${DM.esc(u.email)}</div></div>
            </div>
          </td>
          <td class="num">${DM.coins(u.balance)}</td>
          <td class="num muted">${DM.coins(u.reserved_cash)}</td>
          <td class="num ${DM.dirClass(u.realized_pnl)}">${DM.signed(u.realized_pnl)}</td>
          <td class="num">${u.tradeCount || 0}</td>
          <td><span class="pill ${u.role === 'admin' ? 'pill-up' : 'pill-neutral'}">${DM.esc(u.role)}</span></td>
          <td style="text-align:right;white-space:nowrap">
            <button class="btn btn-xs btn-ghost" data-grant="${DM.esc(u.id)}">Adjust coins</button>
            <button class="btn btn-xs btn-ghost" data-role="${DM.esc(u.id)}" data-current="${DM.esc(u.role)}">
              ${u.role === 'admin' ? 'Demote' : 'Promote'}
            </button>
          </td>
        </tr>`
      )
      .join('');
  }

  async function onUserAction(e) {
    const grant = e.target.closest('[data-grant]');
    const role = e.target.closest('[data-role]');

    if (grant) {
      const input = window.prompt('Adjust this trader\'s balance by how many Donut Coins?\nUse a negative number to take coins away.', '1000');
      if (input === null) return;
      const delta = Number(input);
      if (!Number.isFinite(delta) || delta === 0) return DM.toast('Enter a non-zero number.', 'err');
      await run(DM_API.admin.adjustBalance(grant.dataset.grant, delta), 'Balance adjusted.');
      loadUsers();
    }

    if (role) {
      const next = role.dataset.current === 'admin' ? 'trader' : 'admin';
      if (!window.confirm(`Change this account's role to ${next}?`)) return;
      await run(DM_API.admin.setRole(role.dataset.role, next), `Role set to ${next}.`);
      loadUsers();
    }
  }

  /* ---------------------------------------------------------------- orders */

  async function loadOrders() {
    const { data } = await DM_API.admin.restingOrders();
    const body = DM.$('#admin-orders');
    if (!data || !data.length) {
      body.innerHTML = '<tr><td colspan="9" class="table-empty">No resting orders on the exchange.</td></tr>';
      return;
    }
    body.innerHTML = data
      .map(
        (o) => `<tr>
          <td>${DM.esc(o.trader)}</td>
          <td><a href="${DM_UI.companyHref(o.ticker)}">$${DM.esc(o.ticker.toUpperCase())}</a></td>
          <td class="${o.side === 'buy' ? 'up' : 'down'}" style="text-transform:capitalize">${DM.esc(o.side)}</td>
          <td style="text-transform:capitalize">${DM.esc(o.type.replace('_', ' '))}</td>
          <td class="num">${DM.qty(o.qty)}</td>
          <td class="num">${o.limit_price ? DM.price(o.limit_price) : '—'}</td>
          <td class="num">${o.stop_price ? DM.price(o.stop_price) : '—'}</td>
          <td><span class="pill pill-neutral">${DM.esc(o.status)}</span></td>
          <td class="num muted">${DM.dateTime(o.created_at)}</td>
        </tr>`
      )
      .join('');
  }

  /* -------------------------------------------------------------- settings */

  async function loadSettings() {
    const { data } = await DM_API.admin.settings();
    if (!data) return;
    DM.$('#st-mode').value = data.marketMode;
    DM.$('#st-start').value = data.startingBalance;
    DM.$('#st-commission').value = data.commissionBps;
    DM.$('#st-mincommission').value = data.minCommission;
    DM.$('#st-sellfee').value = data.sellFeeBps;
    DM.$('#st-maxorder').value = data.maxOrderNotional;
    DM.$('#st-maxposition').value = data.maxPositionPct;
    DM.$('#st-extended').value = String(data.allowExtendedHours);
  }

  async function onSaveSettings(e) {
    e.preventDefault();
    const payload = {
      marketMode: DM.$('#st-mode').value,
      startingBalance: Number(DM.$('#st-start').value),
      commissionBps: Number(DM.$('#st-commission').value),
      minCommission: Number(DM.$('#st-mincommission').value),
      sellFeeBps: Number(DM.$('#st-sellfee').value),
      maxOrderNotional: Number(DM.$('#st-maxorder').value),
      maxPositionPct: Number(DM.$('#st-maxposition').value),
      allowExtendedHours: DM.$('#st-extended').value === 'true',
    };
    const data = await run(DM_API.admin.updateSettings(payload), null, '#st-error');
    if (data) {
      DM.toast('Exchange rules updated.', 'ok');
      DM_SHELL.refreshStatus();
    }
  }

  /* ------------------------------------------------------------------ init */

  function wireNav() {
    DM.$('#admin-nav').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-section]');
      if (!btn) return;
      DM.$$('#admin-nav button').forEach((b) => b.classList.toggle('active', b === btn));
      DM.$$('.admin-section').forEach((s) => s.classList.toggle('active', s.dataset.section === btn.dataset.section));
    });
  }

  async function boot() {
    const profile = await DM_SHELL.refreshProfile();
    if (!profile || profile.role !== 'admin') {
      DM.$('#denied').hidden = false;
      return;
    }
    DM.$('#console').hidden = false;

    wireNav();
    DM.$('#new-company-form').addEventListener('submit', onNewCompany);
    DM.$('#admin-companies').addEventListener('click', onCompanyAction);
    DM.$('#event-form').addEventListener('submit', onPublish);
    DM.$('#admin-users').addEventListener('click', onUserAction);
    DM.$('#settings-form').addEventListener('submit', onSaveSettings);

    loadOverview();
    loadCompanies();
    loadNews();
    loadUsers();
    loadOrders();
    loadSettings();

    DM.poll(() => { loadOverview(); loadCompanies(); loadOrders(); }, 15000);
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
