import { pool } from '../db/pool.js';
import { planForPrice, subscriptionsFor, currentSubscription } from './billing.js';
import { logProductEvent } from './activityLog.js';
import { logger } from './logger.js';

// Copies Stripe subscription state onto users.plan / plan_status / plan_renews_at /
// plan_cancels_at, the app's read-fast copy of it. Shared by the Stripe webhook
// (routes/billingWebhook.js) and the nightly reconcileSubscriptions() safety net below.

// Maps a Stripe subscription's status onto our narrower plan_status enum. past_due (a renewal
// payment failed, Stripe is still retrying) keeps access; unpaid (every retry failed) doesn't.
function resolveStatus(stripeStatus) {
  if (stripeStatus === 'trialing') return 'trialing';
  if (stripeStatus === 'past_due') return 'past_due';
  if (stripeStatus === 'active') return 'active';
  if (stripeStatus === 'incomplete' || stripeStatus === 'incomplete_expired') return 'incomplete';
  return 'canceled';
}

// Writes `subscription` onto the user. Returns true if anything actually changed (so an
// unchanged nightly check doesn't log a plan_changed event for every subscriber).
export async function applySubscription(userId, customerId, subscription) {
  const item = subscription.items?.data?.[0];
  const plan = planForPrice(item?.price); // null if the Price isn't one of ours
  const status = resolveStatus(subscription.status);
  // Stripe API versions from 2025-03-31 moved current_period_end from the subscription onto
  // each item, and webhook payloads follow the endpoint's API version, so read either.
  const periodEnd = subscription.current_period_end ?? item?.current_period_end;
  const renewsAt = periodEnd ? new Date(periodEnd * 1000) : null;
  // A subscription cancelled "at the end of the billing period" stays active until then.
  let cancelsAt = null;
  if (status !== 'canceled') {
    if (subscription.cancel_at) cancelsAt = new Date(subscription.cancel_at * 1000);
    else if (subscription.cancel_at_period_end) cancelsAt = renewsAt;
  }

  // There's no free plan: keep the last-known `plan` when the price can't be resolved, and
  // let plan_status ('canceled' / 'incomplete') drive the lockout via lib/billing.js isEntitled.
  const { rowCount } = await pool.query(
    `UPDATE users
       SET stripe_customer_id = COALESCE(stripe_customer_id, $1),
           plan = COALESCE($2, plan),
           plan_status = $3,
           plan_renews_at = $4,
           plan_cancels_at = $5
     WHERE id = $6
       AND (stripe_customer_id IS NULL
            OR plan IS DISTINCT FROM COALESCE($2, plan)
            OR plan_status IS DISTINCT FROM $3
            OR plan_renews_at IS DISTINCT FROM $4
            OR plan_cancels_at IS DISTINCT FROM $5)`,
    [customerId, plan, status, renewsAt, cancelsAt, userId]
  );
  if (rowCount === 0) return false;

  await logProductEvent(userId, 'plan_changed', { plan: plan ?? 'unchanged', status }).catch((err) =>
    logger.error({ err }, 'failed to record plan_changed event')
  );
  return true;
}

// Applies the customer's current subscription (lib/billing.js currentSubscription), read fresh
// from Stripe, rather than `eventSubscription` — the copy inside a webhook event, which may be
// stale or belong to an older subscription. Falls back to it only if Stripe lists none.
// Returns whether anything changed, or null when there was nothing to apply.
export async function applyCurrent(userId, customerId, eventSubscription = null) {
  const current = currentSubscription(await subscriptionsFor(customerId)) ?? eventSubscription;
  if (!current) return null;
  return applySubscription(userId, customerId, current);
}

// Nightly (scheduler.js): re-reads every Stripe customer's subscription and corrects the
// user row if it has drifted — the safety net for a webhook that was never delivered (the app
// down longer than Stripe's 3 days of retries) or mishandled. Like the webhook, it only acts on
// customers who have a subscription: one with none (an abandoned Checkout, or a review/test
// login set to 'active' by hand) is left exactly as it is. Admins are skipped too, since their
// access is set by hand. One customer failing doesn't stop the rest.
export async function reconcileSubscriptions() {
  const { rows: users } = await pool.query(
    'SELECT id, stripe_customer_id FROM users WHERE stripe_customer_id IS NOT NULL AND NOT is_admin'
  );
  let corrected = 0;
  let failed = 0;
  for (const user of users) {
    try {
      if (await applyCurrent(user.id, user.stripe_customer_id)) {
        corrected++;
        logger.warn({ userId: user.id }, 'billing reconciliation corrected a subscription the webhooks missed');
      }
    } catch (err) {
      failed++;
      logger.error({ err, userId: user.id }, 'billing reconciliation failed for a customer');
    }
  }
  return { checked: users.length, corrected, failed };
}
