/* ==========================================================================
   DONUT MARKET — auth-ui.js
   Swaps the navbar's Login/Start Trading buttons for a balance pill + log out
   once a real Supabase session exists. Runs on every page. In demo mode
   (Supabase not configured) it does nothing, leaving the static markup as-is.
   ========================================================================== */

const DM_AUTH_UI = (() => {

  function inPagesFolder() {
    return location.pathname.includes('/pages/');
  }

  function href(pageFile) {
    return inPagesFolder() ? pageFile : 'pages/' + pageFile;
  }

  function rootHref() {
    return inPagesFolder() ? '../index.html' : 'index.html';
  }

  async function render() {
    if (!window.DM_DB || !DM_DB.isConfigured()) return;

    const { data: { session } } = await DM_DB.getSession();

    if (!session) {
      document.querySelectorAll('[data-requires-admin]').forEach(el => el.style.display = 'none');
      return;
    }

    const { data: profile } = await DM_DB.getMyProfile();
    if (!profile) return;

    document.querySelectorAll('.nav-actions').forEach(actions => {
      actions.innerHTML = `
        <span class="balance-pill mono" title="Your Donut Coin balance">🍩 ${DM.formatNumber(profile.balance)} DC</span>
        ${profile.role === 'admin' ? `<a href="${href('admin.html')}" class="btn btn-ghost btn-sm">Admin</a>` : ''}
        <button class="btn btn-primary btn-sm" id="dm-logout-btn" type="button">Log out</button>
      `;
    });

    document.querySelectorAll('.mobile-menu').forEach(menu => {
      const loginLink = Array.from(menu.querySelectorAll('a')).find(a => a.textContent.trim() === 'Login');
      if (loginLink) {
        loginLink.textContent = 'Log out';
        loginLink.href = '#';
        loginLink.addEventListener('click', (e) => { e.preventDefault(); logout(); });
      }
    });

    document.querySelectorAll('#dm-logout-btn').forEach(btn => btn.addEventListener('click', logout));

    document.dispatchEvent(new CustomEvent('dm:profile-loaded', { detail: profile }));
  }

  async function logout() {
    await DM_DB.signOut();
    window.location.href = rootHref();
  }

  async function requireLogin(message) {
    const { data: { session } } = await DM_DB.getSession();
    if (!session) {
      DM.openToast(message || 'Log in to continue.');
      setTimeout(() => { window.location.href = href('login.html'); }, 900);
      return null;
    }
    return session;
  }

  return { render, logout, requireLogin };
})();

window.DM_AUTH_UI = DM_AUTH_UI;

document.addEventListener('DOMContentLoaded', () => { DM_AUTH_UI.render(); });
