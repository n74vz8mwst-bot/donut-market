/* ==========================================================================
   Log in / sign up. Honours ?mode=signup and ?next=<path> so a trader who
   hits the ticket while logged out lands back where they were.
   ========================================================================== */

(() => {
  let mode = DM.params().get('mode') === 'signup' ? 'signup' : 'login';

  function applyMode() {
    DM.$$('#auth-tabs .auth-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.mode === mode));
    DM.$('#username-group').hidden = mode !== 'signup';
    DM.$('#auth-submit').textContent = mode === 'signup' ? 'Create account' : 'Log in';
    DM.$('#password').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
    DM.$('#password-hint').textContent =
      mode === 'signup' ? 'At least 8 characters.' : 'The password you signed up with.';
    DM.$('#auth-switch-hint').innerHTML =
      mode === 'signup'
        ? 'Already have an account? <a href="#" data-switch="login">Log in</a>'
        : 'New here? <a href="#" data-switch="signup">Create an account</a>';
    document.title = `${mode === 'signup' ? 'Sign up' : 'Log in'} — Donut Market`;
  }

  function showError(message) {
    DM.$('#auth-error').innerHTML = message
      ? `<div class="alert alert-error" style="margin-bottom:14px">${DM.esc(message)}</div>`
      : '';
  }

  function redirect() {
    const next = DM.params().get('next');
    window.location.href = next && next.startsWith('/') ? next : 'portfolio.html';
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (DM_API.isLoggedIn()) return redirect();
    applyMode();

    DM.$('#auth-tabs').addEventListener('click', (e) => {
      const tab = e.target.closest('[data-mode]');
      if (!tab) return;
      mode = tab.dataset.mode;
      showError('');
      applyMode();
    });

    document.addEventListener('click', (e) => {
      const link = e.target.closest('[data-switch]');
      if (!link) return;
      e.preventDefault();
      mode = link.dataset.switch;
      showError('');
      applyMode();
    });

    DM.$('#auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const button = DM.$('#auth-submit');
      const email = DM.$('#email').value.trim();
      const password = DM.$('#password').value;
      const username = DM.$('#username').value.trim();

      if (!email || !password || (mode === 'signup' && !username)) {
        return showError('Please fill in every field.');
      }

      button.disabled = true;
      button.innerHTML = '<span class="spinner"></span> Working…';

      const { data, error } =
        mode === 'signup' ? await DM_API.signUp(username, email, password) : await DM_API.signIn(email, password);

      button.disabled = false;
      applyMode();

      if (error) return showError(error.message);

      DM.toast(
        mode === 'signup'
          ? `Welcome to the exchange — you're starting with ${DM.coins(data.balance)}.`
          : `Welcome back, ${data.username}.`,
        'ok'
      );
      setTimeout(redirect, 600);
    });
  });
})();
