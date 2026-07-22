import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import passport from '../lib/passport.js';
import { pool } from '../db/pool.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/auth.js';
import { sendMail } from '../lib/mailer.js';
import { createToken, consumeToken, hashToken } from '../lib/tokens.js';
import { uploadDir } from '../middleware/upload.js';
import { logAuthEvent } from '../lib/activityLog.js';

const router = Router();

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

router.post('/login', authLimiter, validate(loginSchema), (req, res, next) => {
  passport.authenticate('local', async (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      await logAuthEvent(req, 'login_failure', { email: req.body.email }).catch((logErr) =>
        req.log.error({ err: logErr }, 'failed to record auth event')
      );
      return res.status(401).json({ error: info?.message || 'invalid email or password' });
    }
    req.login(user, async (loginErr) => {
      if (loginErr) return next(loginErr);
      await logAuthEvent(req, 'login_success', { userId: user.id, email: user.email }).catch((logErr) =>
        req.log.error({ err: logErr }, 'failed to record auth event')
      );
      res.json({ id: user.id, email: user.email });
    });
  })(req, res, next);
});

router.post('/logout', (req, res, next) => {
  const loggedOutUser = req.user;
  req.logout(async (err) => {
    if (err) return next(err);
    if (loggedOutUser) {
      await logAuthEvent(req, 'logout', { userId: loggedOutUser.id, email: loggedOutUser.email }).catch((logErr) =>
        req.log.error({ err: logErr }, 'failed to record auth event')
      );
    }
    res.status(204).end();
  });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ id: req.user.id, email: req.user.email });
});

const forgotPasswordSchema = z.object({ email: z.string().trim().toLowerCase().email() });

router.post(
  '/forgot-password',
  authLimiter,
  validate(forgotPasswordSchema),
  asyncHandler(async (req, res) => {
    const { email } = req.body;
    const result = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (result.rows.length > 0) {
      const token = await createToken(result.rows[0].id, 'password_reset', ONE_HOUR_MS);
      const resetUrl = `${process.env.BASE_URL}/reset-password?token=${token}`;
      await sendMail({ to: email, subject: 'Reset your Postfox password', text: `Reset your password: ${resetUrl}` });
    }
    // Logged server-side regardless of whether the email exists (matches result.rows.length),
    // but the response stays 204 either way so this endpoint can't be used to enumerate accounts.
    await logAuthEvent(req, 'password_reset_request', {
      userId: result.rows[0]?.id ?? null,
      email,
    }).catch((logErr) => req.log.error({ err: logErr }, 'failed to record auth event'));
    res.status(204).end();
  })
);

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(255),
});

router.post(
  '/reset-password',
  authLimiter,
  validate(resetPasswordSchema),
  asyncHandler(async (req, res) => {
    const { token, password } = req.body;
    const userId = await consumeToken(token, 'password_reset');
    if (!userId) {
      return res.status(400).json({ error: 'invalid or expired token' });
    }
    const password_hash = await bcrypt.hash(password, 10);
    const result = await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING email', [
      password_hash,
      userId,
    ]);
    await logAuthEvent(req, 'password_reset_complete', { userId, email: result.rows[0].email }).catch((logErr) =>
      req.log.error({ err: logErr }, 'failed to record auth event')
    );
    res.status(204).end();
  })
);

router.get(
  '/verify-email',
  asyncHandler(async (req, res) => {
    const { token } = req.query;
    const userId = token ? await consumeToken(String(token), 'email_verification') : null;
    if (!userId) {
      return res.status(400).send('Invalid or expired verification link.');
    }
    const result = await pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1 RETURNING email', [
      userId,
    ]);
    await logAuthEvent(req, 'email_verified', { userId, email: result.rows[0].email }).catch((logErr) =>
      req.log.error({ err: logErr }, 'failed to record auth event')
    );
    res.redirect('/login?verified=1');
  })
);

router.post(
  '/resend-verification',
  requireAuth,
  authLimiter,
  asyncHandler(async (req, res) => {
    const token = await createToken(req.user.id, 'email_verification', ONE_DAY_MS);
    const verifyUrl = `${process.env.BASE_URL}/api/auth/verify-email?token=${token}`;
    await sendMail({ to: req.user.email, subject: 'Verify your Postfox email', text: `Verify your email: ${verifyUrl}` });
    res.status(204).end();
  })
);

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(255),
});

