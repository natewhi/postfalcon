import app from './app.js';
import { startScheduler } from './scheduler.js';
import { logger } from './lib/logger.js';

const port = process.env.PORT || 3000;

app.listen(port, () => {
  logger.info(`postfalcon listening on port ${port}`);
});

startScheduler();
