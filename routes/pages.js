import { Router } from 'express';
import { requirePageAuth, requireAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { logPageVisit } from '../lib/activityLog.js';
import { connectablePlatforms, livePlatforms, PLATFORM_IDS, isPlatformOffered } from '../lib/platforms.js';
import { PLANS, isEntitled, selfHosted } from '../lib/billing.js';
import { listPosts } from '../lib/blog.js';
import { signupGate } from '../lib/signups.js';

const router = Router();

// What the in-app pages' trial banner (partials/trial-banner.ejs) should say: null when the
// account can publish, else whether it never finished Checkout ('incomplete', migration 023)
// or had a trial/subscription that lapsed. Mirrors the 402 the API returns (planLimit.js).
function planBanner(user) {
  if (isEntitled(user)) return null;
  return user.plan_status === 'incomplete' ? 'start' : 'lapsed';
}

// The publicly crawlable pages, in the order they should be listed — used by /sitemap.xml.
// '/blog' only while the blog is on (res.locals.blogEnabled: ENABLE_BLOG + the public-website switch).
const STATIC_PAGES = ['/', '/pricing', '/api-docs', '/privacy', '/terms'];

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

router.get(
  '/signup',
  asyncHandler(async (req, res) => {
    if (req.isAuthenticated()) return res.redirect('/dashboard');
    // Sign-ups closed, or invite-only without a usable ?invite=: show why instead of a form
    // that would only be refused (lib/signups.js).
    const invite = typeof req.query.invite === 'string' ? req.query.invite.slice(0, 200) : '';
    const gate = await signupGate(invite || undefined);
    res.render('signup', { signupBlocked: gate.ok ? null : gate.message, invite: gate.ok ? invite : '' });
  })
);

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
  // Public website off (Admin -> Settings; the default when self-hosted): / is just the way in.
  if (!res.locals.publicSite) return res.redirect('/login');
  const platforms = livePlatforms();
  // "Mastodon, Bluesky, …, and Pinterest", from whatever is switched on (admin Platforms page).
  const names = platforms.map((p) => p.label);
  const platformNames = names.length > 1 ? `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}` : names.join('');
  res.render('landing', { livePlatforms: platforms, platformNames, plans: PLANS, loggedIn: false });
});

router.get('/api-docs', (req, res) => {
  res.render('api-docs', { loggedIn: req.isAuthenticated() });
});

router.get('/privacy', (req, res) => {
  res.render('privacy', { loggedIn: req.isAuthenticated() });
});

router.get('/terms', (req, res) => {
  res.render('terms', { loggedIn: req.isAuthenticated() });
});

router.get('/pricing', (req, res) => {
  // Self-hosted mode: no plans to pick, so every "Start free trial" path (including signup's
  // hand-off to /pricing?start=) lands on the app or on signup instead.
  if (selfHosted()) return res.redirect(req.isAuthenticated() ? '/dashboard' : '/signup');
  // Only treat a plan as "current" while the user is actually subscribed. Having a Stripe
  // customer isn't enough: one is created as soon as someone clicks "Start trial", so an
  // abandoned Checkout leaves a customer, the `standard` default and no subscription, and
  // every plan's button must stay actionable. A subscriber changes plan in the billing
  // portal (another Checkout would start a second subscription), so their buttons open it.
  const subscribed = req.isAuthenticated() && Boolean(req.user.stripe_customer_id) && isEntitled(req.user);
  res.render('pricing', {
    plans: PLANS,
    loggedIn: req.isAuthenticated(),
    subscribed,
    currentPlan: subscribed ? req.user.plan : null,
  });
});

router.get('/dashboard', requirePageAuth, (req, res) => {
  res.render('dashboard', {
    email: req.user.email,
    emailVerified: Boolean(req.user.email_verified_at),
    planBanner: planBanner(req.user),
  });
});

router.get('/analytics', requirePageAuth, (req, res) => {
  res.render('analytics', {
    email: req.user.email,
    emailVerified: Boolean(req.user.email_verified_at),
    planBanner: planBanner(req.user),
  });
});

router.get('/accounts', requirePageAuth, (req, res) => {
  res.render('accounts', {
    email: req.user.email,
    emailVerified: Boolean(req.user.email_verified_at),
    planBanner: planBanner(req.user),
    platforms: connectablePlatforms(),
    // For the page's hand-built connect blocks (Mastodon, Facebook/Instagram, Telegram, Bluesky),
    // which aren't driven by `platforms`: each shows only while its platform is switched on.
    enabledIds: PLATFORM_IDS.filter(isPlatformOffered),
  });
});

router.get('/settings', requirePageAuth, (req, res) => {
  res.render('settings', {
    email: req.user.email,
    emailVerified: Boolean(req.user.email_verified_at),
    planBanner: planBanner(req.user),
    createdAt: req.user.created_at,
    hasPassword: Boolean(req.user.has_password),
    hasGoogle: Boolean(req.user.has_google),
  });
});

router.get('/admin', requireAdmin, (req, res) => res.redirect('/admin/overview'));

router.get('/admin/overview', requireAdmin, (req, res) => {
  res.render('admin-overview', { email: req.user.email });
});

router.get('/admin/settings', requireAdmin, (req, res) => {
  res.render('admin-settings', { email: req.user.email });
});

router.get('/admin/platforms', requireAdmin, (req, res) => {
  res.render('admin-platforms', { email: req.user.email });
});

router.get('/admin/customers', requireAdmin, (req, res) => {
  res.render('admin-customers', { email: req.user.email });
});

router.get('/admin/activity', requireAdmin, (req, res) => {
  res.render('admin-activity', { email: req.user.email });
});

router.get(
  '/sitemap.xml',
  asyncHandler(async (req, res) => {
    const blogEnabled = res.locals.blogEnabled;
    const posts = blogEnabled ? await listPosts() : [];
    const pages = res.locals.publicSite ? STATIC_PAGES : STATIC_PAGES.filter((p) => p !== '/' && p !== '/pricing');
    const base = process.env.BASE_URL;
    const urls = [
      ...pages.map((loc) => ({ loc, lastmod: null })),
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

// The short address for the one-line installer (`curl -fsSL <BASE_URL>/install.sh | sh`): the
// script itself lives in the repository; curl -L follows the redirect.
router.get('/install.sh', (req, res) => {
  res.redirect('https://raw.githubusercontent.com/natewhi/postfalcon/main/install.sh');
});

router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    ['User-agent: *', 'Disallow: /dashboard', 'Disallow: /analytics', 'Disallow: /accounts', 'Disallow: /settings', 'Disallow: /admin', '', `Sitemap: ${process.env.BASE_URL}/sitemap.xml`, ''].join(
      '\n'
    )
  );
});

export default router;
