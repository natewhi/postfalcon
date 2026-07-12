import express from 'express';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import helmet from 'helmet';
import multer from 'multer';
import { pool } from './db/pool.js';
import usersRouter from './routes/users.js';
import authRouter from './routes/auth.js';
import socialAccountsRouter from './routes/socialAccounts.js';
import postsRouter from './routes/posts.js';
import mastodonRouter from './routes/mastodon.js';
import pagesRouter from './routes/pages.js';
import { requireAuth } from './middleware/auth.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PgSession = connectPgSimple(session);

const isProduction = process.env.NODE_ENV === 'production';
const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
if (isProduction) {
  app.set('trust proxy', 1);
}

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'script-src': ["'self'"],
        ...(isProduction ? {} : { 'upgrade-insecure-requests': null }),
      },
    },
  })
);
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '100kb' }));
app.use(
  session({
    store: new PgSession({ pool, createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
      secure: isProduction,
    },
  })
);

app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() AS now');
    res.json({ status: 'ok', db: 'connected', time: result.rows[0].now });
  } catch (err) {
    res.status(500).json({ status: 'error', db: 'disconnected', error: err.message });
  }
});

app.use('/api/users', usersRouter);
app.use('/api/auth', authRouter);
app.use('/api/social-accounts', requireAuth, socialAccountsRouter);
app.use('/api/posts', requireAuth, postsRouter);
app.use('/api/mastodon', requireAuth, mastodonRouter);
app.use('/', pagesRouter);

app.use((err, req, res, next) => {
  if (err.code === '23505') {
    return res.status(409).json({ error: 'already exists' });
  }
  if (err instanceof multer.MulterError || err.status === 400) {
    return res.status(400).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'internal_server_error' });
});

export default app;
