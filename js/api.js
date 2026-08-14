/* ==========================================================================
   DONUT MARKET — api.js
   The only place that talks to the server.

   Every call returns { data, error } rather than throwing, so callers can show
   a real error state instead of a blank panel. Nothing in this file ever
   invents a fallback number: if the exchange can't be reached, pages say so.
   ========================================================================== */

const DM_API = (() => {
  const TOKEN_KEY = 'dm_token';

  const getToken = () => localStorage.getItem(TOKEN_KEY);
  const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
  const clearToken = () => localStorage.removeItem(TOKEN_KEY);
  const isLoggedIn = () => Boolean(getToken());

  // Free hosting (Render, Railway, Fly) suspends an idle instance and takes
  // the better part of a minute to wake it up again. That looks identical to
  // "the site is broken" unless we say something, so a request that's still
  // running after this long announces itself and the shell shows a notice.
  const SLOW_MS = 6000;
  const TIMEOUT_MS = 60000;

  async function request(path, options = {}) {
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const slow = setTimeout(() => document.dispatchEvent(new CustomEvent('dm:slow')), SLOW_MS);

    try {
      const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
      const token = getToken();
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await fetch(path, { ...options, headers, signal: controller.signal });
      clearTimeout(slow);
      clearTimeout(abort);
      document.dispatchEvent(new CustomEvent('dm:responsive'));

      let body = null;
      try { body = await res.json(); } catch (_e) { /* empty body is fine */ }

      if (res.status === 401 && token) {
        // The token expired or was signed with a different secret — treat it
        // as logged out rather than looping on failed authenticated calls.
        clearToken();
        document.dispatchEvent(new CustomEvent('dm:signed-out'));
      }
      if (!res.ok) {
        return { data: null, error: { message: (body && body.error) || res.statusText || 'Request failed.', status: res.status } };
      }
      return { data: body, error: null };
    } catch (err) {
      clearTimeout(slow);
      clearTimeout(abort);
      const message =
        err.name === 'AbortError'
          ? 'The exchange took too long to answer. If it’s on free hosting it may still be waking up — try again in a moment.'
          : "Can't reach the exchange — is the server running?";
      return { data: null, error: { message, status: 0 } };
    }
  }

  const get = (path) => request(path);
  const post = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body) });
  const patch = (path, body) => request(path, { method: 'PATCH', body: JSON.stringify(body) });
  const del = (path) => request(path, { method: 'DELETE' });

  /* ------------------------------------------------------------------ auth */

  async function signUp(username, email, password) {
    const res = await post('/api/auth/signup', { username, email, password });
    if (res.data && res.data.token) setToken(res.data.token);
    return res;
  }

  async function signIn(email, password) {
    const res = await post('/api/auth/login', { email, password });
    if (res.data && res.data.token) setToken(res.data.token);
    return res;
  }

  function signOut() {
    clearToken();
  }

  const me = () => (isLoggedIn() ? get('/api/auth/me') : Promise.resolve({ data: null, error: null }));

  /* ------------------------------------------------------------ market data */

  const companies = () => get('/api/companies');
  const company = (ticker) => get(`/api/companies/${encodeURIComponent(ticker)}`);
  const quotes = (tickers = []) =>
    get(`/api/companies/quotes${tickers.length ? `?tickers=${tickers.join(',')}` : ''}`);
  const candles = (ticker, tf = '5m', limit = 240) =>
    get(`/api/companies/${encodeURIComponent(ticker)}/candles?tf=${tf}&limit=${limit}`);
  const companyNews = (ticker, limit = 15) =>
    get(`/api/companies/${encodeURIComponent(ticker)}/news?limit=${limit}`);
  const tape = (ticker) => get(`/api/companies/${encodeURIComponent(ticker)}/tape`);

  const marketStatus = () => get('/api/market/status');
  const marketIndex = (tf = '15m', limit = 96) => get(`/api/market/index?tf=${tf}&limit=${limit}`);
  const movers = () => get('/api/market/movers');
  const news = (limit = 20) => get(`/api/market/news?limit=${limit}`);
  const recentTrades = (limit = 20) => get(`/api/market/trades?limit=${limit}`);
  const stats = () => get('/api/stats');
  const leaderboard = (limit = 100) => get(`/api/leaderboard?limit=${limit}`);

  /* ---------------------------------------------------------------- trading */

  const previewOrder = (order) => post('/api/orders/preview', order);
  const placeOrder = (order) => post('/api/orders', order);
  const orders = (status = 'open') => get(`/api/orders?status=${status}`);
  const cancelOrder = (id) => del(`/api/orders/${encodeURIComponent(id)}`);

  /* -------------------------------------------------------------- portfolio */

  const portfolio = () => get('/api/portfolio');
  const holdings = () => get('/api/portfolio/holdings');
  const myTrades = (limit = 25) => get(`/api/portfolio/trades?limit=${limit}`);
  const equity = (limit = 180) => get(`/api/portfolio/equity?limit=${limit}`);
  const watchlist = () => get('/api/portfolio/watchlist');
  const toggleWatch = (ticker) => request(`/api/portfolio/watchlist/${encodeURIComponent(ticker)}`, { method: 'PUT' });

  /* ------------------------------------------------------------------ admin */

  const admin = {
    overview: () => get('/api/admin/overview'),
    users: () => get('/api/admin/users'),
    setRole: (id, role) => patch(`/api/admin/users/${id}/role`, { role }),
    setBalance: (id, balance) => patch(`/api/admin/users/${id}/balance`, { balance }),
    adjustBalance: (id, delta) => patch(`/api/admin/users/${id}/balance`, { delta }),
    createCompany: (payload) => post('/api/admin/companies', payload),
    updateCompany: (ticker, payload) => patch(`/api/admin/companies/${ticker}`, payload),
    setPrice: (ticker, price) => patch(`/api/admin/companies/${ticker}/price`, { price }),
    setStatus: (ticker, status) => patch(`/api/admin/companies/${ticker}/status`, { status }),
    rebuildHistory: (ticker) => del(`/api/admin/companies/${ticker}/history`),
    publishEvent: (headline, companyId, impactPct) => post('/api/admin/events', { headline, companyId, impactPct }),
    events: () => get('/api/admin/events'),
    restingOrders: () => get('/api/admin/orders'),
    settings: () => get('/api/admin/settings'),
    updateSettings: (payload) => patch('/api/admin/settings', payload),
  };

  return {
    getToken, setToken, clearToken, isLoggedIn,
    signUp, signIn, signOut, me,
    companies, company, quotes, candles, companyNews, tape,
    marketStatus, marketIndex, movers, news, recentTrades, stats, leaderboard,
    previewOrder, placeOrder, orders, cancelOrder,
    portfolio, holdings, myTrades, equity, watchlist, toggleWatch,
    admin,
  };
})();

window.DM_API = DM_API;
