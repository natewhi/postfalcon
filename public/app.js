function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function api(path, options) {
  const res = await fetch(path, options);
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('not authenticated');
  }
  return res;
}

async function loadAccounts() {
  const res = await api('/api/social-accounts');
  const accounts = await res.json();

  document.getElementById('accounts-list').innerHTML =
    accounts.map((a) => `<li>${escapeHtml(a.platform)}: ${escapeHtml(a.display_name)}</li>`).join('') ||
    '<li class="empty">No accounts yet</li>';

  document.getElementById('account-select').innerHTML = accounts
    .map((a) => `<option value="${a.id}">${escapeHtml(a.platform)}: ${escapeHtml(a.display_name)}</option>`)
    .join('');
}

async function loadPosts() {
  const res = await api('/api/posts');
  const posts = await res.json();
  const list = document.getElementById('posts-list');

  list.innerHTML =
    posts
      .map(
        (p) => `
    <li>
      <span class="status status-${p.status}">${p.status}</span>
      <span class="content">${escapeHtml(p.content)}</span>
      <span class="when">${p.scheduled_for ? new Date(p.scheduled_for).toLocaleString() : 'no schedule'}</span>
      <button data-id="${p.id}" class="delete-btn">Delete</button>
    </li>
  `
      )
      .join('') || '<li class="empty">No posts yet</li>';

  list.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/posts/${btn.dataset.id}`, { method: 'DELETE' });
      loadPosts();
    });
  });
}

document.getElementById('logout-btn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
});

document.getElementById('account-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  await api('/api/social-accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: form.platform.value, display_name: form.display_name.value }),
  });
  form.reset();
  loadAccounts();
});

document.getElementById('post-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const scheduledLocal = form.scheduled_for.value;
  await api('/api/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      social_account_id: form.social_account_id.value,
      content: form.content.value,
      scheduled_for: scheduledLocal ? new Date(scheduledLocal).toISOString() : undefined,
    }),
  });
  form.reset();
  loadPosts();
});

loadAccounts();
loadPosts();
