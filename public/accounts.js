async function loadAccounts() {
  const list = document.getElementById('accounts-list');
  list.innerHTML = '<li class="loading"><span class="spinner"></span> Loading accounts…</li>';
  try {
    const accounts = await apiJson('/api/v1/social-accounts');
    let reconnectTargets = {};
    try {
      reconnectTargets = JSON.parse(list.dataset.reconnect || '{}');
    } catch {
      // fall back to no Reconnect buttons
    }
    list.innerHTML =
      accounts
        .map((a) => {
          const issue = accountConnectionIssue(a);
          const target = reconnectTargets[a.platform];
          const days = a.token_expires_at
            ? Math.max(0, Math.ceil((new Date(a.token_expires_at).getTime() - Date.now()) / 86400000))
            : null;
          const pill =
            issue === 'reconnect'
              ? `<span class="account-issue account-issue-reconnect" title="${escapeHtml(a.reconnect_reason || '')}">Needs reconnecting</span>`
              : issue === 'expiring'
                ? `<span class="account-issue account-issue-expiring">${days === 0 ? 'Expires today' : `Expires in ${days} day${days === 1 ? '' : 's'}`}</span>`
                : '';
          return `
      <li class="${issue ? 'has-issue' : ''}">
        ${accountAvatarHtml(a)}
        <span class="content">
          ${escapeHtml(a.display_name)}
          ${pill}
          ${
            a.platform === 'pinterest'
              ? `<label class="account-board">Pins go to
                  <select data-board-for="${a.id}" disabled><option>Loading boards…</option></select></label>`
              : ''
          }
        </span>
        ${issue && target ? `<a class="btn-link account-reconnect" href="${escapeHtml(target)}">Reconnect</a>` : ''}
        <button data-id="${a.id}" class="delete-btn">Remove</button>
      </li>
    `;
        })
        .join('') ||
      '<li class="empty">No accounts connected yet &mdash; connect one below to start scheduling posts.</li>';

    list.querySelectorAll('select[data-board-for]').forEach(loadPinterestBoards);

    list.querySelectorAll('.delete-btn').forEach((btn) => {
      btn.addEventListener(
        'click',
        withLoading(btn, 'Removing…', async () => {
          const ok = await confirmDialog('Remove this account? All of its scheduled and past posts will be deleted too.', {
            confirmText: 'Remove',
          });
          if (!ok) return;
          try {
            await apiJson(`/api/v1/social-accounts/${btn.dataset.id}`, { method: 'DELETE' });
            loadAccounts();
            loadSidebarAccounts();
          } catch (err) {
            showToast(err.message);
          }
        })
      );
    });
  } catch (err) {
    list.innerHTML = '<li class="empty">Failed to load accounts.</li>';
    showToast(err.message);
  }
}

// Pinterest Pins go to one board per account; this lets the user choose which. Boards Pinterest
// has refused Pins on (e.g. leftovers from the API sandbox) are labelled rather than hidden.
async function loadPinterestBoards(select) {
  const id = select.dataset.boardFor;
  let data;
  try {
    data = await apiJson(`/api/pinterest/accounts/${id}/boards`);
  } catch (err) {
    select.innerHTML = "<option>Couldn't load boards</option>";
    select.title = err.message;
    return;
  }
  const { boards, selected_board_id: selected } = data;
  const options = boards.map(
    (b) =>
      `<option value="${escapeHtml(b.id)}"${b.id === selected ? ' selected' : ''}>${escapeHtml(b.name)}${
        b.usable ? '' : " (doesn't accept Pins)"
      }</option>`
  );
  if (!boards.some((b) => b.id === selected)) {
    options.unshift('<option value="" selected disabled>Choose a board…</option>');
  }
  select.innerHTML = options.join('') || '<option>No boards — create one on Pinterest</option>';
  select.disabled = boards.length === 0;

  select.addEventListener('change', async () => {
    select.disabled = true;
    try {
      const saved = await apiJson(`/api/pinterest/accounts/${id}/board`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ board_id: select.value }),
      });
      showToast(`Pins will go to “${saved.board_name}”.`, 'success');
    } catch (err) {
      showToast(err.message);
    } finally {
      select.disabled = false;
    }
  });
}

// The placeholder-account form is only rendered when there are stub platforms to add.
const accountForm = document.getElementById('account-form');
accountForm?.addEventListener(
  'submit',
  withLoading(accountForm.querySelector('button[type="submit"]'), 'Adding…', async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      await apiJson('/api/v1/social-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: form.platform.value, display_name: form.display_name.value }),
      });
      form.reset();
      loadAccounts();
      loadSidebarAccounts();
    } catch (err) {
      showToast(err.message);
    }
  })
);

const telegramForm = document.getElementById('telegram-connect-form');
telegramForm?.addEventListener(
  'submit',
  withLoading(telegramForm.querySelector('button[type="submit"]'), 'Connecting…', async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      await apiJson('/api/telegram/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: form.token.value.trim(), chat_id: form.chat_id.value.trim() }),
      });
      form.reset();
      showToast('Telegram channel connected.', 'success');
      loadAccounts();
      loadSidebarAccounts();
    } catch (err) {
      showToast(err.message);
    }
  })
);

const blueskyForm = document.getElementById('bluesky-connect-form');
blueskyForm?.addEventListener(
  'submit',
  withLoading(blueskyForm.querySelector('button[type="submit"]'), 'Connecting…', async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      await apiJson('/api/bluesky/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: form.handle.value.trim(), app_password: form.app_password.value.trim() }),
      });
      form.reset();
      showToast('Bluesky account connected.', 'success');
      loadAccounts();
      loadSidebarAccounts();
    } catch (err) {
      showToast(err.message);
    }
  })
);

if (new URLSearchParams(location.search).get('error') === 'plan_limit') {
  // atAccountLimit() also returns true for a paid platform on an account with no active trial/
  // subscription (Mastodon, Bluesky and Telegram are free).
  showToast(
    'Not connected: this platform needs a plan (Mastodon, Bluesky and Telegram are free), or your plan’s channel limit was reached. Start a free trial or upgrade.',
    'error',
    '/pricing'
  );
  history.replaceState(null, '', location.pathname);
}

if (new URLSearchParams(location.search).get('error') === 'facebook_no_pages') {
  showToast('Facebook didn’t share any Pages. Connect again and tick at least one Page (and its Instagram account) when Facebook asks which to allow.', 'error');
  history.replaceState(null, '', location.pathname);
}

loadAccounts();
