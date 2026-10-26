import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import { logger } from './logger.js';

dotenv.config();

// .env.example ships SMTP_HOST/USER/PASS as 'change-me'; a .env copied from it unedited must
// count as "not configured" (log instead of send), not as an SMTP server named change-me.
const isSet = (value) => Boolean(value) && value !== 'change-me';
const smtpConfigured = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'].every((key) => isSet(process.env[key]));

const transporter = smtpConfigured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

export async function sendMail({ to, subject, text }) {
  if (!transporter) {
    logger.info({ to, subject, text }, '[mailer] SMTP not configured, logging instead');
    return;
  }
  await transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
}

// Admin -> Overview's "Send test email". Unlike sendMail(), it fails loudly when SMTP isn't set
// up, and reports what the server said, so a wrong From address or an unverified domain shows
// up as a readable error instead of emails that silently never arrive.
export async function sendTestMail(to) {
  if (!transporter) {
    throw new Error("Email isn't set up: fill in SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS in .env, then restart.");
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const info = await transporter.sendMail({
    from,
    to,
    subject: 'Test email from Postfalcon',
    text: `This is a test email from ${process.env.BASE_URL}. If you can read it, email is working.`,
  });
  return { from, to, response: info.response ?? null };
}
