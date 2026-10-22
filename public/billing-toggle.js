// Monthly / Yearly switch on the plan cards (views/partials/pricing-cards.ejs), loaded on the
// landing and pricing pages. The choice is stamped on <html data-billing>, which style.css uses
// to show one set of prices. Signup links carry it as "<plan>-yearly": that value passes
// through signup and Google sign-in unchanged (both just forward ?plan= as /pricing?start=),
// and public/pricing.js splits it again before starting checkout.

function currentBilling() {
  return document.documentElement.dataset.billing === 'yearly' ? 'yearly' : 'monthly';
}

function setBilling(billing) {
  document.documentElement.dataset.billing = billing;
  document.querySelectorAll('[data-billing-option]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.billingOption === billing));
  });
  document.querySelectorAll('[data-plan-link]').forEach((link) => {
    const plan = link.dataset.planLink;
    link.href = `/signup?plan=${encodeURIComponent(billing === 'yearly' ? `${plan}-yearly` : plan)}`;
  });
}

document.querySelectorAll('[data-billing-option]').forEach((btn) => {
  btn.addEventListener('click', () => setBilling(btn.dataset.billingOption));
});
setBilling(currentBilling());
