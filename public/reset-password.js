document.getElementById('reset-password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const button = form.querySelector('button[type="submit"]');
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = 'Resetting…';
  document.getElementById('error').textContent = '';

  try {
    const res = await fetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': await getCsrfToken() },
      body: JSON.stringify({ token: form.token.value, password: form.password.value }),
    });
    if (res.ok) {
      window.location.href = '/login';
      return;
    }
    const data = await res.json().catch(() => ({}));
    document.getElementById('error').textContent = data.error || 'Reset failed. The link may have expired.';
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
});
