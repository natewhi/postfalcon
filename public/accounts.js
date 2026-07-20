async function loadAccounts() {
  const list = document.getElementById('accounts-list');
  list.innerHTML = '<li class="loading"><span class="spinner"></span> Loading accounts…</li>';
  try {
    const accounts = await apiJson('/api/social-accounts');
    list.innerHTML =
      accounts
        .map(
          (a) => `
      <li>
        ${accountAvatarHtml(a)}
        <span class="content">${escapeHtml(a.display_name)}</span>
        <button data-id="${a.id}" class="delete-btn">Remove</button>
      </li>
    `
        )
        .join('') ||
      '<li class="empty">No accounts connected yet &mdash; connect one below to start scheduling posts.</li>';

    list.querySelectorAll('.delete-btn').forEach((btn) => {
      btn.addEventListener(
        'click',
        withLoading(btn, 'Removing…', async () => {
          const ok = await confirmDialog('Remove this account? All of its scheduled and past posts will be deleted too.', {
            confirmText: 'Remove',
          });
          if (!ok) return;
          try {
            await apiJson(`/api/social-accounts/${btn.dataset.id}`, { method: 'DELETE' });
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

const accountForm = document.getElementById('account-form');
accountForm.addEventListener(
  'submit',
  withLoading(accountForm.querySelector('button[type="submit"]'), 'Adding…', async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      await apiJson('/api/social-accounts', {
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

loadAccounts();
