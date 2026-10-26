import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import passport from '../lib/passport.js';
import { pool } from '../db/pool.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/auth.js';
import { sendMail } from '../lib/mailer.js';
import { createToken, consumeToken, hashToken } from '../lib/tokens.js';
import { logAuthEvent } from '../lib/activityLog.js';
import { signupGate, createUserThroughGate } from '../lib/signups.js';
import { deleteUserAccount, BillingUnavailableError } from '../lib/accounts.js';

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

// "Sign in with Google" — a login/signup alternative to email+password, hand-rolled with raw
// fetch() the same way every other OAuth flow in this codebase is (Mastodon/Facebook/Threads/
// YouTube/TikTok), not a passport strategy package. Reuses the same GOOGLE_CLIENT_ID/SECRET as
// routes/youtube.js's channel-connect flow (one Google Cloud OAuth client, two redirect URIs,
// different scopes) — but is otherwise unrelated: this never touches social_accounts or stores
// a Google access token, it only needs the one-time profile lookup to establish a session.
const GOOGLE_AUTH_SCOPE = 'openid email profile';

function googleRedirectUri() {
  return `${process.env.BASE_URL}/api/auth/google/callback`;
}

router.get(
  '/google',
  authLimiter,
  asyncHandler(async (req, res) => {
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(503).send('Google sign-in is not configured on this server.');
    }
    const state = crypto.randomBytes(16).toString('hex');
    req.session.googleAuthState = state;
    // Carried through to the callback so a signup flow (?plan=standard, from /pricing) still
    // lands on checkout afterward, same as local email/password signup does.
    req.session.googleAuthPlan = typeof req.query.plan === 'string' ? req.query.plan.slice(0, 40) : null;
    // An invite link (?invite=, from the signup page) for when sign-ups are invite-only; only
    // used if this Google account turns out to be new.
    req.session.googleAuthInvite = typeof req.query.invite === 'string' ? req.query.invite.slice(0, 200) : null;

    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
    url.searchParams.set('redirect_uri', googleRedirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', GOOGLE_AUTH_SCOPE);
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  })
);

router.get(
  '/google/callback',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { code, state } = req.query;
    const plan = req.session.googleAuthPlan;
    delete req.session.googleAuthPlan;
    const invite = req.session.googleAuthInvite;
    delete req.session.googleAuthInvite;
    if (!code || !state || state !== req.session.googleAuthState) {
      return res.status(400).send('Invalid or expired sign-in attempt. Please try again.');
    }
    delete req.session.googleAuthState;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: googleRedirectUri(),
        grant_type: 'authorization_code',
        code: String(code),
      }),
    });
    const token = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !token.access_token) {
      return res.status(502).send('Failed to complete sign-in with Google.');
    }

    const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const profile = await profileRes.json().catch(() => ({}));
    if (!profile.sub || !profile.email) {
      return res.status(502).send('Google did not return a usable account profile.');
    }
    if (profile.email_verified === false) {
      return res.status(400).send("That Google account's email address is not verified.");
    }

    const googleId = profile.sub;
    const email = String(profile.email).toLowerCase();

    // Match an existing account by google_id first, then fall back to matching by email —
    // that links this Google sign-in to a pre-existing password account instead of creating a
    // duplicate — and only create a new row if neither matched.
    let result = await pool.query('SELECT id, email, suspended_at FROM users WHERE google_id = $1', [googleId]);
    let isNewUser = false;

    if (result.rows.length === 0) {
      const byEmail = await pool.query('SELECT id, email, google_id, suspended_at FROM users WHERE email = $1', [email]);
      if (byEmail.rows.length > 0) {
        if (!byEmail.rows[0].google_id) {
          await pool.query('UPDATE users SET google_id = $1 WHERE id = $2', [googleId, byEmail.rows[0].id]);
        }
        result = byEmail;
      } else {
        // A brand-new account: subject to the admin's sign-up setting, like email signup.
        const gate = await signupGate(invite);
        if (!gate.ok) return res.redirect(`/signup?error=${gate.error}`);
        // Google already verified this email, so there's no point making them click a
        // verification link we'd send ourselves — mark it verified immediately.
        const created = await createUserThroughGate(gate, async (client) => {
          const { rows } = await client.query(
            `INSERT INTO users (email, google_id, password_hash, email_verified_at)
             VALUES ($1, $2, NULL, now())
             RETURNING id, email`,
            [email, googleId]
          );
          return rows[0];
        });
        if (!created) return res.redirect('/signup?error=invite_invalid');
        result = { rows: [created] };
        isNewUser = true;
      }
    }

    const user = result.rows[0];
    if (user.suspended_at) {
      return res.status(403).send('This account is suspended. Contact the site admin.');
    }

    req.login({ id: user.id, email: user.email }, async (err) => {
      if (err) {
        req.log.error({ err }, 'failed to establish session after Google sign-in');
        return res.status(500).send('Signed in with Google, but starting your session failed. Please try again.');
      }
      await logAuthEvent(req, isNewUser ? 'signup' : 'login_success', {
        userId: user.id,
        email: user.email,
      }).catch((logErr) => req.log.error({ err: logErr }, 'failed to record auth event'));

      if (isNewUser) {
        // Same as email signup: a picked plan goes on to Checkout, otherwise into the app (free plan).
        return res.redirect(plan ? `/pricing?start=${encodeURIComponent(plan)}` : '/dashboard');
      }
      res.redirect('/dashboard');
    });
  })
);

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
      await sendMail({ to: email, subject: 'Reset your Postfalcon password', text: `Reset your password: ${resetUrl}` });
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
    await sendMail({ to: req.user.email, subject: 'Verify your Postfalcon email', text: `Verify your email: ${verifyUrl}` });
    res.status(204).end();
  })
);

