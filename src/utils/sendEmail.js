import nodemailer from 'nodemailer';

/**
 * Create a transporter. Uses SMTP env vars:
 * - SMTP_HOST (e.g. smtp.gmail.com)
 * - SMTP_PORT (e.g. 587)
 * - SMTP_USER (e.g. your-email@gmail.com)
 * - SMTP_PASS (e.g. Gmail App Password)
 * If not set, returns null and sendVerificationEmail will no-op.
 */
function createTransporter() {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  return nodemailer.createTransport({
    host,
    port: Number(port),
    secure: port === '465',
    auth: { user, pass },
  });
}

/**
 * Send verification email to the user.
 * @param {string} to - Email address
 * @param {string} name - User name
 * @param {string} verificationUrl - Full URL to click (e.g. https://api.example.com/api/auth/verify-email?token=xxx)
 * @returns {Promise<boolean>} - true if sent, false if SMTP not configured or send failed
 */
export async function sendVerificationEmail(to, name, verificationUrl) {
  const transporter = createTransporter();
  if (!transporter) {
    console.warn('Email verification skipped: SMTP not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS)');
    return false;
  }
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject: 'Verify your email — IAS Platform',
      text: `Hi ${name},\n\nPlease verify your email by clicking this link:\n${verificationUrl}\n\nThe link expires in 24 hours.\n\n— IAS Platform`,
      html: `
        <p>Hi ${name},</p>
        <p>Please verify your email by clicking the link below:</p>
        <p><a href="${verificationUrl}">Verify my email</a></p>
        <p>The link expires in 24 hours.</p>
        <p>— IAS Platform</p>
      `,
    });
    return true;
  } catch (err) {
    console.error('Send verification email error:', err.message);
    return false;
  }
}
