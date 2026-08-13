/* ==========================================================================
   DONUT MARKET — live.js
   Bridges real Supabase data into the same shapes DM.renderStockCards() and
   DM.renderLeaderboard() already expect, so no rendering code has to change.
   Falls back to the demo dataset in main.js if the backend isn't configured
   yet, so the site still looks complete before you set up Supabase.
   ========================================================================== */

const DM_LIVE = (() => {

  function computeChange(company) {
    const base = Number(company.open_price) || Number(company.price);
    if (!base) return 0;
    return ((Number(company.price) - base) / base) * 100;
  }

  function mapCompany(c) {
    return {
      id: c.id,
      name: c.name,
      icon: c.icon,
      price: Number(c.price),
      change: computeChange(c),
      status: c.status,
      sector: c.sector,
      liquidity: Number(c.liquidity),
    };
  }

  async function fetchCompanies() {
    if (window.DM_DB && DM_DB.isConfigured()) {
      const { data, error } = await DM_DB.getCompanies();
      if (!error && data && data.length) return data.map(mapCompany);
      if (error) console.warn('Donut Market: failed to load live companies, using demo data.', error.message);
    }
    return DM.data.companies;
  }

  async function fetchLeaderboard() {
    if (window.DM_DB && DM_DB.isConfigured()) {
      const { data, error } = await DM_DB.getLeaderboard();
      if (!error && data) {
        return data.map((row, i) => ({
          rank: i + 1,
          name: row.username,
          tag: '@' + row.username,
          balance: Number(row.net_worth),
          profit: Number(row.profit_pct),
        }));
      }
      if (error) console.warn('Donut Market: failed to load live leaderboard, using demo data.', error.message);
    }
    return DM.data.leaderboard;
  }

  return { fetchCompanies, fetchLeaderboard, mapCompany, computeChange };
})();

window.DM_LIVE = DM_LIVE;
