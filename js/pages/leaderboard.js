/* ==========================================================================
   Leaderboard — ranked by net worth, with the detail needed to see how each
   trader got there rather than just where they landed.
   ========================================================================== */

(() => {
  const medal = (rank) => (rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '');

  function render(rows) {
    const me = DM_SHELL.profile ? DM_SHELL.profile.username : null;
    const body = DM.$('#leaderboard-body');

    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="11" class="table-empty">No traders have registered yet.</td></tr>';
      return;
    }

    body.innerHTML = rows
      .map(
        (row) => `<tr${row.username === me ? ' style="background:var(--surface-hi)"' : ''}>
          <td><span class="rank-badge ${medal(row.rank)}">${row.rank}</span></td>
          <td>
            <div class="trader-cell">
              <div class="trader-avatar">${DM.esc(row.username.slice(0, 2).toUpperCase())}</div>
              <div>
                <div class="trader-name">${DM.esc(row.username)} ${row.username === me ? '<span class="you-badge">YOU</span>' : ''}</div>
                <div class="trader-tag">${row.top_holding ? `${row.top_holding.icon} ${row.top_holding.id.toUpperCase()} ${row.top_holding.weight_pct.toFixed(0)}%` : 'all cash'}</div>
              </div>
            </div>
          </td>
          <td class="num" style="font-weight:700">${DM.coins(row.net_worth)}</td>
          <td class="num muted">${DM.coins(row.balance)}</td>
          <td class="num">${row.positions}</td>
          <td class="num ${DM.dirClass(row.day_change)}">${DM.signed(row.day_change)}</td>
          <td class="num ${DM.dirClass(row.realized_pnl)}">${DM.signed(row.realized_pnl)}</td>
          <td class="num ${DM.dirClass(row.unrealized_pnl)}">${DM.signed(row.unrealized_pnl)}</td>
          <td class="num muted">${DM.coinsExact(row.fees_paid)}</td>
          <td class="num">${row.trades}</td>
          <td class="num ${DM.dirClass(row.profit_pct)}" style="font-weight:600">${DM.pct(row.profit_pct)}</td>
        </tr>`
      )
      .join('');

    DM.setText(DM.$('#lb-traders'), String(rows.length));
    DM.setText(DM.$('#lb-profitable'), String(rows.filter((r) => r.profit > 0).length));
    DM.setText(DM.$('#lb-trades'), DM.qty(rows.reduce((sum, r) => sum + r.trades, 0)));

    const best = [...rows].sort((a, b) => b.day_change - a.day_change)[0];
    const bestNode = DM.$('#lb-best');
    bestNode.textContent = DM.signed(best.day_change);
    bestNode.className = `v ${DM.dirClass(best.day_change)}`;
    DM.setText(DM.$('#lb-best-sub'), best.username);
  }

  async function load() {
    const { data, error } = await DM_API.leaderboard();
    if (error) {
      DM.showBanner(`Couldn't load the leaderboard: ${error.message}`, load);
      return;
    }
    DM.clearBanner();
    render(data);
  }

  document.addEventListener('DOMContentLoaded', () => {
    load();
    document.addEventListener('dm:profile', load);
    DM.poll(load, 15000);
  });
})();
