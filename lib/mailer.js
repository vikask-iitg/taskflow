const nodemailer = require('nodemailer');

// Sends email through the SMTP server configured in .env (SMTP_HOST etc.).
// When SMTP isn't configured, sendMail() returns false so callers can fall back.
let transporter = null;

function mailEnabled() {
  return Boolean(process.env.SMTP_HOST);
}

function getTransporter() {
  if (!mailEnabled()) return null;
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT || 587);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE === 'true' || port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

async function sendMail({ to, subject, text, html }) {
  const t = getTransporter();
  if (!t) return false;
  await t.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text, html });
  return true;
}

module.exports = { sendMail, mailEnabled };
