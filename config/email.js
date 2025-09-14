const nodemailer = require('nodemailer');

function createTransport() {
  const host = process.env.ZOHO_SMTP_HOST || 'smtp.zoho.com';
  const port = Number(process.env.ZOHO_SMTP_PORT || 465);
  const secure = process.env.ZOHO_SMTP_SECURE ? String(process.env.ZOHO_SMTP_SECURE).toLowerCase() === 'true' : (port === 465);
  const user = process.env.ZOHO_SMTP_USER;
  const pass = process.env.ZOHO_SMTP_PASS;

  if (!user || !pass) {
    throw new Error('Missing Zoho SMTP credentials (ZOHO_SMTP_USER/ZOHO_SMTP_PASS)');
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass }
  });
}

function buildResetEmail({ to, resetUrl }) {
  const from = process.env.EMAIL_FROM || 'support@tradecraftapp.com';
  const subject = 'Reset your TradeCraft password';
  const text = `We received a request to reset your TradeCraft password.\n\nUse this link within 15 minutes:\n${resetUrl}\n\nIf you did not request this, you can safely ignore this email.`;
  const html = `
  <div style="background:#111827;padding:32px;margin:0;width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e6edf3">
    <div style="max-width:560px;margin:0 auto;background:#151c2b;border-radius:12px;overflow:hidden">
      <div style="padding:20px 24px;border-bottom:1px solid #1f2937;display:flex;align-items:center;gap:12px">
        <img src="${process.env.FRONTEND_URL || ''}/images/tradestation-logo.png" alt="TradeCraft" width="28" height="28" style="display:block;border:0;outline:none;text-decoration:none;border-radius:6px"/>
        <div style="font-weight:600;color:#e6edf3">TradeCraft</div>
      </div>
      <div style="padding:24px">
        <h2 style="margin:0 0 8px 0;color:#e6edf3;font-size:20px">Reset your password</h2>
        <p style="margin:0 0 16px 0;color:#c7d2fe;line-height:1.5">We received a request to reset your password. This link will expire in <strong>15 minutes</strong>.</p>
        <a href="${resetUrl}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">Reset Password</a>
        <p style="margin:16px 0 0 0;color:#9ca3af;font-size:12px">If the button doesn’t work, copy and paste this URL in your browser:</p>
        <p style="margin:4px 0 0 0;color:#9ca3af;font-size:12px;word-break:break-all">${resetUrl}</p>
      </div>
    </div>
    <p style="max-width:560px;margin:12px auto 0;color:#94a3b8;font-size:12px;text-align:center">If you didn’t request this, ensure your email account is secure to avoid unauthorized password resets.</p>
  </div>`;
  return { from, to, subject, text, html };
}

module.exports = { createTransport, buildResetEmail };


