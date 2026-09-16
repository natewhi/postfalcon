const signupPlan = new URLSearchParams(location.search).get('plan');

// Carry ?plan= through to Google sign-in too, so a plan picked on /pricing before signing up
// still lands on checkout afterward — routes/auth.js's /google start route reads it back off
// the query string and stashes it in the session for its callback to redirect with.
if (signupPlan) {
  const googleLink = document.getElementById('google-signup-link');
  googleLink.href = `${googleLink.href}?plan=${encodeURIComponent(signupPlan)}`;
}

document.getElementById('signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const button = form.querySelector('button[type="submit"]');
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = 'Creating account…';
  document.getElementById('error').textContent = '';

  try {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': await getCsrfToken() },
      body: JSON.stringify({ email: form.email.value, password: form.password.value }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      document.getElementById('error').textContent = data.error || 'Sign up failed';
      return;
    }

    // Log the new user straight in so they can pick a plan and add a card without a
    // second form. If that fails for any reason, fall back to the login page.
    button.textContent = 'Starting your trial…';
    const loginRes = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': await getCsrfToken() },
      body: JSON.stringify({ email: form.email.value, password: form.password.value }),
    });

    if (loginRes.ok) {
      window.location.href = signupPlan
        ? `/pricing?start=${encodeURIComponent(signupPlan)}`
        : '/pricing';
    } else {
      window.location.href = '/login';
    }
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
});
