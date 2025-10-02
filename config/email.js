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
        <img src="${process.env.FRONTEND_URL || ''}/web-app-manifest-192x192.png" alt="TradeCraft" width="28" height="28" style="display:block;border:0;outline:none;text-decoration:none;border-radius:6px"/>
        <div style="font-weight:600;color:#e6edf3">TradeCraft</div>
      </div>
      <div style="padding:24px">
        <h2 style="margin:0 0 8px 0;color:#e6edf3;font-size:20px">Reset your password</h2>
        <p style="margin:0 0 16px 0;color:#c7d2fe;line-height:1.5">We received a request to reset your password. This link will expire in <strong>15 minutes</strong>.</p>
        <a href="${resetUrl}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">Reset Password</a>
        <p style="margin:16px 0 0 0;color:#9ca3af;font-size:12px">If the button doesn't work, copy and paste this URL in your browser:</p>
        <p style="margin:4px 0 0 0;color:#9ca3af;font-size:12px;word-break:break-all">${resetUrl}</p>
      </div>
    </div>
    <p style="max-width:560px;margin:12px auto 0;color:#94a3b8;font-size:12px;text-align:center">If you didn't request this, ensure your email account is secure to avoid unauthorized password resets.</p>
  </div>`;
  return { from, to, subject, text, html };
}

function buildContactNotificationEmail({ email, subject, message, userId, isBetaRequest }) {
  // Admin email - defaults to support@tradecraftapp.com, can be overridden with ADMIN_EMAIL env var
  const adminEmail = process.env.ADMIN_EMAIL || 'support@tradecraftapp.com';
  const from = process.env.EMAIL_FROM || 'noreply@tradecraftapp.com';
  const emailSubject = isBetaRequest ? '🚀 New Beta Access Request' : `New Contact Form: ${subject}`;
  
  const betaBadge = isBetaRequest ? '<span style="display:inline-block;background:#3b82f6;color:#fff;padding:4px 8px;border-radius:6px;font-size:11px;font-weight:600;margin-left:8px">BETA REQUEST</span>' : '';
  
  const text = `
New ${isBetaRequest ? 'Beta Access Request' : 'Contact Form Submission'}

From: ${email}
User ID: ${userId || 'Not logged in'}
Subject: ${subject}

Message:
${message}

---
Submitted via TradeCraft Contact Form
  `.trim();

  const html = `
  <div style="background:#111827;padding:32px;margin:0;width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e6edf3">
    <div style="max-width:560px;margin:0 auto;background:#151c2b;border-radius:12px;overflow:hidden">
      <div style="padding:20px 24px;border-bottom:1px solid #1f2937;display:flex;align-items:center;gap:12px">
        <img src="${process.env.FRONTEND_URL || ''}/web-app-manifest-192x192.png" alt="TradeCraft" width="28" height="28" style="display:block;border:0;outline:none;text-decoration:none;border-radius:6px"/>
        <div style="font-weight:600;color:#e6edf3">TradeCraft Admin</div>
      </div>
      <div style="padding:24px">
        <h2 style="margin:0 0 16px 0;color:#e6edf3;font-size:20px">
          ${isBetaRequest ? '🚀 Beta Access Request' : '📧 New Contact Form'}
        </h2>
        
        <div style="background:#1f2937;border-radius:8px;padding:16px;margin-bottom:16px">
          <div style="margin-bottom:12px">
            <div style="color:#9ca3af;font-size:12px;margin-bottom:4px">From</div>
            <div style="color:#e6edf3;font-weight:600">${email}</div>
          </div>
          ${userId ? `
          <div style="margin-bottom:12px">
            <div style="color:#9ca3af;font-size:12px;margin-bottom:4px">User ID</div>
            <div style="color:#e6edf3">${userId}</div>
          </div>
          ` : ''}
          <div>
            <div style="color:#9ca3af;font-size:12px;margin-bottom:4px">Subject</div>
            <div style="color:#e6edf3;font-weight:600">${subject}</div>
          </div>
        </div>

        <div style="background:#1f2937;border-radius:8px;padding:16px">
          <div style="color:#9ca3af;font-size:12px;margin-bottom:8px">Message</div>
          <div style="color:#e6edf3;line-height:1.6;white-space:pre-wrap">${message}</div>
        </div>

        ${isBetaRequest ? `
        <div style="margin-top:16px;padding:12px;background:rgba(59,130,246,0.1);border:1px solid rgba(59,130,246,0.3);border-radius:8px">
          <div style="color:#60a5fa;font-size:13px;line-height:1.5">
            💡 <strong>Action Required:</strong> Review this beta request and send a referral code if approved.
          </div>
        </div>
        ` : ''}
      </div>
      <div style="padding:16px 24px;background:#1f2937;color:#9ca3af;font-size:12px;text-align:center">
        Submitted via TradeCraft Contact Form
      </div>
    </div>
  </div>`;

  return { from, to: adminEmail, subject: emailSubject, text, html };
}

function buildContactConfirmationEmail({ to, subject, isBetaRequest }) {
  const from = process.env.EMAIL_FROM || 'support@tradecraftapp.com';
  const emailSubject = isBetaRequest ? 'Your Beta Access Request - TradeCraft' : 'We received your message - TradeCraft';
  
  const text = isBetaRequest ? `
