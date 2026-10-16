import pino from 'pino';

// Silenced under test regardless of LOG_LEVEL — same NODE_ENV=test bypass pattern as
// authLimiter/apiLimiter/csrfProtection. Not just noise reduction: pino-http logging every
// request in a suite that now exercises far more endpoints per run pushes stdout write
// volume high enough to trip a real EINTR race in the underlying sonic-boom write stream
// (interrupted write() syscalls under load), which vitest reports as unhandled exceptions
// even though the tests themselves pass.
export const logger = pino({
  level: process.env.NODE_ENV === 'test' ? 'silent' : process.env.LOG_LEVEL || 'info',
  // pino-http logs every request's headers. Without this, session cookies and Bearer API
  // tokens land in plain text in the pm2 logs, where anyone who can read them can hijack
  // the session or call the API as that user.
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'req.headers["x-csrf-token"]',
      'res.headers["set-cookie"]',
    ],
    censor: '[redacted]',
  },
});
