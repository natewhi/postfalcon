const passwordToggle = document.querySelector('.password-toggle');
if (passwordToggle) {
  const passwordInput = document.getElementById('login-password');
  const slash = passwordToggle.querySelector('.icon-eye-slash');

  // Press-and-hold: the password is only in the clear while the button is actively
  // pressed, so it's never left visible by accident after the user lets go.
  function reveal() {
    passwordInput.type = 'text';
    passwordToggle.setAttribute('aria-pressed', 'true');
    passwordToggle.setAttribute('aria-label', 'Password shown');
    slash.classList.add('is-hidden');
  }

  function conceal() {
    passwordInput.type = 'password';
    passwordToggle.setAttribute('aria-pressed', 'false');
    passwordToggle.setAttribute('aria-label', 'Hold to show password');
    slash.classList.remove('is-hidden');
  }

  passwordToggle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    reveal();
  });
  passwordToggle.addEventListener('pointerup', conceal);
  passwordToggle.addEventListener('pointerleave', conceal);
  passwordToggle.addEventListener('pointercancel', conceal);

  // Keyboard equivalent: hold Space/Enter down on the focused button.
  passwordToggle.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      reveal();
    }
  });
  passwordToggle.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.key === 'Enter') conceal();
  });
}

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
      // Log in straight to the app. Plan selection / payment happens in the signup flow,
      // not on every login.
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
