import { Router } from 'express';
import { pool } from '../db/pool.js';
import { getStripe, planForPriceId } from '../lib/billing.js';
import { logProductEvent } from '../lib/activityLog.js';
import { logger } from '../lib/logger.js';

// Mounted in app.js with express.raw() and BEFORE express.json()/csrfProtection: Stripe
// signs the raw request body, and it authenticates itself with that signature rather than
// a session or CSRF token.
const router = Router();

// Maps a Stripe subscription's status onto our narrower plan_status enum.
function resolveStatus(stripeStatus) {
  if (stripeStatus === 'trialing') return 'trialing';
  if (stripeStatus === 'past_due' || stripeStatus === 'unpaid') return 'past_due';
  if (stripeStatus === 'active') return 'active';
  if (stripeStatus === 'incomplete' || stripeStatus === 'incomplete_expired') return 'incomplete';
  return 'canceled';
}

async function applySubscription(userId, customerId, subscription) {
  const priceId = subscription.items?.data?.[0]?.price?.id;
  const plan = planForPriceId(priceId); // null if the price id isn't one of ours
  const status = resolveStatus(subscription.status);
  const renewsAt = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000)
    : null;

  // There's no free plan: keep the last-known `plan` when the price can't be resolved, and
  // let plan_status ('canceled' / 'incomplete') drive the lockout via lib/billing.js isEntitled.
  await pool.query(
    `UPDATE users
       SET stripe_customer_id = COALESCE(stripe_customer_id, $1),
           plan = COALESCE($2, plan),
           plan_status = $3,
           plan_renews_at = $4
     WHERE id = $5`,
    [customerId, plan, status, renewsAt, userId]
  );

  await logProductEvent(userId, 'plan_changed', { plan: plan ?? 'unchanged', status }).catch((err) =>
    logger.error({ err }, 'failed to record plan_changed event')
  );
}

async function resolveUserId(subscription, session) {
  if (session?.client_reference_id) return Number(session.client_reference_id);
  const { rows } = await pool.query('SELECT id FROM users WHERE stripe_customer_id = $1', [subscription.customer]);
  return rows[0]?.id ?? null;
}

async function handleEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      if (!session.subscription) break;
      const stripe = await getStripe();
      const subscription = await stripe.subscriptions.retrieve(session.subscription);
      const userId = await resolveUserId(subscription, session);
      if (userId) await applySubscription(userId, session.customer, subscription);
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const userId = await resolveUserId(subscription, null);
      if (userId) {
        await applySubscription(userId, subscription.customer, subscription);
      } else {
        logger.warn({ customerId: subscription.customer }, 'subscription webhook for unknown customer');
      }
      break;
    }
    default:
      break;
  }
}

router.post('/', async (req, res) => {
  let event;
  try {
    if (process.env.NODE_ENV === 'test') {
      // The test suite posts event JSON directly (no Stripe signature to verify).
      event = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body));
    } else {
      const stripe = await getStripe();
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    }
  } catch (err) {
    logger.warn({ err }, 'stripe webhook could not be parsed/verified');
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // Idempotency: Stripe redelivers events. Skip one already processed; otherwise handle it
    // and only then record the id — so a handler failure leaves no record and Stripe's retry
    // gets another go (every handler here is an idempotent UPDATE, so a re-run is harmless).
    const seen = await pool.query('SELECT 1 FROM billing_events WHERE stripe_event_id = $1', [event.id]);
    if (seen.rows.length > 0) {
      return res.json({ received: true, duplicate: true });
    }
    await handleEvent(event);
    await pool.query(
      'INSERT INTO billing_events (stripe_event_id, type) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [event.id, event.type]
    );
  } catch (err) {
    logger.error({ err, eventType: event.type }, 'stripe webhook handler failed');
    // 500 so Stripe retries the delivery.
    return res.status(500).json({ error: 'webhook_handler_failed' });
  }
  res.json({ received: true });
});

export default router;
