import rateLimit from 'express-rate-limit';

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
  skip: () => process.env.NODE_ENV === 'test',
});

// Keyed by user id (not IP) since it runs after requireAuth and many agents/scripts can
// share one IP — an IP-based limit would throttle unrelated users on the same host.
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
  keyGenerator: (req) => String(req.user.id),
  skip: () => process.env.NODE_ENV === 'test',
});
