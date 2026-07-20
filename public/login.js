document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const button = form.querySelector('button[type="submit"]');
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = 'Logging in…';
  document.getElementById('error').textContent = '';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': await getCsrfToken() },
      body: JSON.stringify({ email: form.email.value, password: form.password.value }),
    });
    if (res.ok) {
      window.location.href = '/dashboard';
      return;
    }
    const data = await res.json().catch(() => ({}));
    document.getElementById('error').textContent = data.error || 'Login failed';
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
});
