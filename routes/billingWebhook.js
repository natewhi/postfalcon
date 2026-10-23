import { Router } from 'express';
import { pool } from '../db/pool.js';
import { getStripe } from '../lib/billing.js';
import { applyCurrent } from '../lib/billingSync.js';
import { logger } from '../lib/logger.js';

// Mounted in app.js with express.raw() and BEFORE express.json()/csrfProtection: Stripe
// signs the raw request body, and it authenticates itself with that signature rather than
// a session or CSRF token.
const router = Router();

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
      if (userId) await applyCurrent(userId, session.customer, subscription);
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const userId = await resolveUserId(subscription, null);
      if (userId) {
        await applyCurrent(userId, subscription.customer, subscription);
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
