import path from 'node:path';
import { pool } from '../db/pool.js';
import { billingConfigured, cancelRunningSubscriptions } from './billing.js';
import { deleteMedia } from './storage.js';

// Deleting an account, shared by the user's own "Delete account" (routes/auth.js) and an
// admin's (routes/admin.js) so the two can't drift apart.
//
// Billing stops first: if Stripe can't be reached the account is kept rather than risk
// charging someone who no longer has one (BillingUnavailableError; the caller says "try again").
// Then the row goes (everything else cascades) and its uploaded media files are removed.
// `beforeDelete(email)` runs after billing is stopped and before the row goes, for records that
// must be written while the user still exists (auth_events/product_events reference it).
// Returns the deleted account's email, or null if there was no such account.
export class BillingUnavailableError extends Error {}

export async function deleteUserAccount(userId, { log, beforeDelete } = {}) {
  const { rows } = await pool.query('SELECT email, stripe_customer_id FROM users WHERE id = $1', [userId]);
  if (rows.length === 0) return null;
  const { email, stripe_customer_id: customerId } = rows[0];

  if (customerId && billingConfigured()) {
    try {
      await cancelRunningSubscriptions(customerId);
    } catch (err) {
      log?.error({ err, customerId }, 'could not cancel subscriptions before account deletion');
      throw new BillingUnavailableError("Couldn't cancel the Stripe subscription just now, so the account wasn't deleted.");
    }
  }

  if (beforeDelete) await beforeDelete(email);
  const media = await pool.query(
    'SELECT pm.url FROM post_media pm JOIN posts p ON p.id = pm.post_id WHERE p.user_id = $1',
    [userId]
  );
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await Promise.all(media.rows.map((row) => deleteMedia(path.basename(row.url))));
  return email;
}
