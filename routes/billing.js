import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  PLANS,
  PAID_PLAN_IDS,
  TRIAL_DAYS,
  limitsForPlan,
  getStripe,
  billingConfigured,
  priceIdForPlan,
  BILLING_INTERVALS,
  subscriptionsFor,
  hasRunningSubscription,
  trialEligible,
} from '../lib/billing.js';

const router = Router();

const checkoutSchema = z.object({
  plan: z.enum(PAID_PLAN_IDS),
  interval: z.enum(BILLING_INTERVALS).default('monthly'),
});

function limitOrNull(value) {
  return value === Infinity ? null : value;
}

async function getOrCreateCustomer(user) {
  if (user.stripe_customer_id) return user.stripe_customer_id;
  const stripe = await getStripe();
  const customer = await stripe.customers.create({
    email: user.email,
    metadata: { userId: String(user.id) },
  });
  await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customer.id, user.id]);
  return customer.id;
}

// Current plan, its limits, and the user's usage against them. Drives the pricing page's
// "current plan" state and the settings page's billing section.
router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const limits = limitsForPlan(req.user.plan);
    const [{ rows: accountRows }, { rows: postRows }] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS n FROM social_accounts WHERE user_id = $1', [req.user.id]),
      pool.query("SELECT COUNT(*)::int AS n FROM posts WHERE user_id = $1 AND status = 'scheduled'", [req.user.id]),
    ]);
    res.json({
      plan: req.user.plan,
      planName: PLANS[req.user.plan]?.name ?? req.user.plan,
      planStatus: req.user.plan_status,
      renewsAt: req.user.plan_renews_at,
      // Set when the subscription was cancelled but runs to the end of the paid period.
      cancelsAt: req.user.plan_cancels_at,
      billingConfigured: billingConfigured(),
      hasBillingAccount: Boolean(req.user.stripe_customer_id),
      capabilities: PLANS[req.user.plan]?.capabilities ?? {},
      limits: { accounts: limitOrNull(limits.accounts), scheduledPosts: limitOrNull(limits.scheduledPosts) },
      usage: { accounts: accountRows[0].n, scheduledPosts: postRows[0].n },
    });
  })
);

// Starts a Stripe Checkout session for a paid plan and returns its hosted URL.
router.post(
  '/checkout',
  validate(checkoutSchema),
  asyncHandler(async (req, res) => {
    if (!billingConfigured()) {
      return res.status(503).json({ error: 'billing_unavailable', message: 'Billing is not configured on this server.' });
    }
    const { plan, interval } = req.body;
    const priceId = await priceIdForPlan(plan, interval);
    if (!priceId) {
      return res
        .status(503)
        .json({ error: 'billing_unavailable', message: `No Stripe price configured for the ${interval} ${plan} plan.` });
    }

    // An existing customer may already be subscribed (a second Checkout would start a second,
    // separately billed subscription — plan changes go through the billing portal instead), or
    // may just have abandoned an earlier Checkout, which mustn't cost them the trial.
    let trialOk = true;
    if (req.user.stripe_customer_id) {
      const subscriptions = await subscriptionsFor(req.user.stripe_customer_id);
      if (hasRunningSubscription(subscriptions)) {
        return res.status(409).json({
          error: 'already_subscribed',
          message: 'You already have a subscription. Use Manage billing to change your plan.',
        });
      }
      trialOk = trialEligible(subscriptions);
    }

    const customerId = await getOrCreateCustomer(req.user);
    const stripe = await getStripe();
    // The trial is for first-time subscribers, monthly or yearly alike (a yearly plan's first
    // charge is just as deferred).
    const trial = trialOk ? { subscription_data: { trial_period_days: TRIAL_DAYS } } : {};
    // A required "I agree to the Terms" tick on the payment page: evidence if a charge is ever
    // disputed. Stripe refuses it unless a Terms of Service URL is saved in the account's public
    // business details, which a sandbox can't hold, hence the opt-in (set it once live).
    const terms =
      process.env.STRIPE_REQUIRE_TERMS === 'true'
        ? {
            consent_collection: { terms_of_service: 'required' },
            custom_text: {
              terms_of_service_acceptance: {
                message: `I agree to the [Terms of Service](${process.env.BASE_URL}/terms), including that my plan renews automatically until I cancel.`,
              },
            },
          }
        : {};
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: String(req.user.id),
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      // Always collect a card, even when the subscription starts in a trial, so the plan
      // converts automatically when the trial ends.
      payment_method_collection: 'always',
      ...trial,
      ...terms,
      success_url: `${process.env.BASE_URL}/settings?checkout=success`,
      cancel_url: `${process.env.BASE_URL}/pricing?checkout=cancelled`,
    });
    res.json({ url: session.url });
  })
);

// Opens the Stripe Billing Portal so the user can change plan, update card, or cancel.
router.post(
  '/portal',
  asyncHandler(async (req, res) => {
    if (!billingConfigured()) {
      return res.status(503).json({ error: 'billing_unavailable', message: 'Billing is not configured on this server.' });
    }
    if (!req.user.stripe_customer_id) {
      return res.status(400).json({ error: 'no_billing_account', message: "You don't have a billing account yet." });
    }
    const stripe = await getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: req.user.stripe_customer_id,
      return_url: `${process.env.BASE_URL}/settings`,
    });
    res.json({ url: session.url });
  })
);

export default router;