// currentPassword is optional because a Google-only account (no password_hash yet) has
// nothing to verify against — this doubles as "set a password" for that case, so a Google
// sign-in also has a fallback way in if they ever lose access to that Google account.
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).optional(),
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
    const existingHash = result.rows[0].password_hash;
    if (existingHash && !(currentPassword && (await bcrypt.compare(currentPassword, existingHash)))) {
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
      subject: 'Your Postfalcon password was changed',
      text: "Your account password was just changed. If this wasn't you, reset your password immediately.",
    });

    await logAuthEvent(req, 'password_change', { userId: req.user.id, email: req.user.email }).catch((logErr) =>
      req.log.error({ err: logErr }, 'failed to record auth event')
    );

    res.status(204).end();
  })
);

// password is optional for the same reason as /change-password above — a Google-only account
// has none to check, so the active authenticated session is the only factor available there.
const deleteAccountSchema = z.object({ password: z.string().min(1).optional() });

router.post(
  '/delete-account',
  requireAuth,
  authLimiter,
  validate(deleteAccountSchema),
  asyncHandler(async (req, res) => {
    const { password } = req.body;
    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const existingHash = result.rows[0].password_hash;
    if (existingHash && !(password && (await bcrypt.compare(password, existingHash)))) {
      return res.status(401).json({ error: 'password is incorrect' });
    }

    // Stops billing first, and keeps the account if Stripe can't be reached (lib/accounts.js).
    let email;
    try {
      email = await deleteUserAccount(req.user.id, {
        log: req.log,
        // Logged before the DELETE: user_id has a real FK to users, so the event row must be
        // inserted while the account still exists (it's kept afterwards via ON DELETE SET NULL).
        beforeDelete: (deletedEmail) =>
          logAuthEvent(req, 'account_deleted', { userId: req.user.id, email: deletedEmail }).catch((logErr) =>
            req.log.error({ err: logErr }, 'failed to record auth event')
          ),
      });
    } catch (err) {
      if (!(err instanceof BillingUnavailableError)) throw err;
      return res.status(503).json({
        error: 'billing_unavailable',
        message: "We couldn't cancel your subscription just now, so your account wasn't deleted. Please try again in a few minutes.",
      });
    }

    await sendMail({
      to: email,
      subject: 'Your Postfalcon account was deleted',
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
