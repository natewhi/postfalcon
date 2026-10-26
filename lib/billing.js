import { envConfigured } from './config.js';

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
  'Every supported platform, cross-posted from one composer',
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

// Self-hosted mode: with no STRIPE_SECRET_KEY there is nothing to buy, so every account is
// entitled and gets this in place of whatever its `plan` column says: no caps, every
// capability. Checked per call (not at startup) so a key added to .env takes over on reload.
const SELF_HOSTED_PLAN = {
  name: 'Self-hosted',
  limits: { accounts: Infinity, scheduledPosts: Infinity },
  capabilities: Object.fromEntries(Object.keys(PLANS.pro.capabilities).map((cap) => [cap, true])),
};

export function selfHosted() {
  return !billingConfigured();
}

// The plan whose limits and capabilities apply to an account on `plan`.
export function planFor(plan) {
  if (selfHosted()) return SELF_HOSTED_PLAN;
  return PLANS[plan] || PLANS[DEFAULT_PLAN];
}

export function isEntitled(user) {
  if (selfHosted()) return true;
  return ENTITLED_STATUSES.has(user?.plan_status ?? 'active');
}

export function limitsForPlan(plan) {
  return planFor(plan).limits;
}

export function planHasCapability(plan, capability) {
  return Boolean(planFor(plan).capabilities?.[capability]);
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
  return envConfigured('STRIPE_SECRET_KEY');
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

// How a plan's Stripe Prices are found. `npm run stripe:setup` (scripts/stripe-setup.js) gives
// each plan's current monthly and yearly Price a lookup key (postfalcon_<plan>_<interval>) and
// metadata { plan, interval }. So checkout asks Stripe for the Price by lookup key, and a
// subscription's plan is read off its Price's metadata — no Price ids to copy into .env, the
// same code works in test and live mode, and a price change (re-running the script after
// editing priceUsd/priceUsdYearly above) needs no code or .env change. Old Prices keep their
// metadata, so subscribers left on a previous price are still recognised.
export function lookupKeyFor(plan, interval) {
  return `postfalcon_${plan}_${interval}`;
}

// Legacy fallback: Price ids set by hand as STRIPE_PRICE_<PLAN>[_YEARLY], from before the
// setup script. Read at call time so tests can set them in a beforeAll.
function priceEnvVar(plan, interval) {
  return `STRIPE_PRICE_${plan.toUpperCase()}${interval === 'yearly' ? '_YEARLY' : ''}`;
}

const PRICE_CACHE_MS = 5 * 60 * 1000;
const priceCache = new Map(); // lookup key -> { id, at }

// plan id (+ interval) -> the Stripe Price id to charge, or null if none is set up.
export async function priceIdForPlan(plan, interval = 'monthly') {
  if (!PLANS[plan] || !BILLING_INTERVALS.includes(interval)) return null;
  const key = lookupKeyFor(plan, interval);
  const cached = priceCache.get(key);
  if (cached && Date.now() - cached.at < PRICE_CACHE_MS) return cached.id;

  const stripe = await getStripe();
  const { data } = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 });
  const id = data[0]?.id || process.env[priceEnvVar(plan, interval)] || null;
  if (id) priceCache.set(key, { id, at: Date.now() });
  return id;
}

// A subscription item's Price -> our plan id, or null if it isn't one of ours.
export function planForPrice(price) {
  if (!price) return null;
  if (PLANS[price.metadata?.plan]) return price.metadata.plan;
  for (const plan of PLAN_IDS) {
    for (const interval of BILLING_INTERVALS) {
      if (price.lookup_key === lookupKeyFor(plan, interval)) return plan;
      if (price.id && process.env[priceEnvVar(plan, interval)] === price.id) return plan;
    }
  }
  return null;
}

export function clearPriceCache() {
  priceCache.clear();
}
