// npm run stripe:setup — makes the Stripe account behind STRIPE_SECRET_KEY match lib/billing.js.
// Safe to run any number of times, in test mode or live mode. It:
//   1. ensures a product per plan, and on it a monthly and a yearly Price at the amounts in
//      PLANS (priceUsd / priceUsdYearly), each carrying the lookup key the app charges by
//      (postfalcon_<plan>_<interval>) and metadata { plan, interval }. Existing matching Prices
//      are adopted, not duplicated. After a price change in lib/billing.js it creates the new
//      Price and moves the lookup key to it: new checkouts get the new price, existing
//      subscribers stay on the old one until they change plan.
//   2. points the default customer portal's plan switching at exactly those current Prices.
//   3. ensures a webhook endpoint at BASE_URL/api/billing/webhook with the events the app
//      handles. A newly created endpoint's signing secret is printed once, for .env.
//   4. forgets stored customer ids this account doesn't know (left over from the other mode
//      after switching test -> live), resetting their Stripe-backed plans to "not started".
// The portal's other settings (cancellation mode, proration...) and the Subscriptions and
// emails settings are left as set in the dashboard. A CLI script, so it logs with console.
import dotenv from 'dotenv';
dotenv.config();

const { PLANS, PLAN_IDS, BILLING_INTERVALS, lookupKeyFor, getStripe } = await import('../lib/billing.js');
// Imported after dotenv so the pool sees DATABASE_URL.
const { pool } = await import('../db/pool.js');

const WEBHOOK_EVENTS = ['checkout.session.completed', 'customer.subscription.updated', 'customer.subscription.deleted'];
const STRIPE_INTERVAL = { monthly: 'month', yearly: 'year' };

function amountCents(plan, interval) {
  return Math.round((interval === 'yearly' ? PLANS[plan].priceUsdYearly : PLANS[plan].priceUsd) * 100);
}

function matches(price, cents, interval) {
  return (
    price.active &&
    price.currency === 'usd' &&
    price.unit_amount === cents &&
    price.recurring?.interval === STRIPE_INTERVAL[interval] &&
    price.recurring?.interval_count === 1
  );
}

async function ensureProduct(stripe, plan) {
  const name = `Postfalcon ${PLANS[plan].name}`;
  const products = await stripe.products.list({ active: true, limit: 100 });
  let product = products.data.find((p) => p.metadata?.plan === plan) ?? products.data.find((p) => p.name === name);
  if (!product) {
    product = await stripe.products.create({ name, metadata: { plan } });
    console.log(`  created product ${name}`);
  } else if (product.metadata?.plan !== plan) {
    product = await stripe.products.update(product.id, { metadata: { plan } });
  }
  return product;
}

async function ensurePrice(stripe, product, plan, interval) {
  const key = lookupKeyFor(plan, interval);
  const cents = amountCents(plan, interval);
  const metadata = { plan, interval };
  const label = `${PLANS[plan].name} ${interval} ($${(cents / 100).toFixed(2)})`;

  const { data: keyed } = await stripe.prices.list({ lookup_keys: [key], limit: 1 });
  const current = keyed[0];
  if (current && matches(current, cents, interval)) {
    console.log(`  ok       ${label}`);
    return current;
  }

  // An existing unkeyed Price on the product at the right amount (e.g. made by hand in the
  // dashboard) is adopted rather than duplicated.
  const { data: onProduct } = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  const reusable = onProduct.find((p) => p.id !== current?.id && matches(p, cents, interval));
  if (reusable) {
    const price = await stripe.prices.update(reusable.id, { lookup_key: key, transfer_lookup_key: true, metadata });
    console.log(`  adopted  ${label}  ${price.id}`);
    return price;
  }

  const price = await stripe.prices.create({
    product: product.id,
    currency: 'usd',
    unit_amount: cents,
    recurring: { interval: STRIPE_INTERVAL[interval] },
    lookup_key: key,
    transfer_lookup_key: true,
    metadata,
  });
  console.log(`  ${current ? 'NEW PRICE' : 'created'} ${label}  ${price.id}${current ? `  (was ${current.id})` : ''}`);
  return price;
}

