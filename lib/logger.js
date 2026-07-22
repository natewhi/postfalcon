import pino from 'pino';

// Silenced under test regardless of LOG_LEVEL — same NODE_ENV=test bypass pattern as
// authLimiter/apiLimiter/csrfProtection. Not just noise reduction: pino-http logging every
// request in a suite that now exercises far more endpoints per run pushes stdout write
// volume high enough to trip a real EINTR race in the underlying sonic-boom write stream
// (interrupted write() syscalls under load), which vitest reports as unhandled exceptions
// even though the tests themselves pass.
export const logger = pino({
  level: process.env.NODE_ENV === 'test' ? 'silent' : process.env.LOG_LEVEL || 'info',
});
