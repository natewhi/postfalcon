function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  // div.innerHTML only encodes &, <, > (text-node escaping) — callers also interpolate this
  // into quoted HTML attributes (src="...", alt="..."), so quotes need encoding too or a "
  // in the source string closes the attribute early.
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

function extractErrorMessageFromData(data) {
  if (!data) return 'Something went wrong.';
  if (data.error === 'validation_failed' && data.details?.fieldErrors) {
    const [field, messages] = Object.entries(data.details.fieldErrors)[0] ?? [];
    if (field) return `${field}: ${messages[0]}`;
  }
  if (data.error === 'too_many_requests') {
    return 'Too many attempts. Please wait a few minutes and try again.';
  }
  return data.error || 'Something went wrong.';
}

async function extractErrorMessage(res) {
  try {
    return extractErrorMessageFromData(await res.json());
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

// fetch() has no upload-progress event at all, so a multipart POST with large media
// attached just sits there with zero feedback until it finishes. XMLHttpRequest is the
// only web platform API that exposes xhr.upload.onprogress, so this is a deliberate
// exception to the "use apiJson, not raw fetch" rule, kept to the one call site that
// actually uploads files (the dashboard composer's new-post submit).
function apiUpload(path, formData, onProgress) {
  return new Promise((resolve, reject) => {
    getCsrfToken().then((token) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', path);
      xhr.setRequestHeader('x-csrf-token', token);
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
      });
      xhr.addEventListener('load', () => {
        if (xhr.status === 401) {
          window.location.href = '/login';
          reject(new Error('not authenticated'));
          return;
        }
        let data = null;
        try {
          data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        } catch {
          // non-JSON body, data stays null
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
        } else {
          reject(new Error(extractErrorMessageFromData(data)));
        }
      });
      xhr.addEventListener('error', () => reject(new Error('Something went wrong.')));
      xhr.send(formData);
    });
  });
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

const THEME_STORAGE_KEY = 'postfalcon-theme';
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

// Per-platform badge colour + a one/two-char text fallback. The real brand mark is drawn
// from the SVG sprite in views/partials/platform-icons.ejs (included via the sidebar) —
// PLATFORM_GLYPHS lists the ids that have a <symbol id="pi-<id>"> there.
const PLATFORM_META = {
  facebook: { label: 'f', color: '#1877F2' },
  instagram: { label: 'IG', color: '#E1306C' },
  mastodon: { label: 'M', color: '#6364FF' },
  youtube: { label: 'YT', color: '#FF0000' },
  tiktok: { label: 'TT', color: '#111111' },
  telegram: { label: 'TG', color: '#26A5E4' },
  bluesky: { label: 'BS', color: '#1185FE' },
  threads: { label: '@', color: '#111111' },
  pinterest: { label: 'P', color: '#E60023' },
  reddit: { label: 'R', color: '#FF4500' },
  twitter: { label: 'X', color: '#111111' },
  linkedin: { label: 'in', color: '#0A66C2' },
};

const PLATFORM_GLYPHS = new Set([
  'facebook', 'instagram', 'mastodon', 'telegram', 'youtube', 'tiktok', 'twitter', 'linkedin',
  'bluesky', 'threads', 'pinterest',
]);

// Contents of a platform badge: the real brand mark when we have one, else the text label.
function platformBadgeInner(platform) {
  if (PLATFORM_GLYPHS.has(platform)) {
    return `<svg class="platform-glyph" viewBox="0 0 24 24" aria-hidden="true"><use href="#pi-${platform}"></use></svg>`;
  }
  return escapeHtml((PLATFORM_META[platform] || { label: '?' }).label);
}

// First letter of the account name (ignoring a leading @), for the no-picture fallback.
function accountInitial(displayName) {
  const first = Array.from(String(displayName || '').replace(/^@+/, '').trim())[0];
  return first ? first.toUpperCase() : '?';
}

function accountAvatarPlaceholderHtml(initial, color) {
  return `<span class="account-avatar-placeholder" style="background:${color}" aria-hidden="true">${escapeHtml(initial)}</span>`;
}

function accountAvatarHtml(account) {
  const meta = PLATFORM_META[account.platform] || { label: '?', color: '#666666' };
  const initial = accountInitial(account.display_name);
  // A broken picture (expired CDN link — TikTok's are signed and expire within days — or a
  // deleted one) is swapped for the initial-letter placeholder by the error listener below.
  const avatar = account.avatar_url
    ? `<img class="account-avatar-img" src="${escapeHtml(account.avatar_url)}" alt="" referrerpolicy="no-referrer"
         data-initial="${escapeHtml(initial)}" data-color="${meta.color}">`
    : accountAvatarPlaceholderHtml(initial, meta.color);
  return `
    <span class="account-avatar">
      ${avatar}
      <span class="account-badge" style="background:${meta.color}">${platformBadgeInner(account.platform)}</span>
    </span>
  `;
}

// Image errors don't bubble, so this listens in the capture phase. (An inline onerror=""
// isn't an option: the CSP blocks inline handlers.)
document.addEventListener(
  'error',
  (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('account-avatar-img')) return;
    img.outerHTML = accountAvatarPlaceholderHtml(img.dataset.initial || '?', img.dataset.color || '#666666');
  },
  true
);

// 'reconnect' when the platform rejected the account's credentials (see lib/reconnect.js),
// 'expiring' when a token with no refresh token runs out within a week, else null.
function accountConnectionIssue(account) {
  if (account.needs_reconnect_at) return 'reconnect';
  if (account.expires_soon) return 'expiring';
  return null;
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
        <a href="/dashboard?account=${a.id}" class="sidebar-account${String(a.id) === activeAccount ? ' active' : ''}${accountConnectionIssue(a) ? ' has-issue' : ''}" data-account-id="${a.id}"${accountConnectionIssue(a) === 'reconnect' ? ' title="Needs reconnecting"' : ''}>
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
