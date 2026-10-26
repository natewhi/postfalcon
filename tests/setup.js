import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi, beforeAll, afterEach, afterAll } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env.test'), override: true });

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
