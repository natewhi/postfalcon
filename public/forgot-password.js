document.getElementById('forgot-password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const button = form.querySelector('button[type="submit"]');
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = 'Sending…';

  try {
    await fetch('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': await getCsrfToken() },
      body: JSON.stringify({ email: form.email.value }),
    });
    form.reset();
    document.getElementById('message').textContent = 'If that email is registered, a reset link has been sent.';
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
});
