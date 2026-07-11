document.getElementById('signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const res = await fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: form.email.value, password: form.password.value }),
  });
  if (res.ok) {
    window.location.href = '/login';
  } else {
    const data = await res.json().catch(() => ({}));
    document.getElementById('error').textContent = data.error || 'Sign up failed';
  }
});