async function syncPortal(stripe, pricesByProduct) {
  const { data } = await stripe.billingPortal.configurations.list({ is_default: true, limit: 1 });
  const products = Object.entries(pricesByProduct).map(([product, prices]) => ({ product, prices }));
  const subscriptionUpdate = { enabled: true, default_allowed_updates: ['price'], products };
  if (data[0]) {
    await stripe.billingPortal.configurations.update(data[0].id, { features: { subscription_update: subscriptionUpdate } });
    console.log('  portal plan switching now offers exactly the current prices');
  } else {
    console.log('  no default customer portal yet: set it up once under Settings > Billing > Customer portal, then re-run');
  }
}

async function syncWebhook(stripe) {
  const url = `${(process.env.BASE_URL || '').replace(/\/+$/, '')}/api/billing/webhook`;
  if (!url.startsWith('https://')) {
    console.log(`  skipped: BASE_URL must be a public https:// URL (got ${url})`);
    return;
  }
  const { data } = await stripe.webhookEndpoints.list({ limit: 100 });
  const existing = data.find((e) => e.url === url);
  if (existing) {
    const missing = WEBHOOK_EVENTS.filter((e) => !existing.enabled_events.includes(e) && !existing.enabled_events.includes('*'));
    if (missing.length) {
      await stripe.webhookEndpoints.update(existing.id, { enabled_events: [...new Set([...existing.enabled_events, ...missing])] });
      console.log(`  ${url}: added ${missing.join(', ')}`);
    } else {
      console.log(`  ok       ${url}`);
    }
    return;
  }
  const endpoint = await stripe.webhookEndpoints.create({ url, enabled_events: WEBHOOK_EVENTS });
  console.log(`  created  ${url}`);
  console.log(`\n  Put this in .env, then restart the app (it's only shown now):\n  STRIPE_WEBHOOK_SECRET=${endpoint.secret}\n`);
}

// After switching keys (test -> live), users still hold customer ids from the other mode, which
// this account has never heard of: checkout, the portal and the nightly reconciliation would all
// fail for them with "No such customer". Forget only the ids Stripe says don't exist here, and
// put users whose plan came from that other mode's subscription back to "not started"; logins
// given access by hand (no renewal date) and admins keep their access.
async function forgetUnknownCustomers(stripe) {
  const { rows: users } = await pool.query('SELECT id, email, stripe_customer_id FROM users WHERE stripe_customer_id IS NOT NULL');
  const forgotten = [];
  for (const user of users) {
    let missing = false;
    try {
      const customer = await stripe.customers.retrieve(user.stripe_customer_id);
      missing = Boolean(customer.deleted);
    } catch (err) {
      if (err.code !== 'resource_missing') throw err;
      missing = true;
    }
    if (!missing) continue;
    await pool.query(
      `UPDATE users
         SET plan_status = CASE WHEN plan_renews_at IS NOT NULL AND NOT is_admin THEN 'incomplete' ELSE plan_status END,
             stripe_customer_id = NULL, plan_renews_at = NULL, plan_cancels_at = NULL, plan_interval = NULL
       WHERE id = $1`,
      [user.id]
    );
    forgotten.push(user.email);
  }
  if (forgotten.length) {
    console.log(`  forgot ${forgotten.length} customer id(s) from another Stripe mode: ${forgotten.join(', ')}`);
  } else {
    console.log(`  ok       all ${users.length} stored customer ids exist in this account`);
  }
}

async function main() {
  const key = process.env.STRIPE_SECRET_KEY || '';
  if (!/^sk_(test|live)_/.test(key) && !/^rk_(test|live)_/.test(key)) {
    console.error('STRIPE_SECRET_KEY is missing or not a Stripe secret key.');
    process.exit(1);
  }
  const stripe = await getStripe();
  console.log(`Stripe ${key.includes('_live_') ? 'LIVE' : 'TEST'} mode\n\nProducts and prices:`);

  const pricesByProduct = {};
  for (const plan of PLAN_IDS) {
    const product = await ensureProduct(stripe, plan);
    pricesByProduct[product.id] = [];
    for (const interval of BILLING_INTERVALS) {
      const price = await ensurePrice(stripe, product, plan, interval);
      pricesByProduct[product.id].push(price.id);
    }
  }

  console.log('\nCustomer portal:');
  await syncPortal(stripe, pricesByProduct);
  console.log('\nWebhook:');
  await syncWebhook(stripe);
  console.log('\nCustomers:');
  await forgetUnknownCustomers(stripe);
  console.log('\nDone. The app picks up new prices within 5 minutes (or restart it). No .env price ids are needed.');
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(`\nStripe setup failed: ${err.message}`);
    await pool.end().catch(() => {});
    process.exit(1);
  });
