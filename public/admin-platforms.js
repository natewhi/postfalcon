// Admin Platforms: switch each platform on or off (routes/admin.js /api/admin/platforms).

function statusCell(p) {
  if (!p.built) return '<span class="admin-chip is-off">Not built yet</span>';
  const label = p.enabled ? 'On' : 'Off';
  const note = p.switchedAt ? '' : ' <span class="hint">(default)</span>';
  return `<span class="admin-chip ${p.enabled ? 'is-on' : 'is-off'}">${label}</span>${note}`;
}

function credentialsCell(p) {
  if (!p.built) return '—';
  if (!p.credentialsNeeded) return 'Not needed';
  return p.credentialsSet ? 'Set' : `<span class="admin-bad">Missing</span> <code>${escapeHtml(p.credentialsNeeded)}</code>`;
}

function actionsCell(p) {
  if (!p.built) return '';
  const toggle = `<button type="button" class="${p.enabled ? 'btn-secondary' : ''}" data-switch="${p.id}" data-enabled="${!p.enabled}">${
    p.enabled ? 'Turn off' : 'Turn on'
  }</button>`;
  const reset = p.switchedAt ? ` <button type="button" class="btn-secondary" data-reset="${p.id}">Reset to default</button>` : '';
  return toggle + reset;
}

// "How to set up": developer console, callback URL(s) to register there (copyable), and which
// .env keys are filled in.
function setupDetails(p) {
  const setup = p.setup;
  if (!p.built || !setup) return '';
  const parts = [`<p>${escapeHtml(setup.steps)}</p>`];
  if (setup.console) {
    parts.push(
      `<p>Developer console: <a href="${escapeHtml(setup.console)}" target="_blank" rel="noopener">${escapeHtml(setup.console)} ↗</a></p>`
    );
  }
  if (setup.callbackUrls.length) {
    parts.push(
      `<p>Callback URL${setup.callbackUrls.length > 1 ? 's' : ''} to register:</p>` +
        setup.callbackUrls
          .map(
            (url) =>
              `<div class="setup-copy"><code>${escapeHtml(url)}</code> <button type="button" class="btn-secondary" data-copy="${escapeHtml(url)}">Copy</button></div>`
          )
          .join('')
    );
  }
  if (setup.env.length) {
    parts.push(
      `<p>In <code>.env</code>: ${setup.env
        .map((v) => `<code>${escapeHtml(v.name)}</code> ${v.set ? '✓' : '<span class="admin-bad">not set</span>'}`)
        .join(', ')}</p>`
    );
  }
  return `<details class="platform-setup"><summary>How to set up</summary>${parts.join('')}</details>`;
}

let platforms = [];

async function loadPlatforms() {
  const body = document.getElementById('platforms-body');
  try {
    platforms = await apiJson('/api/admin/platforms');
    body.innerHTML = platforms
      .map(
        (p) =>
          `<tr><td>${escapeHtml(p.label)}${p.sharesConnectWith ? ` <span class="hint">(connects with ${escapeHtml(p.sharesConnectWith)})</span>` : ''}${setupDetails(p)}</td><td class="nowrap">${statusCell(
            p
          )}</td><td class="nowrap">${credentialsCell(p)}</td><td class="nowrap">${p.connectedAccounts}</td><td class="nowrap">${p.scheduledPosts}</td><td class="nowrap">${actionsCell(p)}</td></tr>`
      )
      .join('');
  } catch (err) {
    body.innerHTML = '<tr><td colspan="6" class="empty">Failed to load.</td></tr>';
    showToast(err.message);
  }
}

async function send(id, payload, confirmMessage, confirmText) {
  if (confirmMessage && !(await confirmDialog(confirmMessage, { confirmText }))) return;
  try {
    const result = await apiJson(`/api/admin/platforms/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const label = platforms.find((p) => p.id === id)?.label ?? id;
    showToast(`${label} is now ${result.enabled ? 'on' : 'off'}.`, 'success');
    loadPlatforms();
  } catch (err) {
    showToast(err.message);
  }
}

document.getElementById('platforms-body').addEventListener('click', (e) => {
  const copyBtn = e.target.closest('[data-copy]');
  if (copyBtn) {
    navigator.clipboard
      .writeText(copyBtn.dataset.copy)
      .then(() => showToast('Copied.', 'success'))
      .catch(() => showToast('Select the URL and copy it with Ctrl+C.', 'warning'));
    return;
  }
  const switchBtn = e.target.closest('[data-switch]');
  if (switchBtn) {
    const p = platforms.find((x) => x.id === switchBtn.dataset.switch);
    const enable = switchBtn.dataset.enabled === 'true';
    let message = null;
    if (enable && !p.credentialsSet) {
      message = `${p.label} has no app credentials in .env yet, so connecting will fail until they're added. Turn it on anyway?`;
    } else if (!enable && (p.connectedAccounts || p.scheduledPosts)) {
      message = `Turn off ${p.label}? ${p.connectedAccounts} connected account(s) will stop publishing, and ${p.scheduledPosts} scheduled post(s) will fail when due.`;
    } else if (!enable) {
      message = `Turn off ${p.label}? It will be hidden and can't be connected.`;
    }
    send(p.id, { enabled: enable }, message, enable ? 'Turn on' : 'Turn off');
    return;
  }
  const resetBtn = e.target.closest('[data-reset]');
  if (resetBtn) {
    const p = platforms.find((x) => x.id === resetBtn.dataset.reset);
    send(p.id, { reset: true }, `Reset ${p.label} to its default (${p.defaultEnabled ? 'on' : 'off'})?`, 'Reset');
  }
});

loadPlatforms();
