// Admin Settings: site name and the public website switch (routes/admin.js /api/admin/settings).

function render(settings) {
  const preview = document.getElementById('logo-preview');
  preview.hidden = !settings.logoUrl;
  if (settings.logoUrl) preview.src = settings.logoUrl;
  document.getElementById('logo-default').hidden = Boolean(settings.logoUrl);
  document.getElementById('logo-remove').hidden = !settings.logoUrl;

  const nameInput = document.getElementById('site-name');
  nameInput.placeholder = settings.siteNameDefault;
  nameInput.value = settings.siteName === settings.siteNameDefault ? '' : settings.siteName;

  const select = document.getElementById('public-site');
  const defaultLabel = `${settings.publicSiteDefault ? 'On' : 'Off'} (default for a ${settings.selfHosted ? 'self-hosted' : 'hosted'} server)`;
  select.querySelector('option[value="default"]').textContent = `Default — ${defaultLabel}`;
  select.value = settings.publicSiteSaved ? (settings.publicSite ? 'on' : 'off') : 'default';
  select.disabled = false;
  const alertSelect = document.getElementById('alert-emails');
  alertSelect.value = settings.alertEmails ? 'on' : 'off';
  alertSelect.disabled = false;

  document.getElementById('public-site-status').textContent = settings.publicSite
    ? 'Currently on: visitors to the home page see the landing page.'
    : 'Currently off: the home page goes to log in.';
}

async function save(payload, message) {
  try {
    const settings = await apiJson('/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    render(settings);
    showToast(message, 'success');
  } catch (err) {
    showToast(err.message);
  }
}

document.getElementById('site-name-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = document.getElementById('site-name').value.trim();
  save({ site_name: name || null }, name ? `Site name is now “${name}”.` : 'Site name reset to the default.');
});

document.getElementById('public-site-form').addEventListener('submit', (e) => {
  e.preventDefault();
  save({ public_site: document.getElementById('public-site').value }, 'Public website setting saved.');
});

document.getElementById('alert-emails-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = document.getElementById('alert-emails').value;
  save({ alert_emails: value }, value === 'on' ? 'Alert emails are on.' : 'Alert emails are off.');
});

// The page's own header and sidebar keep the old logo until the next page load.
const logoForm = document.getElementById('logo-form');
logoForm.addEventListener(
  'submit',
  withLoading(logoForm.querySelector('button[type="submit"]'), 'Uploading…', async (e) => {
    e.preventDefault();
    const file = document.getElementById('logo-file').files[0];
    if (!file) return;
    const body = new FormData();
    body.append('logo', file);
    try {
      render(await apiJson('/api/admin/settings/logo', { method: 'POST', body }));
      logoForm.reset();
      showToast('Logo updated. Reload the page to see it in the sidebar.', 'success');
    } catch (err) {
      showToast(err.message);
    }
  })
);

document.getElementById('logo-remove').addEventListener('click', async () => {
  if (!(await confirmDialog('Remove the logo and go back to the default mark?', { confirmText: 'Remove' }))) return;
  try {
    render(await apiJson('/api/admin/settings/logo', { method: 'DELETE' }));
    showToast('Logo removed.', 'success');
  } catch (err) {
    showToast(err.message);
  }
});

apiJson('/api/admin/settings')
  .then(render)
  .catch((err) => showToast(err.message));
