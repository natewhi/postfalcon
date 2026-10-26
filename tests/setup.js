import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env.test'), override: true });

// Placeholder app keys for every platform, so the suite runs as a fully set-up server
// (lib/platforms.js only offers a platform once its keys are set). Tests that need real-looking
// values set their own; a test of the unset case deletes one and puts it back.
for (const key of [
  'FACEBOOK_APP_ID',
  'FACEBOOK_APP_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'TIKTOK_CLIENT_KEY',
  'TIKTOK_CLIENT_SECRET',
  'THREADS_CLIENT_ID',
  'THREADS_CLIENT_SECRET',
  'PINTEREST_APP_ID',
  'PINTEREST_APP_SECRET',
  'LINKEDIN_CLIENT_ID',
  'LINKEDIN_CLIENT_SECRET',
  'X_CLIENT_ID',
  'X_CLIENT_SECRET',
]) {
  process.env[key] ||= `test-${key.toLowerCase()}`;
}

vi.mock('../lib/mailer.js', () => ({ sendMail: vi.fn().mockResolvedValue(undefined) }));

const { pool } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { uploadDir } = await import('../middleware/upload.js');
const fs = await import('node:fs/promises');

beforeAll(async () => {
  await migrate();
  // Production signups start 'incomplete' until Stripe Checkout completes (migration 023).
  // Nearly every test signs up through POST /api/users and then posts/connects, so the test
  // DB's default stands in for "this user already finished Checkout". billing.test.js sets
  // 'incomplete' explicitly to cover the real default.
  await pool.query("ALTER TABLE users ALTER COLUMN plan_status SET DEFAULT 'trialing'");
  // Every test starts from an empty users table, so the first-account-is-admin trigger
  // (migration 028) would make each test's first user an admin. admin.test.js turns it back
  // on to cover it.
  await pool.query('ALTER TABLE users DISABLE TRIGGER first_user_is_admin');
});

// The suite has no Stripe key, i.e. runs as a self-hosted server, where the public website
// (landing page, blog) defaults to off (lib/instanceSettings.js). Most page tests are about that
// website, so it's switched on for each test; a test of the default clears it.
beforeEach(async () => {
  await pool.query(`INSERT INTO instance_settings (key, value) VALUES ('public_site', '"on"') ON CONFLICT (key) DO NOTHING`);
});

afterEach(async () => {
  await pool.query(
    'TRUNCATE posts, social_accounts, users, mastodon_apps, user_tokens, page_visits, auth_events, product_events, billing_events, webhooks RESTART IDENTITY CASCADE'
  );
});

afterAll(async () => {
  await pool.end();
  const files = await fs.readdir(uploadDir).catch(() => []);
  await Promise.all(files.map((f) => fs.unlink(path.join(uploadDir, f)).catch(() => {})));
});
