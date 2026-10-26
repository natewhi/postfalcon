const signupPlan = new URLSearchParams(location.search).get('plan');
const signupForm = document.getElementById('signup-form');
// Set by routes/pages.js only when the page's ?invite= link is still usable.
const signupInvite = signupForm?.dataset.invite || '';

// Carry ?plan= (a plan picked on /pricing before signing up, so it still lands on checkout)
// and ?invite= (invite-only sign-ups) through to Google sign-in too — routes/auth.js's
// /google start route reads them off the query string and stashes them in the session.
const googleLink = document.getElementById('google-signup-link');
if (googleLink && (signupPlan || signupInvite)) {
  const params = new URLSearchParams();
  if (signupPlan) params.set('plan', signupPlan);
  if (signupInvite) params.set('invite', signupInvite);
  googleLink.href = `${googleLink.pathname}?${params}`;
}

signupForm?.addEventListener('submit', async (e) => {
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
      body: JSON.stringify({ email: form.email.value, password: form.password.value, invite: signupInvite || undefined }),
    });

    if (res.status === 409) {
      const errorEl = document.getElementById('error');
      const loginLink = document.createElement('a');
      loginLink.href = '/login';
      loginLink.textContent = 'Log in instead';
      errorEl.append('An account with this email already exists. ', loginLink);
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      document.getElementById('error').textContent = data.message || data.error || 'Sign up failed';
      return;
    }

    // Log the new user straight in so they can pick a plan and add a card without a
    // second form. If that fails for any reason, fall back to the login page.
    button.textContent = 'Creating your account…';
    const loginRes = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': await getCsrfToken() },
      body: JSON.stringify({ email: form.email.value, password: form.password.value }),
    });

    if (loginRes.ok) {
      // A plan picked on /pricing goes on to Checkout; otherwise straight in, on the free plan.
      window.location.href = signupPlan ? `/pricing?start=${encodeURIComponent(signupPlan)}` : '/dashboard';
    } else {
      window.location.href = '/login';
    }
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
});
