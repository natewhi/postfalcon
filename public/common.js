function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showToast(message, type = 'error', link = null) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement(link ? 'a' : 'div');
  if (link) {
    toast.href = link;
  }
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 8000);
}

async function extractErrorMessage(res) {
  try {
    const data = await res.json();
    if (data.error === 'validation_failed' && data.details?.fieldErrors) {
      const [field, messages] = Object.entries(data.details.fieldErrors)[0] ?? [];
      if (field) return `${field}: ${messages[0]}`;
    }
    if (data.error === 'too_many_requests') {
      return 'Too many attempts. Please wait a few minutes and try again.';
    }
    return data.error || 'Something went wrong.';
  } catch {
    return 'Something went wrong.';
  }
}

async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    const token = await getCsrfToken();
    options = { ...options, headers: { ...options.headers, 'x-csrf-token': token } };
  }
  const res = await fetch(path, options);
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('not authenticated');
  }
  return res;
}

async function apiJson(path, options) {
  const res = await api(path, options);
  if (!res.ok) {
    throw new Error(await extractErrorMessage(res));
  }
  if (res.status === 204) {
    return null;
  }
  return res.json();
}

function withLoading(button, loadingText, fn) {
  return async (...args) => {
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = loadingText;
    try {
      await fn(...args);
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  };
}

function confirmDialog(message, { confirmText = 'Confirm', cancelText = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    let dialog = document.getElementById('confirm-dialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'confirm-dialog';
      dialog.innerHTML = `
        <p id="confirm-dialog-message"></p>
        <div class="dialog-actions">
          <button type="button" id="confirm-dialog-cancel"></button>
          <button type="button" id="confirm-dialog-confirm" class="delete-btn"></button>
        </div>
      `;
      document.body.appendChild(dialog);
      dialog.addEventListener('click', (e) => {
        if (e.target === dialog) dialog.close();
      });
    }

    dialog.querySelector('#confirm-dialog-message').textContent = message;
    const confirmBtn = dialog.querySelector('#confirm-dialog-confirm');
    const cancelBtn = dialog.querySelector('#confirm-dialog-cancel');
    confirmBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;

    function cleanup() {
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      dialog.removeEventListener('close', onDialogClose);
    }
    function onConfirm() {
      cleanup();
      dialog.close();
      resolve(true);
    }
    function onCancel() {
      cleanup();
      dialog.close();
      resolve(false);
    }
    function onDialogClose() {
      cleanup();
      resolve(false);
    }

    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
    dialog.addEventListener('close', onDialogClose);

    dialog.showModal();
  });
}

document.getElementById('logout-btn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-csrf-token': await getCsrfToken() } });
  window.location.href = '/login';
});

const THEME_STORAGE_KEY = 'postfox-theme';
const themeToggleBtn = document.getElementById('theme-toggle-btn');

function updateThemeToggleLabel() {
  if (!themeToggleBtn) return;
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  themeToggleBtn.textContent = isDark ? '☀ Light mode' : '🌙 Dark mode';
  themeToggleBtn.setAttribute('aria-pressed', String(isDark));
}

if (themeToggleBtn) {
  updateThemeToggleLabel();
  themeToggleBtn.addEventListener('click', () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const next = isDark ? 'light' : 'dark';
    localStorage.setItem(THEME_STORAGE_KEY, next);
    document.documentElement.setAttribute('data-theme', next);
    updateThemeToggleLabel();
  });
}

const resendBtn = document.getElementById('resend-verification-btn');
if (resendBtn) {
  resendBtn.addEventListener(
    'click',
    withLoading(resendBtn, 'Sending…', async () => {
      try {
        await apiJson('/api/auth/resend-verification', { method: 'POST' });
        resendBtn.textContent = 'Sent!';
        resendBtn.disabled = true;
        return;
      } catch (err) {
        showToast(err.message);
      }
    })
  );
}

const PLATFORM_META = {
  mastodon: { label: 'M', color: '#6364FF' },
  twitter: { label: 'X', color: '#000000' },
  facebook: { label: 'f', color: '#1877F2' },
  instagram: { label: 'IG', color: '#E1306C' },
  linkedin: { label: 'in', color: '#0A66C2' },
  tiktok: { label: 'TT', color: '#000000' },
  threads: { label: '@', color: '#000000' },
};

function accountAvatarHtml(account) {
  const meta = PLATFORM_META[account.platform] || { label: '?', color: '#666666' };
  const avatar = account.avatar_url
    ? `<img class="account-avatar-img" src="${escapeHtml(account.avatar_url)}" alt="">`
    : `<span class="account-avatar-placeholder" style="background:${meta.color}"></span>`;
  return `
    <span class="account-avatar">
      ${avatar}
      <span class="account-badge" style="background:${meta.color}">${meta.label}</span>
    </span>
  `;
}

async function loadSidebarAccounts() {
  const container = document.getElementById('sidebar-accounts-list');
  if (!container) return;
  try {
    const accounts = await apiJson('/api/v1/social-accounts');
    const params = new URLSearchParams(window.location.search);
    const activeAccount = window.location.pathname === '/dashboard' ? params.get('account') : null;

    container.innerHTML =
      accounts
        .map(
          (a) => `
        <a href="/dashboard?account=${a.id}" class="sidebar-account${String(a.id) === activeAccount ? ' active' : ''}" data-account-id="${a.id}">
          ${accountAvatarHtml(a)}
          <span class="sidebar-account-name">${escapeHtml(a.display_name)}</span>
        </a>
      `
        )
        .join('') || '<p class="sidebar-accounts-empty">No accounts yet</p>';

    container.querySelectorAll('.sidebar-account').forEach((link) => {
      link.addEventListener('click', (e) => {
        if (window.location.pathname === '/dashboard' && typeof window.filterByAccount === 'function') {
          e.preventDefault();
          const id = link.dataset.accountId;
          const isActive = link.classList.contains('active');
          container.querySelectorAll('.sidebar-account').forEach((l) => l.classList.remove('active'));
          if (!isActive) {
            link.classList.add('active');
          }
          window.filterByAccount(isActive ? null : id);
        }
      });
    });
  } catch {
    container.innerHTML = '<p class="sidebar-accounts-empty">Failed to load accounts</p>';
  }
}

loadSidebarAccounts();
