import { Router } from 'express';
import { requirePageAuth, requireAdmin } from '../middleware/auth.js';
import { logPageVisit } from '../lib/activityLog.js';

const router = Router();

router.use(async (req, res, next) => {
  try {
    await logPageVisit(req);
  } catch (err) {
    req.log.error({ err }, 'failed to record page visit');
  }
  next();
});

router.get('/login', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/dashboard');
  res.render('login');
});

router.get('/signup', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/dashboard');
  res.render('signup');
});

router.get('/forgot-password', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/dashboard');
  res.render('forgot-password');
});

router.get('/reset-password', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/dashboard');
  res.render('reset-password', { token: req.query.token ?? '' });
});

router.get('/', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/dashboard');
  res.render('landing');
});

router.get('/api-docs', (req, res) => {
  res.render('api-docs');
});

router.get('/dashboard', requirePageAuth, (req, res) => {
  res.render('dashboard', {
    email: req.user.email,
    emailVerified: Boolean(req.user.email_verified_at),
  });
});

router.get('/accounts', requirePageAuth, (req, res) => {
  res.render('accounts', {
    email: req.user.email,
    emailVerified: Boolean(req.user.email_verified_at),
  });
});

router.get('/settings', requirePageAuth, (req, res) => {
  res.render('settings', {
    email: req.user.email,
    emailVerified: Boolean(req.user.email_verified_at),
    createdAt: req.user.created_at,
  });
});

router.get('/admin/activity', requireAdmin, (req, res) => {
  res.render('admin-activity', { email: req.user.email });
});

export default router;
