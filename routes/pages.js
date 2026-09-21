import { Router } from 'express';
import { requirePageAuth, requireAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { logPageVisit } from '../lib/activityLog.js';
import { connectablePlatforms, livePlatforms } from '../lib/platforms.js';
import { PLANS } from '../lib/billing.js';
import { listPosts, isBlogEnabled } from '../lib/blog.js';

const router = Router();

// The publicly crawlable pages, in the order they should be listed — used by /sitemap.xml.
// '/blog' only when isBlogEnabled() — see that function for why a self-hoster might turn it off.
const STATIC_PAGES = ['/', '/pricing', '/api-docs'];

function xmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

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
  res.render('landing', { livePlatforms: livePlatforms(), plans: PLANS, loggedIn: false });
});

router.get('/api-docs', (req, res) => {
  res.render('api-docs', { loggedIn: req.isAuthenticated() });
});

router.get('/pricing', (req, res) => {
  // Only treat a plan as "current" once the user has actually checked out (has a Stripe
  // customer) — a brand-new account sits on the `standard` default with no subscription and
  // still needs every plan's button to be actionable.
  const hasSubscription = req.isAuthenticated() && Boolean(req.user.stripe_customer_id);
  res.render('pricing', {
    plans: PLANS,
    loggedIn: req.isAuthenticated(),
    currentPlan: hasSubscription ? req.user.plan : null,
  });
});

router.get('/dashboard', requirePageAuth, (req, res) => {
  res.render('dashboard', {
    email: req.user.email,
    emailVerified: Boolean(req.user.email_verified_at),
  });
});

router.get('/analytics', requirePageAuth, (req, res) => {
  res.render('analytics', {
    email: req.user.email,
    emailVerified: Boolean(req.user.email_verified_at),
  });
});

router.get('/accounts', requirePageAuth, (req, res) => {
  res.render('accounts', {
    email: req.user.email,
    emailVerified: Boolean(req.user.email_verified_at),
    platforms: connectablePlatforms(),
  });
});

router.get('/settings', requirePageAuth, (req, res) => {
  res.render('settings', {
    email: req.user.email,
    emailVerified: Boolean(req.user.email_verified_at),
    createdAt: req.user.created_at,
    hasPassword: Boolean(req.user.has_password),
    hasGoogle: Boolean(req.user.has_google),
  });
});

router.get('/admin/activity', requireAdmin, (req, res) => {
  res.render('admin-activity', { email: req.user.email });
});

router.get(
  '/sitemap.xml',
  asyncHandler(async (req, res) => {
    const blogEnabled = isBlogEnabled();
    const posts = blogEnabled ? await listPosts() : [];
    const base = process.env.BASE_URL;
    const urls = [
      ...STATIC_PAGES.map((loc) => ({ loc, lastmod: null })),
      ...(blogEnabled ? [{ loc: '/blog', lastmod: null }] : []),
      ...posts.map((p) => ({ loc: `/blog/${p.slug}`, lastmod: (p.updated || p.date).toISOString().slice(0, 10) })),
    ];
    const body =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      urls
        .map(
          (u) =>
            `  <url><loc>${xmlEscape(base + u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`
        )
        .join('\n') +
      `\n</urlset>\n`;
    res.type('application/xml').send(body);
  })
);

router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    ['User-agent: *', 'Disallow: /dashboard', 'Disallow: /analytics', 'Disallow: /accounts', 'Disallow: /settings', 'Disallow: /admin', '', `Sitemap: ${process.env.BASE_URL}/sitemap.xml`, ''].join(
      '\n'
    )
  );
});

export default router;
