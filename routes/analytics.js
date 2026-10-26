import { Router } from 'express';
import { logger } from '../lib/logger.js';
import { isConfigured } from '../lib/config.js';

const router = Router();

// Reverse-proxies the self-hosted Umami tracking script and its event-collection endpoint
// through our own origin (see .env's UMAMI_HOST). Two reasons to proxy rather than embed
// Umami's own domain directly:
//   1. It stays inside the strict `script-src 'self'` CSP with zero exceptions — the browser
//      only ever sees same-origin requests.
//   2. Ad blockers and tracker blockers that target known analytics domains/paths don't
//      recognise a request to our own /stats/* route.
// UMAMI_HOST is Umami's address as reached FROM THIS SERVER (typically localhost on the same
// VM) — it never needs to be publicly reachable itself, since the browser never talks to it
// directly. Unset UMAMI_HOST to disable analytics entirely (every /stats/* request 404s and
// partials/analytics.ejs emits no <script> tag).
router.all(
  '*',
  async (req, res) => {
    const umamiHost = process.env.UMAMI_HOST;
    if (!isConfigured(umamiHost)) return res.status(404).end();

    const target = `${umamiHost.replace(/\/$/, '')}${req.url}`;
    try {
      const headers = {
        'User-Agent': req.headers['user-agent'] || '',
        'X-Forwarded-For': req.ip,
      };
      const init = { method: req.method, headers };
      if (!['GET', 'HEAD'].includes(req.method) && Buffer.isBuffer(req.body) && req.body.length > 0) {
        headers['Content-Type'] = req.headers['content-type'] || 'application/json';
        init.body = req.body;
      }

      const upstream = await fetch(target, init);
      const contentType = upstream.headers.get('content-type');
      if (contentType) res.set('Content-Type', contentType);
      res.status(upstream.status).send(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      logger.error({ err }, 'analytics proxy failed');
      res.status(502).end();
    }
  }
);

export default router;
