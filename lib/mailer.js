import dotenv from 'dotenv';
import nodemailer from 'nodemailer';

dotenv.config();

const smtpConfigured = Boolean(
  process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER && process.env.SMTP_PASS
);

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
    console.log(`[mailer] SMTP not configured, logging instead.\nTo: ${to}\nSubject: ${subject}\n\n${text}`);
    return;
  }
  await transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
}
