// Plan catalogue. `priceUsd` (monthly) and `priceUsdYearly` are display-only (the real amounts
// live on the Stripe Prices). Yearly is "2 months free": 10x the monthly price.
// `limits` are enforced by middleware/planLimit.js (Infinity = no cap); `capabilities` gate
// feature routes via requireCapability(). Every plan is a paid plan — there is no free tier;
// new accounts start on a 7-day trial of Standard (see db/migrations/013_plan_tiers.sql).

// Feature lists are strictly additive: every tier repeats the cheaper tier's rows verbatim
// (same wording, same order) and then appends its own, so scanning the pricing columns makes
// "you get everything below, plus more" obvious. The channel count is rendered separately
// (from `limits.accounts`) so it doesn't break that row-by-row alignment. Keep in sync with
// the capabilities above.
const STANDARD_FEATURES = [
  'Unlimited scheduled posts',
  'All 10 platforms, cross-posted from one composer',
  'Recurring / repeated posts',
  'Visual calendar with drag-to-reschedule',
  'REST API + MCP server for AI agents',
];
const TEAM_FEATURES = [...STANDARD_FEATURES, 'Outbound webhooks (post published / failed)'];
const PRO_FEATURES = [...TEAM_FEATURES, 'Priority support'];

export const PLANS = {
  standard: {
    name: 'Standard',
    priceUsd: 29,
    priceUsdYearly: 290,
    tagline: 'Best for content creators',
    limits: { accounts: 5, scheduledPosts: Infinity },
    capabilities: { api: true, crossPosting: true, repeatedPosts: true, webhooks: false, prioritySupport: false },
    features: STANDARD_FEATURES,
  },
  team: {
    name: 'Team',
    priceUsd: 39,
    priceUsdYearly: 390,
    tagline: 'Best for small brands',
    popular: true,
    limits: { accounts: 10, scheduledPosts: Infinity },
    capabilities: { api: true, crossPosting: true, repeatedPosts: true, webhooks: true, prioritySupport: false },
    features: TEAM_FEATURES,
  },
  pro: {
    name: 'Pro',
    priceUsd: 49,
    priceUsdYearly: 490,
    tagline: 'Best for large businesses',
    limits: { accounts: 30, scheduledPosts: Infinity },
    capabilities: { api: true, crossPosting: true, repeatedPosts: true, webhooks: true, prioritySupport: true },
    features: PRO_FEATURES,
  },
};

export const PLAN_IDS = Object.keys(PLANS);
export const PAID_PLAN_IDS = PLAN_IDS.filter((id) => PLANS[id].priceUsd > 0);
export const DEFAULT_PLAN = 'standard';
export const TRIAL_DAYS = 7;

// plan_status values that still grant the plan's limits and capabilities.
const ENTITLED_STATUSES = new Set(['active', 'trialing', 'past_due']);

export function isEntitled(user) {
  return ENTITLED_STATUSES.has(user?.plan_status ?? 'active');
}

export function limitsForPlan(plan) {
  return (PLANS[plan] || PLANS[DEFAULT_PLAN]).limits;
}

export function planHasCapability(plan, capability) {
  return Boolean((PLANS[plan] || PLANS[DEFAULT_PLAN]).capabilities?.[capability]);
}

// The Stripe SDK is imported lazily (dynamic import, cached) so that neither this module's
// importers nor the test suite need the `stripe` package present unless billing is actually
// exercised. Throws if the key isn't configured.
let _stripe;
export async function getStripe() {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not set — billing is disabled');
    }
    const { default: Stripe } = await import('stripe');
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return _stripe;
}

export function billingConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

// Stripe statuses of a subscription that is running (in a trial, paid up, or in dunning) and
// so would keep billing. 'incomplete' is a first payment still being attempted.
const RUNNING_STATUSES = new Set(['trialing', 'active', 'past_due', 'unpaid', 'incomplete']);

// Every subscription a Stripe customer has ever had, any status. A customer is created the
// moment someone clicks "Start trial", so having one doesn't mean they ever subscribed —
// someone who closed the Checkout page has a customer and no subscriptions at all.
export async function subscriptionsFor(customerId) {
  const stripe = await getStripe();
  const { data } = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
  return data;
}

export function hasRunningSubscription(subscriptions) {
  return subscriptions.some((s) => RUNNING_STATUSES.has(s.status));
}

// The subscription that decides a customer's plan: their newest running one, else their newest
// of any status. Webhooks apply this rather than the copy inside the event, because Stripe
// doesn't deliver events in order and retries failed ones later — a stale "trialing" arriving
// after "active", or an old subscription's "deleted" arriving after a newer one started, must
// not overwrite the real current state.
export function currentSubscription(subscriptions) {
  const newestFirst = [...subscriptions].sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  return newestFirst.find((s) => RUNNING_STATUSES.has(s.status)) ?? newestFirst[0] ?? null;
}

// The trial is for first-time subscribers only. A first payment that failed outright
// (incomplete_expired) never started anything, so it doesn't use the trial up.
export function trialEligible(subscriptions) {
  return subscriptions.every((s) => s.status === 'incomplete_expired');
}

// Cancels, immediately, every subscription of this customer that would otherwise keep
// billing. Used when an account is deleted, so Stripe never charges someone who no longer
// has a Postfalcon account.
export async function cancelRunningSubscriptions(customerId) {
  const stripe = await getStripe();
  const running = (await subscriptionsFor(customerId)).filter((s) => RUNNING_STATUSES.has(s.status));
  for (const subscription of running) {
    await stripe.subscriptions.cancel(subscription.id);
  }
  return running.length;
}

export const BILLING_INTERVALS = ['monthly', 'yearly'];

// Each plan has a monthly and a yearly Stripe Price: STRIPE_PRICE_<PLAN> and
// STRIPE_PRICE_<PLAN>_YEARLY. Read at call time so tests can set them in a beforeAll.
function priceEnvVar(plan, interval) {
  return `STRIPE_PRICE_${plan.toUpperCase()}${interval === 'yearly' ? '_YEARLY' : ''}`;
}

// plan id (+ interval) -> configured Stripe Price id, and back.
export function priceIdForPlan(plan, interval = 'monthly') {
  if (!PLANS[plan] || !BILLING_INTERVALS.includes(interval)) return null;
  return process.env[priceEnvVar(plan, interval)] || null;
}

export function planForPriceId(priceId) {
  if (!priceId) return null;
  for (const plan of PLAN_IDS) {
    for (const interval of BILLING_INTERVALS) {
      if (process.env[priceEnvVar(plan, interval)] === priceId) return plan;
    }
  }
  return null;
}
