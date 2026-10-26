// Whether an .env setting is actually filled in. .env.example has shipped values like
// 'change-me', and a .env copied from it unedited must read as "not configured" (self-hosted
// mode, no Google button, no SMTP) rather than as a real key, host or password.
export function isConfigured(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  return v !== '' && !v.includes('change-me');
}

export function envConfigured(name) {
  return isConfigured(process.env[name]);
}

// All four SMTP settings filled in, i.e. lib/mailer.js really sends instead of logging.
export function smtpConfigured() {
  return ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'].every(envConfigured);
}
