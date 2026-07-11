export function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'not authenticated' });
  }
  next();
}

export function requirePageAuth(req, res, next) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  next();
}
