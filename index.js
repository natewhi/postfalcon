import 'dotenv/config';
import { logger } from './lib/logger.js';

// Check the required settings before loading the app, so a fresh install that skipped them
// stops with a readable message rather than a confusing failure later (sessions that don't
// sign, OAuth callbacks pointing nowhere). See .env.example's REQUIRED section. A leftover
// "change-me" only warns (Admin -> Overview flags it too) so an existing server keeps running.
const REQUIRED = ['DATABASE_URL', 'SESSION_SECRET', 'BASE_URL'];
const empty = REQUIRED.filter((key) => !process.env[key]?.trim());
if (empty.length) {
  logger.fatal(`Missing required settings in .env: ${empty.join(', ')}. See .env.example.`);
  process.exit(1);
}
const placeholders = REQUIRED.filter((key) => process.env[key].includes('change-me'));
if (placeholders.length) {
  logger.error(`Still set to the .env.example placeholder: ${placeholders.join(', ')}. Replace them.`);
}

const { default: app } = await import('./app.js');
const { startScheduler } = await import('./scheduler.js');

const port = process.env.PORT || 3000;

app.listen(port, () => {
  logger.info(`postfalcon listening on port ${port}`);
});

startScheduler();