router.post(
  '/change-password',
  requireAuth,
  authLimiter,
  validate(changePasswordSchema),
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const valid = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'current password is incorrect' });
    }
    const password_hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [password_hash, req.user.id]);

    // Log out every other session for this user so a stolen session cookie stops working
    // once the password is changed. The current session (this request) is left alone.
    await pool.query(`DELETE FROM session WHERE sid != $1 AND sess #>> '{passport,user}' = $2`, [
      req.sessionID,
      String(req.user.id),
    ]);

    await sendMail({
      to: req.user.email,
      subject: 'Your Postfox password was changed',
      text: "Your account password was just changed. If this wasn't you, reset your password immediately.",
    });

    await logAuthEvent(req, 'password_change', { userId: req.user.id, email: req.user.email }).catch((logErr) =>
      req.log.error({ err: logErr }, 'failed to record auth event')
    );

    res.status(204).end();
  })
);

const deleteAccountSchema = z.object({ password: z.string().min(1) });

router.post(
  '/delete-account',
  requireAuth,
  authLimiter,
  validate(deleteAccountSchema),
  asyncHandler(async (req, res) => {
    const { password } = req.body;
    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const valid = await bcrypt.compare(password, result.rows[0].password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'password is incorrect' });
    }

    const mediaRows = await pool.query(
      `SELECT pm.url FROM post_media pm JOIN posts p ON p.id = pm.post_id WHERE p.user_id = $1`,
      [req.user.id]
    );
    const email = req.user.email;
    // Logged before the DELETE: user_id has a real FK to users, so the event row must be
    // inserted while the account still exists (it's kept afterwards via ON DELETE SET NULL).
    await logAuthEvent(req, 'account_deleted', { userId: req.user.id, email }).catch((logErr) =>
      req.log.error({ err: logErr }, 'failed to record auth event')
    );
    await pool.query('DELETE FROM users WHERE id = $1', [req.user.id]);
    await Promise.all(
      mediaRows.rows.map((row) => fs.unlink(path.join(uploadDir, path.basename(row.url))).catch(() => {}))
    );

    await sendMail({
      to: email,
      subject: 'Your Postfox account was deleted',
      text: "Your account and all its data were just deleted. If this wasn't you, contact support immediately.",
    });

    req.logout(() => {
      req.session.destroy(() => {
        res.status(204).end();
      });
    });
  })
);

router.get(
  '/api-token',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await pool.query('SELECT created_at, last_used_at FROM api_tokens WHERE user_id = $1', [
      req.user.id,
    ]);
    if (result.rows.length === 0) {
      return res.json({ exists: false });
    }
    res.json({ exists: true, created_at: result.rows[0].created_at, last_used_at: result.rows[0].last_used_at });
  })
);

router.post(
  '/api-token',
  requireAuth,
  authLimiter,
  asyncHandler(async (req, res) => {
    const token = `pf_${crypto.randomBytes(24).toString('hex')}`;
    // A user has at most one active token; generating a new one invalidates any old one.
    await pool.query('DELETE FROM api_tokens WHERE user_id = $1', [req.user.id]);
    await pool.query('INSERT INTO api_tokens (user_id, token_hash) VALUES ($1, $2)', [
      req.user.id,
      hashToken(token),
    ]);
    await logAuthEvent(req, 'api_token_created', { userId: req.user.id, email: req.user.email }).catch((logErr) =>
      req.log.error({ err: logErr }, 'failed to record auth event')
    );
    res.status(201).json({ token });
  })
);

router.delete(
  '/api-token',
  requireAuth,
  asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM api_tokens WHERE user_id = $1', [req.user.id]);
    await logAuthEvent(req, 'api_token_revoked', { userId: req.user.id, email: req.user.email }).catch((logErr) =>
      req.log.error({ err: logErr }, 'failed to record auth event')
    );
    res.status(204).end();
  })
);

export default router;
