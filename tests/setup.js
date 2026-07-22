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
});

afterEach(async () => {
  await pool.query(
    'TRUNCATE posts, social_accounts, users, mastodon_apps, user_tokens, page_visits, auth_events, product_events RESTART IDENTITY CASCADE'
  );
});

afterAll(async () => {
  await pool.end();
  const files = await fs.readdir(uploadDir).catch(() => []);
  await Promise.all(files.map((f) => fs.unlink(path.join(uploadDir, f)).catch(() => {})));
});
