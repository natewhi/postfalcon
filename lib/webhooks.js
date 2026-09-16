import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { logger } from './logger.js';

const DELIVERY_TIMEOUT_MS = 8000;

export function newWebhookSecret() {
  return `whsec_${crypto.randomBytes(24).toString('hex')}`;
}

function sign(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// Fan a domain event out to every active webhook the user has registered for it. Fire and
// forget — a slow or failing endpoint never blocks or fails the post that triggered it.
export async function deliverWebhooks(userId, event, data) {
  let hooks;
  try {
    const { rows } = await pool.query(
      'SELECT id, url, secret FROM webhooks WHERE user_id = $1 AND active = true AND $2 = ANY(events)',
      [userId, event]
    );
    hooks = rows;
  } catch (err) {
    logger.error({ err }, 'failed to load webhooks for delivery');
    return;
  }
  if (hooks.length === 0) return;

  const body = JSON.stringify({ event, sent_at: new Date().toISOString(), data });

  await Promise.all(
    hooks.map(async (hook) => {
      let status = 0;
      try {
        const res = await fetch(hook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Postfox-Webhooks/1',
            'X-Postfox-Event': event,
            'X-Postfox-Signature': `sha256=${sign(hook.secret, body)}`,
          },
          body,
          signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        });
        status = res.status;
      } catch (err) {
        logger.warn({ err, webhookId: hook.id }, 'webhook delivery failed');
      }
      await pool
        .query('UPDATE webhooks SET last_delivery_at = now(), last_delivery_status = $2 WHERE id = $1', [
          hook.id,
          status || null,
        ])
        .catch(() => {});
    })
  );
}
