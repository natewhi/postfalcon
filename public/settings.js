async function loadApiTokenStatus() {
  const statusEl = document.getElementById('api-token-status');
  const generateBtn = document.getElementById('api-token-generate');
  const revokeBtn = document.getElementById('api-token-revoke');
  try {
    const status = await apiJson('/api/auth/api-token');
    if (status.exists) {
      const created = `created ${new Date(status.created_at).toLocaleDateString()}`;
      const used = status.last_used_at ? `last used ${new Date(status.last_used_at).toLocaleString()}` : 'not used yet';
      statusEl.textContent = `Token active — ${created}, ${used}.`;
      generateBtn.textContent = 'Regenerate token';
      revokeBtn.hidden = false;
    } else {
      statusEl.textContent = 'No API token yet.';
      generateBtn.textContent = 'Generate API token';
      revokeBtn.hidden = true;
    }
  } catch (err) {
    statusEl.textContent = 'Failed to load token status.';
    showToast(err.message);
  }
}

const generateTokenBtn = document.getElementById('api-token-generate');
generateTokenBtn.addEventListener(
  'click',
  withLoading(generateTokenBtn, 'Generating…', async () => {
    if (generateTokenBtn.textContent === 'Regenerate token') {
      const ok = await confirmDialog(
        'This invalidates the current token — any connected agent will need the new one. Continue?',
        { confirmText: 'Regenerate' }
      );
      if (!ok) return;
    }
    try {
      const result = await apiJson('/api/auth/api-token', { method: 'POST' });
      document.getElementById('api-token-value').value = result.token;
      document.getElementById('api-token-reveal').hidden = false;
      loadApiTokenStatus();
    } catch (err) {
      showToast(err.message);
    }
  })
);

document.getElementById('api-token-copy').addEventListener('click', async () => {
  const input = document.getElementById('api-token-value');
  input.select();
  await navigator.clipboard.writeText(input.value);
  showToast('Copied to clipboard.', 'success');
});

const revokeTokenBtn = document.getElementById('api-token-revoke');
revokeTokenBtn.addEventListener(
  'click',
  withLoading(revokeTokenBtn, 'Revoking…', async () => {
    const ok = await confirmDialog('Revoke your API token? Any connected agent will stop working until you generate a new one.', {
      confirmText: 'Revoke',
    });
    if (!ok) return;
    try {
      await apiJson('/api/auth/api-token', { method: 'DELETE' });
      document.getElementById('api-token-reveal').hidden = true;
      loadApiTokenStatus();
      showToast('Token revoked.', 'success');
    } catch (err) {
      showToast(err.message);
    }
  })
);

loadApiTokenStatus();

const changePasswordForm = document.getElementById('change-password-form');
changePasswordForm.addEventListener(
  'submit',
  withLoading(changePasswordForm.querySelector('button[type="submit"]'), 'Updating…', async (e) => {
    e.preventDefault();
    const form = e.target;
    if (form.newPassword.value !== form.confirmNewPassword.value) {
      showToast("New password and confirmation don't match.");
      return;
    }
    try {
      await apiJson('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: form.currentPassword.value, newPassword: form.newPassword.value }),
      });
      form.reset();
      showToast('Password updated. Other logged-in sessions have been signed out.', 'success');
    } catch (err) {
      showToast(err.message);
    }
  })
);

const deleteAccountForm = document.getElementById('delete-account-form');
deleteAccountForm.addEventListener(
  'submit',
  withLoading(deleteAccountForm.querySelector('button[type="submit"]'), 'Deleting…', async (e) => {
    e.preventDefault();
    const form = e.target;
    const ok = await confirmDialog('This permanently deletes your account and everything in it. Are you sure?', {
      confirmText: 'Delete my account',
    });
    if (!ok) return;
    try {
      await apiJson('/api/auth/delete-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: form.password.value }),
      });
      window.location.href = '/login';
    } catch (err) {
      showToast(err.message);
    }
  })
);
