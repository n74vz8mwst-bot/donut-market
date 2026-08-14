/* ==========================================================================
   Home page — the index chart, exchange statistics, movers, news wire and a
   slice of the leaderboard. Everything on this page is a live query; nothing
   is a decorative constant.
   ========================================================================== */

(() => {
  let heroChart = null;

  async function loadIndex() {
    const { data, error } = await DM_API.marketIndex('15m', 96);
    if (error || !data || !data.index) return;

    const { index, history } = data;
    const dir = DM.dirClass(index.change_pct);

    DM.setText(DM.$('#hero-index-value'), DM.price(index.value));
    const change = DM.$('#hero-index-change');
    change.textContent = `${DM.signed(index.change)} (${DM.pct(index.change_pct)})`;
    change.className = `mono ${dir}`;
    DM.setText(DM.$('#hero-index-breadth'), `${index.advancers} up · ${index.decliners} down`);
    DM.setText(DM.$('#proof-index'), DM.price(index.value));

    const candles = history.map((p) => ({ t: p.t, o: p.v, h: p.v, l: p.v, c: p.v, v: 0 }));
    if (!heroChart) {
      heroChart = DM_CHART.create(DM.$('#hero-chart'), { type: 'area', showVolume: false });
    }
    heroChart.setData(candles, index.prev_close);
  }

  async function loadStats() {
    const { data, error } = await DM_API.stats();
    if (error || !data) {
      DM.showBanner(`Couldn't load exchange statistics: ${error ? error.message : 'unknown error'}`, loadStats);
      return;
    }

    DM.countUp(DM.$('#stat-coins'), Math.round(data.totalCoins), { suffix: ' DC' });
    DM.countUp(DM.$('#stat-companies'), data.companiesListed);
    DM.countUp(DM.$('#stat-traders'), data.activeTraders);
    DM.countUp(DM.$('#stat-trades'), data.tradesToday);

    DM.setText(DM.$('#stat-companies-sub'),
      data.newCompaniesThisMonth > 0 ? `▲ ${data.newCompaniesThisMonth} listed in the last 30 days` : 'No new listings this month');
    DM.setText(DM.$('#stat-traders-sub'),
      `${data.registeredTraders} registered · ${data.newUsersToday} joined today`);
    DM.setText(DM.$('#stat-trades-sub'),
      data.tradesDeltaPct === null
        ? `${DM.abbrev(data.volumeToday)} DC traded today`
        : `${DM.delta(data.tradesDeltaPct)} vs yesterday · ${DM.abbrev(data.volumeToday)} DC`);

    DM.setText(DM.$('#proof-traders'), DM.qty(data.activeTraders));
    DM.setText(DM.$('#proof-trades'), DM.qty(data.tradesToday));
  }

  async function loadMovers() {
    const { data, error } = await DM_API.companies();
    if (error) {
      DM.showBanner(`Couldn't load live market data: ${error.message}`, loadMovers);
      return;
    }
    DM.clearBanner();
    // The four biggest absolute movers — the ones worth looking at right now.
    const featured = [...data].sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct)).slice(0, 4);
    DM_UI.renderCards('#featured-stocks', featured);
  }

  async function loadNews() {
    const { data, error } = await DM_API.news(7);
    if (!error && data) DM_UI.renderNews('#home-news', data);
  }

  async function loadLeaderboard() {
    const { data, error } = await DM_API.leaderboard(5);
    const body = DM.$('#leaderboard-preview');
    if (error || !data) {
      body.innerHTML = '<tr><td colspan="5" class="table-empty">Leaderboard unavailable.</td></tr>';
      return;
    }
    if (!data.length) {
      body.innerHTML = '<tr><td colspan="5" class="table-empty">No traders yet — be the first.</td></tr>';
      return;
    }
    const medal = (rank) => (rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '');
    body.innerHTML = data
      .map(
        (row) => `<tr>
          <td><span class="rank-badge ${medal(row.rank)}">${row.rank}</span></td>
          <td>
            <div class="trader-cell">
              <div class="trader-avatar">${DM.esc(row.username.slice(0, 2).toUpperCase())}</div>
              <div><div class="trader-name">${DM.esc(row.username)}</div>
              <div class="trader-tag">${row.trades} trades · ${row.positions} positions</div></div>
            </div>
          </td>
          <td class="num">${DM.coins(row.net_worth)}</td>
          <td class="num ${DM.dirClass(row.day_change)}">${DM.signed(row.day_change)}</td>
          <td class="num ${DM.dirClass(row.profit_pct)}">${DM.pct(row.profit_pct)}</td>
        </tr>`
      )
      .join('');
  }

  function loadAll() {
    loadIndex();
    loadStats();
    loadMovers();
    loadNews();
    loadLeaderboard();
  }

  document.addEventListener('DOMContentLoaded', () => {
    loadAll();
    DM.poll(() => { loadIndex(); loadMovers(); }, 6000);
    DM.poll(() => { loadNews(); loadStats(); }, 30000);
  });
})();
