import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { logPageVisit } from '../lib/activityLog.js';
import { listPosts, paginate, categories, filterByCategory } from '../lib/blog.js';

const router = Router();

router.use(async (req, res, next) => {
  try {
    await logPageVisit(req);
  } catch (err) {
    req.log.error({ err }, 'failed to record page visit');
  }
  next();
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const posts = await listPosts();
    const activeCategory = req.query.category ? String(req.query.category).trim() : null;
    const filtered = filterByCategory(posts, activeCategory);
    const { items, page, totalPages, hasPrev, hasNext } = paginate(filtered, Number.parseInt(req.query.page, 10));
    res.render('blog-index', {
      posts: items,
      page,
      totalPages,
      hasPrev,
      hasNext,
      // Built from the full unfiltered list so every pill stays visible regardless of which
      // category is currently active.
      categories: categories(posts),
      activeCategory,
      loggedIn: req.isAuthenticated(),
    });
  })
);

router.get(
  '/:slug',
  asyncHandler(async (req, res) => {
    const posts = await listPosts({ includeDrafts: true });
    const post = posts.find((p) => p.slug === req.params.slug);
    if (post && !post.draft) {
      return res.render('blog-post', { post, loggedIn: req.isAuthenticated() });
    }

    // The slug used to belong to a post that's since been renamed (see the `redirects`
    // frontmatter field) — send anyone who still has the old URL to the current one.
    const renamed = posts.find((p) => !p.draft && p.redirects.includes(req.params.slug));
    if (renamed) {
      return res.redirect(301, `/blog/${renamed.slug}`);
    }

    res.status(404).render('404');
  })
);

export default router;
