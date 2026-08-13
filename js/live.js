/* ==========================================================================
   DONUT MARKET — live.js
   Bridges data from the Express + MongoDB backend (see /backend) into the
   same shapes DM.renderStockCards() and DM.renderLeaderboard() expect, so
   no rendering code has to change.

   IMPORTANT: this file does NOT fall back to fake/demo numbers if the API
   call fails. Every fetch* function returns { list, error } — callers are
   expected to show a visible error state (see DM.showErrorBanner) rather
   than silently rendering placeholder data that looks real but isn't.
   ========================================================================== */

const DM_LIVE = (() => {

  function computeChange(company) {
    const base = Number(company.open_price) || Number(company.price);
    if (!base) return 0;
    return ((Number(company.price) - base) / base) * 100;
  }

  function mapCompany(c, historyByTicker) {
    return {
      id: c.id,
      name: c.name,
      icon: c.icon,
      price: Number(c.price),
      change: computeChange(c),
      status: c.status,
      sector: c.sector,
      liquidity: Number(c.liquidity),
      // Real recorded prices for this ticker, oldest first — used for
      // sparklines. Absent/undefined if the history call failed; renderers
      // treat that the same as "no history yet" (flat line), not as fake data.
      history: historyByTicker ? historyByTicker[c.id] : undefined,
    };
  }

  // Returns { list, error }. `list` is [] on failure — never demo data.
  async function fetchCompanies() {
    if (!(window.DM_DB && DM_DB.isConfigured())) {
      return { list: [], error: 'Backend not connected — see SETUP.md.' };
    }

    const [{ data, error }, historyRes] = await Promise.all([
      DM_DB.getCompanies(),
      DM_DB.getCompaniesHistory(),
    ]);

    if (error) {
      console.warn('Donut Market: failed to load companies.', error.message);
      return { list: [], error: error.message };
    }

    const historyByTicker = historyRes && !historyRes.error ? historyRes.data : null;
    return { list: (data || []).map((c) => mapCompany(c, historyByTicker)), error: null };
  }

  // Returns { list, error }. `list` is [] on failure — never demo data.
  async function fetchLeaderboard() {
    if (!(window.DM_DB && DM_DB.isConfigured())) {
      return { list: [], error: 'Backend not connected — see SETUP.md.' };
    }

    const { data, error } = await DM_DB.getLeaderboard();
    if (error) {
      console.warn('Donut Market: failed to load leaderboard.', error.message);
      return { list: [], error: error.message };
    }

    const list = (data || []).map((row, i) => ({
      rank: i + 1,
      name: row.username,
      tag: '@' + row.username,
      balance: Number(row.net_worth),
      profit: Number(row.profit_pct),
    }));
    return { list, error: null };
  }

  // Returns { stats, error }. `stats` is null on failure.
  async function fetchStats() {
    if (!(window.DM_DB && DM_DB.isConfigured())) {
      return { stats: null, error: 'Backend not connected — see SETUP.md.' };
    }

    const { data, error } = await DM_DB.getStats();
    if (error) {
      console.warn('Donut Market: failed to load market statistics.', error.message);
      return { stats: null, error: error.message };
    }
    return { stats: data, error: null };
  }

  return { fetchCompanies, fetchLeaderboard, fetchStats, mapCompany, computeChange };
})();

window.DM_LIVE = DM_LIVE;
