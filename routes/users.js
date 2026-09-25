import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { sendMail } from '../lib/mailer.js';
import { createToken } from '../lib/tokens.js';
import { logAuthEvent, logProductEvent } from '../lib/activityLog.js';

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
    let result;
    try {
      result = await pool.query(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at',
        [email, password_hash]
      );
    } catch (err) {
      // 23505 = unique violation (email already registered) — by far the most common way a
      // signup fails past validation, and a real interest signal (someone tried, twice) worth
      // seeing in the admin console. The global error handler (app.js) still turns this into
      // the normal 409 response — this only adds a log, it doesn't change what the client sees.
      if (err.code === '23505') {
        await logProductEvent(null, 'signup_attempt_failed', { email, reason: 'email_already_registered' }).catch(
          (logErr) => req.log.error({ err: logErr }, 'failed to record product event')
        );
      }
      throw err;
    }
    const user = result.rows[0];

    const token = await createToken(user.id, 'email_verification', ONE_DAY_MS);
    const verifyUrl = `${process.env.BASE_URL}/api/auth/verify-email?token=${token}`;
    await sendMail({ to: email, subject: 'Verify your Postfalcon email', text: `Verify your email: ${verifyUrl}` });

    await logAuthEvent(req, 'signup', { userId: user.id, email: user.email }).catch((logErr) =>
      req.log.error({ err: logErr }, 'failed to record auth event')
    );

    res.status(201).json(user);
  })
);

export default router;
