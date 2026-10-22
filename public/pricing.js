// Standalone page script (no common.js): does its own CSRF-header fetch, like the auth pages.
const messageEl = document.getElementById('pricing-message');

function showMessage(text, kind = 'error') {
  messageEl.textContent = text;
  messageEl.className = kind === 'error' ? 'error' : 'hint';
  messageEl.hidden = false;
}

async function postJson(path, body = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': await getCsrfToken() },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('not authenticated');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || 'Something went wrong.');
  return data;
}

async function startCheckout(plan, interval, button) {
  const original = button ? button.textContent : null;
  if (button) {
    button.disabled = true;
    button.textContent = 'Redirecting…';
  }
  try {
    const { url } = await postJson('/api/billing/checkout', { plan, interval });
    window.location.href = url;
  } catch (err) {
    showMessage(err.message);
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

async function openPortal(button) {
  button.disabled = true;
  const original = button.textContent;
  button.textContent = 'Opening…';
  try {
    const { url } = await postJson('/api/billing/portal');
    window.location.href = url;
  } catch (err) {
    showMessage(err.message);
    button.disabled = false;
    button.textContent = original;
  }
}

// currentBilling() is the Monthly / Yearly switch's state (public/billing-toggle.js).
document.querySelectorAll('.plan-cta[data-plan]').forEach((btn) => {
  btn.addEventListener('click', () => startCheckout(btn.dataset.plan, currentBilling(), btn));
});

const portalBtn = document.querySelector('[data-portal]');
portalBtn?.addEventListener('click', () => openPortal(portalBtn));

const params = new URLSearchParams(location.search);

if (params.get('checkout') === 'cancelled') {
  showMessage('Checkout cancelled — no changes were made.', 'note');
  history.replaceState(null, '', location.pathname);
}

// Arriving from signup with a chosen plan (?start=team) — go straight to the Stripe
// payment window to add a card and start the trial. A logged-out visitor hitting this
// URL directly gets bounced to /login by postJson's 401 handling.
// The value is "<plan>" or "<plan>-yearly" (see public/billing-toggle.js).
const start = params.get('start');
if (start) {
  history.replaceState(null, '', location.pathname);
  const [startPlan, startInterval] = start.split('-');
  showMessage('Starting your trial — taking you to secure checkout…', 'note');
  startCheckout(startPlan, startInterval === 'yearly' ? 'yearly' : 'monthly', null);
}
