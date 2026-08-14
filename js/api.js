/* ==========================================================================
   DONUT MARKET — api.js
   Talks to your own Express + MongoDB backend (see /backend). Since the
   backend serves the frontend itself (see backend/server.js), API calls are
   same-origin relative paths — no URL to configure.
   Keeps the same DM_DB.* method names/shapes the rest of the site already
   expects, so live.js / trade-modal.js / auth-ui.js work unchanged.
   ========================================================================== */

const DM_DB = (() => {
  const TOKEN_KEY = "dm_token";

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
  function clearToken() { localStorage.removeItem(TOKEN_KEY); }

  async function request(path, options = {}) {
    try {
      const headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
      const token = getToken();
      if (token) headers["Authorization"] = "Bearer " + token;

      const res = await fetch(path, Object.assign({}, options, { headers }));

      let body = null;
      try { body = await res.json(); } catch (_e) { /* empty body is fine */ }

      if (!res.ok) {
        return { data: null, error: { message: (body && body.error) || res.statusText || "Request failed." } };
      }
      return { data: body, error: null };
    } catch (_err) {
      return { data: null, error: { message: "Can't reach the server — is the backend running?" } };
    }
  }

  // The backend is same-origin and either reachable or not — there's no
  // separate "configured/unconfigured" state like an external API key would
  // need. Kept as a function so live.js / trade-modal.js don't need changes.
  function isConfigured() { return true; }

  /* ---------------------------- AUTH ---------------------------- */

  async function signUp(username, email, password) {
    const { data, error } = await request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ username, email, password }),
    });
    if (error) return { data: null, error };
    setToken(data.token);
    return { data, error: null };
  }

  async function signIn(email, password) {
    const { data, error } = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if (error) return { data: null, error };
    setToken(data.token);
    return { data, error: null };
  }

  async function signOut() {
    clearToken();
    return { error: null };
  }

  async function getSession() {
    const token = getToken();
    return { data: { session: token ? { token } : null } };
  }

  // No websocket/session-event stream in this simple REST backend — kept as
  // a no-op so any page that calls it doesn't break.
  function onAuthStateChange() {
    return { data: { subscription: { unsubscribe() {} } } };
  }

  /* -------------------------- PROFILE -------------------------- */

  async function getMyProfile() {
    if (!getToken()) return { data: null, error: null };
    return request("/api/auth/me");
  }

  /* --------------------------- MARKET DATA --------------------------- */

  async function getCompanies() {
    return request("/api/companies");
  }

  // Real recorded price history for every company in one call, e.g.
  // { dnut: [250.4, 251.1, ...] }. Used for sparklines — see js/live.js.
  async function getCompaniesHistory() {
    return request("/api/companies/history/all");
  }

  // Real, database-backed homepage market statistics (total coins in
  // circulation, companies listed, active traders, trades today).
  async function getStats() {
    return request("/api/stats");
  }

  async function getMyHoldings() {
    if (!getToken()) return { data: [], error: null };
    return request("/api/portfolio/holdings");
  }

  async function getMyTrades(limit = 25) {
    if (!getToken()) return { data: [], error: null };
    return request("/api/portfolio/trades?limit=" + limit);
  }

  async function executeTrade(companyId, type, shares) {
    return request("/api/trade", {
      method: "POST",
      body: JSON.stringify({ companyId, type, shares }),
    });
  }

  async function getLeaderboard() {
    return request("/api/leaderboard");
  }

  // No realtime layer here (would need websockets/SSE) — pages that want
  // fresh prices just re-fetch on an interval or after a trade completes.
  function subscribeToCompanies() { return null; }

  /* ------------------------------ ADMIN ------------------------------ */

  async function adminSetPrice(companyId, newPrice) {
    return request(`/api/admin/companies/${companyId}/price`, {
      method: "PATCH",
      body: JSON.stringify({ price: newPrice }),
    });
  }

  async function adminCreateCompany({ id, name, icon, sector, price, liquidity }) {
    return request("/api/admin/companies", {
      method: "POST",
      body: JSON.stringify({ id, name, icon, sector, price, liquidity }),
    });
  }

  async function adminToggleStatus(companyId) {
    return request(`/api/admin/companies/${companyId}/toggle`, { method: "PATCH" });
  }

  async function adminPublishEvent(headline, companyId, impactPct) {
    return request("/api/admin/events", {
      method: "POST",
      body: JSON.stringify({ headline, companyId, impactPct }),
    });
  }

  async function adminGetUsers() {
    return request("/api/admin/users");
  }

  async function adminSetRole(userId, role) {
    return request(`/api/admin/users/${userId}/role`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    });
  }

  async function adminSetBalance(userId, balance) {
    return request(`/api/admin/users/${userId}/balance`, {
      method: "PATCH",
      body: JSON.stringify({ balance }),
    });
  }

  async function adminAdjustBalance(userId, delta) {
    return request(`/api/admin/users/${userId}/balance`, {
      method: "PATCH",
      body: JSON.stringify({ delta }),
    });
  }

  async function adminGetEvents() {
    return request("/api/admin/events");
  }

  async function adminGetSettings() {
    return request("/api/admin/settings");
  }

  async function adminUpdateSettings(settings) {
    return request("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify(settings),
    });
  }

  return {
    isConfigured,
    signUp, signIn, signOut, getSession, onAuthStateChange,
    getMyProfile,
    getCompanies, getCompaniesHistory, getStats, getMyHoldings, getMyTrades, executeTrade, getLeaderboard, subscribeToCompanies,
    adminSetPrice, adminCreateCompany, adminToggleStatus, adminPublishEvent,
    adminGetUsers, adminSetRole, adminSetBalance, adminAdjustBalance, adminGetEvents,
    adminGetSettings, adminUpdateSettings,
  };
})();

window.DM_DB = DM_DB;
