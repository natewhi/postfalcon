// Plan catalogue. `priceUsd` is display-only (the real amount lives on the Stripe Price).
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
    tagline: 'Best for content creators',
    limits: { accounts: 5, scheduledPosts: Infinity },
    capabilities: { api: true, crossPosting: true, repeatedPosts: true, webhooks: false, prioritySupport: false },
    features: STANDARD_FEATURES,
  },
  team: {
    name: 'Team',
    priceUsd: 39,
    tagline: 'Best for small brands',
    popular: true,
    limits: { accounts: 10, scheduledPosts: Infinity },
    capabilities: { api: true, crossPosting: true, repeatedPosts: true, webhooks: true, prioritySupport: false },
    features: TEAM_FEATURES,
  },
  pro: {
    name: 'Pro',
    priceUsd: 49,
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

// plan id -> configured Stripe Price id, and back.
export function priceIdForPlan(plan) {
  const map = {
    standard: process.env.STRIPE_PRICE_STANDARD,
    team: process.env.STRIPE_PRICE_TEAM,
    pro: process.env.STRIPE_PRICE_PRO,
  };
  return map[plan] || null;
}

export function planForPriceId(priceId) {
  if (!priceId) return null;
  if (priceId === process.env.STRIPE_PRICE_STANDARD) return 'standard';
  if (priceId === process.env.STRIPE_PRICE_TEAM) return 'team';
  if (priceId === process.env.STRIPE_PRICE_PRO) return 'pro';
  return null;
}
