import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authLimiter } from '../middleware/rateLimit.js';

const router = Router();

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

router.post(
  '/login',
  authLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const result = await pool.query('SELECT id, email, password_hash FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'invalid email or password' });
    }
    req.session.userId = user.id;
    res.json({ id: user.id, email: user.email });
  })
);

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.status(204).end();
  });
});

router.get('/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'not authenticated' });
  res.json({ id: req.session.userId });
});

export default router;
