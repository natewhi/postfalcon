// Admin Settings: site name and the public website switch (routes/admin.js /api/admin/settings).

function render(settings) {
  const nameInput = document.getElementById('site-name');
  nameInput.placeholder = settings.siteNameDefault;
  nameInput.value = settings.siteName === settings.siteNameDefault ? '' : settings.siteName;

  const select = document.getElementById('public-site');
  const defaultLabel = `${settings.publicSiteDefault ? 'On' : 'Off'} (default for a ${settings.selfHosted ? 'self-hosted' : 'hosted'} server)`;
  select.querySelector('option[value="default"]').textContent = `Default — ${defaultLabel}`;
  select.value = settings.publicSiteSaved ? (settings.publicSite ? 'on' : 'off') : 'default';
  select.disabled = false;
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

apiJson('/api/admin/settings')
  .then(render)
  .catch((err) => showToast(err.message));
