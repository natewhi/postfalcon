import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requirePageAuth } from '../middleware/auth.js';

const router = Router();

router.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('login');
});

router.get('/signup', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('signup');
});

router.get('/', requirePageAuth, async (req, res) => {
  const result = await pool.query('SELECT email FROM users WHERE id = $1', [req.session.userId]);
  res.render('dashboard', { email: result.rows[0]?.email });
});

export default router;
