import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { sendMail } from '../lib/mailer.js';
import { createToken } from '../lib/tokens.js';
import { logAuthEvent } from '../lib/activityLog.js';

const router = Router();

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

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
    const user = result.rows[0];

    const token = await createToken(user.id, 'email_verification', ONE_DAY_MS);
    const verifyUrl = `${process.env.BASE_URL}/api/auth/verify-email?token=${token}`;
    await sendMail({ to: email, subject: 'Verify your Postfox email', text: `Verify your email: ${verifyUrl}` });

    await logAuthEvent(req, 'signup', { userId: user.id, email: user.email }).catch((logErr) =>
      req.log.error({ err: logErr }, 'failed to record auth event')
    );

    res.status(201).json(user);
  })
);

export default router;
