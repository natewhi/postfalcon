import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterEach, afterAll } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env.test'), override: true });

const { pool } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { uploadDir } = await import('../middleware/upload.js');
const fs = await import('node:fs/promises');

beforeAll(async () => {
  await migrate();
});

afterEach(async () => {
  await pool.query('TRUNCATE posts, social_accounts, users, mastodon_apps RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  await pool.end();
  const files = await fs.readdir(uploadDir).catch(() => []);
  await Promise.all(files.map((f) => fs.unlink(path.join(uploadDir, f)).catch(() => {})));
});