Thank you for your interest in TradeCraft!

We've received your beta access request and will review it shortly. If approved, we'll send you a referral code via email that grants you free access during the beta period.

What happens next:
- We typically review requests within 24-48 hours
- If approved, you'll receive a referral code via email
- Use the code when registering or in your account settings

Questions? Just reply to this email.

Best regards,
The TradeCraft Team
  `.trim() : `
Thank you for contacting TradeCraft!

We've received your message and will get back to you as soon as possible. We typically respond within 24 hours.

Subject: ${subject}

Questions? Just reply to this email.

Best regards,
The TradeCraft Team
  `.trim();

  const html = isBetaRequest ? `
  <div style="background:#111827;padding:32px;margin:0;width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e6edf3">
    <div style="max-width:560px;margin:0 auto;background:#151c2b;border-radius:12px;overflow:hidden">
      <div style="padding:20px 24px;border-bottom:1px solid #1f2937;display:flex;align-items:center;gap:12px">
        <img src="${process.env.FRONTEND_URL || ''}/web-app-manifest-192x192.png" alt="TradeCraft" width="28" height="28" style="display:block;border:0;outline:none;text-decoration:none;border-radius:6px"/>
        <div style="font-weight:600;color:#e6edf3">TradeCraft</div>
      </div>
      <div style="padding:24px">
        <h2 style="margin:0 0 8px 0;color:#e6edf3;font-size:20px">🚀 Beta Request Received!</h2>
        <p style="margin:0 0 16px 0;color:#c7d2fe;line-height:1.6">
          Thank you for your interest in TradeCraft! We've received your beta access request and will review it shortly.
        </p>
        
        <div style="background:#1f2937;border-radius:8px;padding:16px;margin-bottom:16px">
          <div style="color:#9ca3af;font-size:14px;font-weight:600;margin-bottom:8px">What happens next:</div>
          <ul style="margin:0;padding-left:20px;color:#cbd5e1;line-height:1.8">
            <li>We typically review requests within <strong>24-48 hours</strong></li>
            <li>If approved, you'll receive a referral code via email</li>
            <li>Use the code when registering or in your account settings</li>
          </ul>
        </div>

        <p style="margin:16px 0 0 0;color:#9ca3af;font-size:14px;line-height:1.6">
          Questions? Just reply to this email and we'll be happy to help.
        </p>
      </div>
      <div style="padding:16px 24px;background:#1f2937;color:#9ca3af;font-size:12px;text-align:center">
        Best regards,<br>The TradeCraft Team
      </div>
    </div>
  </div>` : `
  <div style="background:#111827;padding:32px;margin:0;width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e6edf3">
    <div style="max-width:560px;margin:0 auto;background:#151c2b;border-radius:12px;overflow:hidden">
      <div style="padding:20px 24px;border-bottom:1px solid #1f2937;display:flex;align-items:center;gap:12px">
        <img src="${process.env.FRONTEND_URL || ''}/web-app-manifest-192x192.png" alt="TradeCraft" width="28" height="28" style="display:block;border:0;outline:none;text-decoration:none;border-radius:6px"/>
        <div style="font-weight:600;color:#e6edf3">TradeCraft</div>
      </div>
      <div style="padding:24px">
        <h2 style="margin:0 0 8px 0;color:#e6edf3;font-size:20px">Message Received</h2>
        <p style="margin:0 0 16px 0;color:#c7d2fe;line-height:1.6">
          Thank you for contacting TradeCraft! We've received your message and will get back to you as soon as possible.
        </p>
        
        <div style="background:#1f2937;border-radius:8px;padding:16px;margin-bottom:16px">
          <div style="color:#9ca3af;font-size:12px;margin-bottom:4px">Your Subject</div>
          <div style="color:#e6edf3;font-weight:600">${subject}</div>
        </div>

        <p style="margin:0 0 8px 0;color:#9ca3af;font-size:14px">
          We typically respond within <strong style="color:#c7d2fe">24 hours</strong>.
        </p>
        
        <p style="margin:16px 0 0 0;color:#9ca3af;font-size:14px;line-height:1.6">
          Questions in the meantime? Just reply to this email.
        </p>
      </div>
      <div style="padding:16px 24px;background:#1f2937;color:#9ca3af;font-size:12px;text-align:center">
        Best regards,<br>The TradeCraft Team
      </div>
    </div>
  </div>`;

  return { from, to, subject: emailSubject, text, html };
}

module.exports = { createTransport, buildResetEmail, buildContactNotificationEmail, buildContactConfirmationEmail };


