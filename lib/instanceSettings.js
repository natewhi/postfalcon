import { pool } from '../db/pool.js';
import { selfHosted } from './billing.js';

// Instance-wide settings an admin changes from Admin -> Settings (and Admin -> Customers for
// sign-ups) instead of .env or SQL, stored in instance_settings (migration 029), one row per
// key. Read straight from the table each time rather than cached: they're only needed on page
// renders and signups, and a cache would go stale whenever the table is changed outside this
// process (tests truncate it between cases).
//
//   site_name    shown in the header, sidebar and page titles
//   public_site  'on' = the marketing pages (landing, blog) at /; 'off' = / goes to log in.
//                No row: on for a hosted instance (Stripe configured), off when self-hosted.
//   signup_mode  see lib/signups.js

export const DEFAULT_SITE_NAME = 'Postfalcon';
export const PUBLIC_SITE_VALUES = ['on', 'off'];

export async function readInstanceSettings() {
  const { rows } = await pool.query('SELECT key, value FROM instance_settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function saveInstanceSetting(key, value, userId) {
  await pool.query(
    `INSERT INTO instance_settings (key, value, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), userId]
  );
}

export async function clearInstanceSetting(key) {
  await pool.query('DELETE FROM instance_settings WHERE key = $1', [key]);
}

// The settings with their defaults filled in, as views and routes use them.
export function resolveSettings(stored) {
  const siteName = typeof stored.site_name === 'string' && stored.site_name.trim() ? stored.site_name.trim() : DEFAULT_SITE_NAME;
  const publicSite = PUBLIC_SITE_VALUES.includes(stored.public_site) ? stored.public_site === 'on' : !selfHosted();
  return { siteName, publicSite, publicSiteSaved: PUBLIC_SITE_VALUES.includes(stored.public_site) };
}
