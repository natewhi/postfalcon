document.getElementById('signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const button = form.querySelector('button[type="submit"]');
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = 'Signing up…';
  document.getElementById('error').textContent = '';

  try {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': await getCsrfToken() },
      body: JSON.stringify({ email: form.email.value, password: form.password.value }),
    });
    if (res.ok) {
      window.location.href = '/login';
      return;
    }
    const data = await res.json().catch(() => ({}));
    document.getElementById('error').textContent = data.error || 'Sign up failed';
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
});
