import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterEach, afterAll } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env.test'), override: true });

const { pool } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');

beforeAll(async () => {
  await migrate();
});

afterEach(async () => {
  await pool.query('TRUNCATE posts, post_media, social_accounts, users RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  await pool.end();
});
