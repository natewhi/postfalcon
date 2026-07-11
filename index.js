import app from './app.js';
import { startScheduler } from './scheduler.js';

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`postfox listening on port ${port}`);
});

startScheduler();
