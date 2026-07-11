import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authLimiter } from '../middleware/rateLimit.js';

const router = Router();

const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(255),
});

router.post(
  '/',
  authLimiter,
  validate(signupSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const password_hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at',
      [email, password_hash]
    );
    res.status(201).json(result.rows[0]);
  })
);

export default router;
