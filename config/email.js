/**
 * Email transporter using Resend HTTP API
 * Works everywhere (Railway, local, etc) - no SMTP needed
 * 
 * Required env var: RESEND_API_KEY
 */

class ResendTransporter {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.resend.com';
  }
  
  async sendMail({ from, to, subject, text, html }) {
    const response = await fetch(`${this.baseUrl}/emails`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: Array.isArray(to) ? to : [to],
        subject,
        text,
        html
      })
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Unknown error' }));
      throw new Error(`Resend API error: ${error.message || response.statusText}`);
    }
    
    return response.json();
  }
  
  async verify() {
    const response = await fetch(`${this.baseUrl}/domains`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });
    if (!response.ok) throw new Error('Invalid Resend API key');
    return true;
  }
  
  close() {
    // No-op for HTTP client
  }
}

function createTransport() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('Missing RESEND_API_KEY environment variable');
  }
  return new ResendTransporter(apiKey);
}

function buildResetEmail({ to, resetUrl }) {
  const from = process.env.EMAIL_FROM || 'support@precisiontrader.tech';
  const subject = 'Reset your PrecisionTrader password';
  const text = `We received a request to reset your PrecisionTrader password.\n\nUse this link within 15 minutes:\n${resetUrl}\n\nIf you did not request this, you can safely ignore this email.`;
  const html = `
  <div style="background:#111827;padding:32px;margin:0;width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e6edf3">
    <div style="max-width:560px;margin:0 auto;background:#151c2b;border-radius:12px;overflow:hidden">
      <div style="padding:20px 24px;border-bottom:1px solid #1f2937">
        <div style="font-weight:600;color:#e6edf3;font-size:18px">PrecisionTrader</div>
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
  // Admin email - defaults to support@precisiontrader.tech, can be overridden with ADMIN_EMAIL env var
  const adminEmail = process.env.ADMIN_EMAIL || 'support@precisiontrader.tech';
  const from = process.env.EMAIL_FROM || 'support@precisiontrader.tech';
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
Submitted via PrecisionTrader Contact Form
  `.trim();

  const html = `
  <div style="background:#111827;padding:32px;margin:0;width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e6edf3">
    <div style="max-width:560px;margin:0 auto;background:#151c2b;border-radius:12px;overflow:hidden">
      <div style="padding:20px 24px;border-bottom:1px solid #1f2937">
        <div style="font-weight:600;color:#e6edf3;font-size:18px">PrecisionTrader Admin</div>
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
        Submitted via PrecisionTrader Contact Form
      </div>
    </div>
  </div>`;

  return { from, to: adminEmail, subject: emailSubject, text, html };
}

function buildContactConfirmationEmail({ to, subject, isBetaRequest }) {
  const from = process.env.EMAIL_FROM || 'support@precisiontrader.tech';
  const emailSubject = isBetaRequest ? 'Your Beta Access Request - PrecisionTrader' : 'We received your message - PrecisionTrader';
  
  const text = isBetaRequest ? `
Thank you for your interest in PrecisionTrader!

We've received your beta access request and will review it shortly. If approved, we'll send you a referral code via email that grants you free access during the beta period.

What happens next:
- We typically review requests within 24-48 hours
- If approved, you'll receive a referral code via email
- Use the code when registering or in your account settings

Questions? Just reply to this email.

Best regards,
The PrecisionTrader Team
  `.trim() : `
Thank you for contacting PrecisionTrader!

We've received your message and will get back to you as soon as possible. We typically respond within 24 hours.

Subject: ${subject}

Questions? Just reply to this email.

Best regards,
The PrecisionTrader Team
  `.trim();

  const html = isBetaRequest ? `
  <div style="background:#111827;padding:32px;margin:0;width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e6edf3">
    <div style="max-width:560px;margin:0 auto;background:#151c2b;border-radius:12px;overflow:hidden">
      <div style="padding:20px 24px;border-bottom:1px solid #1f2937">
        <div style="font-weight:600;color:#e6edf3;font-size:18px">PrecisionTrader</div>
      </div>
      <div style="padding:24px">
        <h2 style="margin:0 0 8px 0;color:#e6edf3;font-size:20px">🚀 Beta Request Received!</h2>
        <p style="margin:0 0 16px 0;color:#c7d2fe;line-height:1.6">
          Thank you for your interest in PrecisionTrader! We've received your beta access request and will review it shortly.
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
        Best regards,<br>The PrecisionTrader Team
      </div>
    </div>
  </div>` : `
  <div style="background:#111827;padding:32px;margin:0;width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e6edf3">
    <div style="max-width:560px;margin:0 auto;background:#151c2b;border-radius:12px;overflow:hidden">
      <div style="padding:20px 24px;border-bottom:1px solid #1f2937">
        <div style="font-weight:600;color:#e6edf3;font-size:18px">PrecisionTrader</div>
      </div>
      <div style="padding:24px">
        <h2 style="margin:0 0 8px 0;color:#e6edf3;font-size:20px">Message Received</h2>
        <p style="margin:0 0 16px 0;color:#c7d2fe;line-height:1.6">
          Thank you for contacting PrecisionTrader! We've received your message and will get back to you as soon as possible.
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
        Best regards,<br>The PrecisionTrader Team
      </div>
    </div>
  </div>`;

  return { from, to, subject: emailSubject, text, html };
}

function buildBugReportNotificationEmail({ email, subject, description, userId, stateSnapshot, reportId }) {
  const adminEmail = process.env.ADMIN_EMAIL || 'support@precisiontrader.tech';
  const from = process.env.EMAIL_FROM || 'support@precisiontrader.tech';
  const emailSubject = `🐛 Bug Report: ${subject}`;
  const adminUrl = 'https://precisiontrader.tech';
  const reportUrl = `${adminUrl}/admin/bug-reports/${reportId}`;
  
  const stateSnapshotPreview = stateSnapshot 
    ? JSON.stringify(stateSnapshot, null, 2).substring(0, 500) + '...'
    : 'No state snapshot provided';
  
  const text = `
New Bug Report

From: ${email}
User ID: ${userId || 'Not logged in'}
Subject: ${subject}

Description:
${description}

View Full Report: ${reportUrl}

State Snapshot Preview:
${stateSnapshotPreview}

---
Submitted via PrecisionTrader State Inspector
  `.trim();

  const html = `
  <div style="background:#111827;padding:32px;margin:0;width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e6edf3">
    <div style="max-width:560px;margin:0 auto;background:#151c2b;border-radius:12px;overflow:hidden">
      <div style="padding:20px 24px;border-bottom:1px solid #1f2937">
        <div style="font-weight:600;color:#e6edf3;font-size:18px">PrecisionTrader Admin</div>
      </div>
      <div style="padding:24px">
        <h2 style="margin:0 0 16px 0;color:#e6edf3;font-size:20px">
          🐛 New Bug Report
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

        <div style="background:#1f2937;border-radius:8px;padding:16px;margin-bottom:16px">
          <div style="color:#9ca3af;font-size:12px;margin-bottom:8px">Description</div>
          <div style="color:#e6edf3;line-height:1.6;white-space:pre-wrap">${description}</div>
        </div>

        <div style="margin-bottom:16px">
          <a href="${reportUrl}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600;font-size:14px">View Full Report in Admin</a>
        </div>

        ${stateSnapshot ? `
        <div style="background:#1f2937;border-radius:8px;padding:16px">
          <div style="color:#9ca3af;font-size:12px;margin-bottom:8px">State Snapshot (preview)</div>
          <div style="color:#e6edf3;font-family:monospace;font-size:11px;line-height:1.4;max-height:200px;overflow:auto;white-space:pre-wrap">${stateSnapshotPreview}</div>
          <div style="color:#9ca3af;font-size:11px;margin-top:8px">Click the button above to view full state snapshot and debugging tools</div>
        </div>
        ` : ''}
      </div>
      <div style="padding:16px 24px;background:#1f2937;color:#9ca3af;font-size:12px;text-align:center">
        Submitted via PrecisionTrader State Inspector
      </div>
    </div>
  </div>`;

  return { from, to: adminEmail, subject: emailSubject, text, html };
}

function buildBugReportConfirmationEmail({ to, subject }) {
  const from = process.env.EMAIL_FROM || 'support@precisiontrader.tech';
  const emailSubject = 'Bug Report Received - PrecisionTrader';
  
  const text = `
Thank you for reporting a bug!

We've received your bug report and our team will investigate it as soon as possible.

Subject: ${subject}

We typically review bug reports within 24-48 hours and will reach out if we need any additional information.

Questions? Just reply to this email.

Best regards,
The PrecisionTrader Team
  `.trim();

  const html = `
  <div style="background:#111827;padding:32px;margin:0;width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e6edf3">
    <div style="max-width:560px;margin:0 auto;background:#151c2b;border-radius:12px;overflow:hidden">
      <div style="padding:20px 24px;border-bottom:1px solid #1f2937">
        <div style="font-weight:600;color:#e6edf3;font-size:18px">PrecisionTrader</div>
      </div>
      <div style="padding:24px">
        <h2 style="margin:0 0 8px 0;color:#e6edf3;font-size:20px">🐛 Bug Report Received</h2>
        <p style="margin:0 0 16px 0;color:#c7d2fe;line-height:1.6">
          Thank you for reporting a bug! We've received your report and our team will investigate it as soon as possible.
        </p>
        
        <div style="background:#1f2937;border-radius:8px;padding:16px;margin-bottom:16px">
          <div style="color:#9ca3af;font-size:12px;margin-bottom:4px">Your Subject</div>
          <div style="color:#e6edf3;font-weight:600">${subject}</div>
        </div>

        <p style="margin:0 0 8px 0;color:#9ca3af;font-size:14px">
          We typically review bug reports within <strong style="color:#c7d2fe">24-48 hours</strong> and will reach out if we need any additional information.
        </p>
        
        <p style="margin:16px 0 0 0;color:#9ca3af;font-size:14px;line-height:1.6">
          Questions in the meantime? Just reply to this email.
        </p>
      </div>
      <div style="padding:16px 24px;background:#1f2937;color:#9ca3af;font-size:12px;text-align:center">
        Best regards,<br>The PrecisionTrader Team
      </div>
    </div>
  </div>`;

  return { from, to, subject: emailSubject, text, html };
}

/**
 * Build price alert notification email
 */
function buildPriceAlertEmail({ to, ticker, alertType, priceLevel, triggeredAt, description }) {
  const from = process.env.EMAIL_FROM || 'alerts@precisiontrader.tech';
  const frontendUrl = 'https://precisiontrader.tech';
  const direction = alertType === 'above' || alertType === 'cross_above' ? 'crossed above' : 'crossed below';
  const emailSubject = `🚨 Price Alert: ${ticker} ${direction} $${parseFloat(priceLevel).toFixed(2)}`;
  
  const formattedTime = new Date(triggeredAt).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  });

  const text = `
Price Alert Triggered!

${ticker} ${direction} your target price of $${parseFloat(priceLevel).toFixed(2)}

Triggered At: ${formattedTime}
${description ? `Note: ${description}` : ''}

---
This alert has been deactivated. Log in to PrecisionTrader to re-enable it or create new alerts.

PrecisionTrader - Trade Smarter
  `.trim();

  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="dark">
    <meta name="supported-color-schemes" content="dark">
  </head>
  <body style="margin:0;padding:0;background-color:#111827;color:#e6edf3;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#111827;padding:32px 16px;">
      <tr>
        <td align="center">
          <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#151c2b;border-radius:12px;overflow:hidden;">
            <!-- Header -->
            <tr>
              <td style="padding:20px 24px;border-bottom:1px solid #1f2937;background-color:#151c2b;">
                <div style="font-weight:600;color:#e6edf3;font-size:18px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">🚨 PrecisionTrader Alerts</div>
              </td>
            </tr>
            <!-- Content -->
            <tr>
              <td style="padding:24px;background-color:#151c2b;">
                <table width="100%" cellpadding="0" cellspacing="0" border="0">
                  <!-- Alert Icon & Ticker -->
                  <tr>
                    <td align="center" style="padding-bottom:20px;">
                      <h2 style="margin:0;color:#e6edf3;font-size:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${ticker}</h2>
                      <p style="margin:8px 0 0 0;color:${alertType === 'above' || alertType === 'cross_above' ? '#48BB78' : '#F56565'};font-size:16px;font-weight:600;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                        ${direction} $${parseFloat(priceLevel).toFixed(2)}
                      </p>
                    </td>
                  </tr>
                  <!-- Alert Details -->
                  <tr>
                    <td style="background-color:#1f2937;border-radius:8px;padding:16px;margin-bottom:16px;">
                      <table width="100%" cellpadding="0" cellspacing="0" border="0">
                        <tr>
                          <td style="color:#9ca3af;font-size:14px;padding-bottom:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Alert Price</td>
                          <td align="right" style="color:#e6edf3;font-weight:600;font-size:18px;padding-bottom:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">$${parseFloat(priceLevel).toFixed(2)}</td>
                        </tr>
                        <tr>
                          <td style="color:#9ca3af;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Triggered At</td>
                          <td align="right" style="color:#e6edf3;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${formattedTime}</td>
                        </tr>
                        ${description ? `
                        <tr>
                          <td colspan="2" style="padding-top:12px;border-top:1px solid #374151;">
                            <span style="color:#9ca3af;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Note: </span>
                            <span style="color:#e6edf3;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${description}</span>
                          </td>
                        </tr>
                        ` : ''}
                      </table>
                    </td>
                  </tr>
                  <!-- Button -->
                  <tr>
                    <td align="center" style="padding-top:20px;">
                      <a href="${frontendUrl}" style="display:inline-block;background-color:#3b82f6;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Open PrecisionTrader</a>
                    </td>
                  </tr>
                  <!-- Footer Text -->
                  <tr>
                    <td align="center" style="padding-top:20px;">
                      <p style="margin:0;color:#9ca3af;font-size:12px;line-height:1.5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                        This alert has been deactivated. Log in to re-enable it or create new alerts.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>`;

  return { from, to, subject: emailSubject, text, html };
}

/**
 * Build position loss alert notification email
 */
function buildPositionLossEmail({ to, symbol, accountId, thresholdAmount, lossAmount, positionSnapshot, detectedAt }) {
  const from = process.env.EMAIL_FROM || 'alerts@precisiontrader.tech';
  const frontendUrl = 'https://precisiontrader.tech';
  const emailSubject = `⚠️ Position Loss Alert: ${symbol} exceeds position loss limit`;
  
  const formattedTime = new Date(detectedAt).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  });

  const quantity = positionSnapshot?.Quantity || 0;
  const avgPrice = positionSnapshot?.AveragePrice || 0;

  const text = `
Position Loss Alert

Your ${symbol} position has exceeded your position loss limit.

Account: ${accountId}
Symbol: ${symbol}
Position: ${quantity} shares @ $${parseFloat(avgPrice).toFixed(2)} avg
Your Limit: $${parseFloat(thresholdAmount).toFixed(2)}
Current Loss: $${parseFloat(lossAmount).toFixed(2)}

Detected At: ${formattedTime}

Consider closing this position to limit further losses.

---
This is a suggestion only. You can continue trading.

PrecisionTrader - Trade Smarter
  `.trim();

  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="dark">
    <meta name="supported-color-schemes" content="dark">
  </head>
  <body style="margin:0;padding:0;background-color:#111827;color:#e6edf3;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#111827;padding:32px 16px;">
      <tr>
        <td align="center">
          <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#151c2b;border-radius:12px;overflow:hidden;">
            <!-- Header -->
            <tr>
              <td style="padding:20px 24px;border-bottom:1px solid #1f2937;background-color:#151c2b;">
                <div style="font-weight:600;color:#e6edf3;font-size:18px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">⚠️ PrecisionTrader Alerts</div>
              </td>
            </tr>
            <!-- Content -->
            <tr>
              <td style="padding:24px;background-color:#151c2b;">
                <table width="100%" cellpadding="0" cellspacing="0" border="0">
                  <!-- Alert Icon & Symbol -->
                  <tr>
                    <td align="center" style="padding-bottom:20px;">
                      <h2 style="margin:0;color:#e6edf3;font-size:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${symbol}</h2>
                      <p style="margin:8px 0 0 0;color:#F56565;font-size:16px;font-weight:600;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                        Position Loss Limit Exceeded
                      </p>
                    </td>
                  </tr>
                  <!-- Position Details -->
                  <tr>
                    <td style="background-color:#1f2937;border-radius:8px;padding:16px;margin-bottom:16px;">
                      <table width="100%" cellpadding="0" cellspacing="0" border="0">
                        <tr>
                          <td style="color:#9ca3af;font-size:14px;padding-bottom:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Account</td>
                          <td align="right" style="color:#e6edf3;font-size:14px;padding-bottom:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${accountId}</td>
                        </tr>
                        <tr>
                          <td style="color:#9ca3af;font-size:14px;padding-bottom:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Position</td>
                          <td align="right" style="color:#e6edf3;font-size:14px;padding-bottom:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${quantity} shares @ $${parseFloat(avgPrice).toFixed(2)}</td>
                        </tr>
                        <tr>
                          <td style="color:#9ca3af;font-size:14px;padding-bottom:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Your Limit</td>
                          <td align="right" style="color:#e6edf3;font-weight:600;font-size:14px;padding-bottom:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">$${parseFloat(thresholdAmount).toFixed(2)}</td>
                        </tr>
                        <tr>
                          <td style="color:#9ca3af;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Current Loss</td>
                          <td align="right" style="color:#F56565;font-weight:600;font-size:18px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">$${parseFloat(lossAmount).toFixed(2)}</td>
                        </tr>
                        <tr>
                          <td colspan="2" style="padding-top:12px;border-top:1px solid #374151;">
                            <table width="100%" cellpadding="0" cellspacing="0" border="0">
                              <tr>
                                <td style="color:#9ca3af;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Detected At</td>
                                <td align="right" style="color:#e6edf3;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${formattedTime}</td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <!-- Warning Message -->
                  <tr>
                    <td style="padding-bottom:16px;">
                      <div style="background-color:rgba(245,101,101,0.1);border:1px solid rgba(245,101,101,0.3);border-radius:8px;padding:12px;">
                        <p style="margin:0;color:#F56565;font-size:14px;line-height:1.5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                          ⚠️ Your position has exceeded your position loss limit. Consider closing this position to limit further losses.
                        </p>
                      </div>
                    </td>
                  </tr>
                  <!-- Button -->
                  <tr>
                    <td align="center" style="padding-top:20px;">
                      <a href="${frontendUrl}" style="display:inline-block;background-color:#3b82f6;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Open PrecisionTrader</a>
                    </td>
                  </tr>
                  <!-- Footer Text -->
                  <tr>
                    <td align="center" style="padding-top:20px;">
                      <p style="margin:0;color:#9ca3af;font-size:12px;line-height:1.5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                        This is a suggestion only. You can continue trading.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>`;

  return { from, to, subject: emailSubject, text, html };
}

/**
 * Build beta welcome email
 */
function buildBetaWelcomeEmail({ to, betaCode }) {
  const from = process.env.EMAIL_FROM || 'support@precisiontrader.tech';
  const frontendUrl = 'https://precisiontrader.tech';
  const emailSubject = '🚀 Welcome to PrecisionTrader Beta';
  
  const text = `
Welcome to PrecisionTrader Beta!

You're one of a select group of traders testing our platform before we launch publicly. Your feedback over the next 30 days will directly shape what we build next.

Your Beta Code: ${betaCode}

Register at ${frontendUrl}/register and include the beta code, or add it at ${frontendUrl}/apply-referral-code if you already have an account.

What You're Getting:
• 30 days of completely free access
• All features included
• No credit card required

Important: You're Testing Software
PrecisionTrader is in beta. Bugs might exist. We recommend starting with paper trading to test the workflow. You're welcome to go live when ready.

Your Mission: 30 Days of Real Testing
• Place at least 5-10 trades using PrecisionTrader
• Use bracket orders, position sizing, and daily loss limits
• Complete 2-3 journal entries after trades close
• Try the liquidity overlay if you trade equities

Report Bugs & Feedback:
Email: support@precisiontrader.tech
Subject: "BUG: [what happened]" or "FEEDBACK: [your idea]"

Your Reward:
Complete our brief survey at the end of your 30-day trial and get 1 free month when we launch.

Need Help?
• Sign up for TradeStation if you don't have an account
• Link your account on the Trade page

Most traders use the same platform everyone else uses. You're trying something new because you believe better execution matters.

Let's make something great.

— The PrecisionTrader Team

Questions? Just reply to this email.
  `.trim();

  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="dark">
    <meta name="supported-color-schemes" content="dark">
  </head>
  <body style="margin:0;padding:0;background-color:#111827;color:#e6edf3;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#111827;padding:32px 16px;">
      <tr>
        <td align="center">
          <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#151c2b;border-radius:12px;overflow:hidden;">
            <!-- Header -->
            <tr>
              <td style="padding:20px 24px;border-bottom:1px solid #1f2937;background-color:#151c2b;">
                <div style="font-weight:600;color:#e6edf3;font-size:18px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">🚀 PrecisionTrader Beta</div>
              </td>
            </tr>
            <!-- Content -->
            <tr>
              <td style="padding:24px;background-color:#151c2b;">
                <table width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding-bottom:20px;">
                      <h2 style="margin:0 0 12px 0;color:#e6edf3;font-size:22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Welcome to the Beta!</h2>
                      <p style="margin:0;color:#c7d2fe;font-size:15px;line-height:1.5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                        You're one of a select group testing our platform. Your feedback will directly shape what we build next.
                      </p>
                    </td>
                  </tr>
                  
                  <!-- Beta Code Box -->
                  <tr>
                    <td style="padding-bottom:20px;">
                      <div style="background-color:#1f2937;border-radius:8px;padding:20px;text-align:center;border:2px solid #3b82f6;">
                        <div style="color:#9ca3af;font-size:13px;margin-bottom:8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Your Beta Code</div>
                        <div style="color:#60a5fa;font-size:32px;font-weight:700;letter-spacing:4px;font-family:monospace;">${betaCode}</div>
                      </div>
                    </td>
                  </tr>

                  <!-- CTA Button -->
                  <tr>
                    <td align="center" style="padding-bottom:24px;">
                      <a href="${frontendUrl}/register" style="display:inline-block;background-color:#3b82f6;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;font-size:15px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Register Now</a>
                    </td>
                  </tr>

                  <tr>
                    <td style="padding-bottom:16px;">
                      <p style="margin:0 0 4px 0;color:#9ca3af;font-size:13px;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                        Already have an account? <a href="${frontendUrl}/apply-referral-code" style="color:#60a5fa;text-decoration:none;">Add your code here</a>
                      </p>
                    </td>
                  </tr>

                  <!-- What You Get -->
                  <tr>
                    <td style="background-color:#1f2937;border-radius:8px;padding:16px;margin-bottom:16px;">
                      <div style="color:#e6edf3;font-size:15px;font-weight:600;margin-bottom:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">What You're Getting</div>
                      <ul style="margin:0;padding-left:20px;color:#cbd5e1;line-height:1.7;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                        <li>30 days free access, all features</li>
                        <li>No credit card required</li>
                        <li>1 free month reward for completing feedback survey</li>
                      </ul>
                    </td>
                  </tr>

                  <!-- Your Mission -->
                  <tr>
                    <td style="background-color:#1f2937;border-radius:8px;padding:16px;margin-top:16px;">
                      <div style="color:#e6edf3;font-size:15px;font-weight:600;margin-bottom:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Your 30-Day Mission</div>
                      <ul style="margin:0;padding-left:20px;color:#cbd5e1;line-height:1.7;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                        <li>Place 5-10 trades (paper or live—your choice)</li>
                        <li>Use bracket orders & position sizing</li>
                        <li>Complete 2-3 journal entries</li>
                        <li>Report bugs & share feedback</li>
                      </ul>
                    </td>
                  </tr>

                  <!-- Important Note -->
                  <tr>
                    <td style="padding-top:20px;">
                      <div style="background-color:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);border-radius:8px;padding:12px;">
                        <p style="margin:0;color:#fbbf24;font-size:13px;line-height:1.5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                          ⚠️ <strong>Important:</strong> PrecisionTrader is in beta. We recommend starting with paper trading to test the workflow. You're welcome to go live when ready.
                        </p>
                      </div>
                    </td>
                  </tr>

                  <!-- Support -->
                  <tr>
                    <td style="padding-top:20px;text-align:center;">
                      <p style="margin:0;color:#9ca3af;font-size:13px;line-height:1.6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                        Report bugs: <a href="mailto:support@precisiontrader.tech" style="color:#60a5fa;text-decoration:none;">support@precisiontrader.tech</a><br>
                        Use "BUG: [issue]" or "FEEDBACK: [idea]" in subject
                      </p>
                    </td>
                  </tr>

                  <!-- Closing -->
                  <tr>
                    <td style="padding-top:24px;border-top:1px solid #374151;">
                      <p style="margin:0;color:#cbd5e1;font-size:14px;line-height:1.6;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                        Most traders use the same platform everyone else uses.<br>You're trying something new because you believe better execution matters.
                      </p>
                      <p style="margin:8px 0 0 0;color:#cbd5e1;font-size:14px;line-height:1.6;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                        Let's make something great.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <!-- Footer -->
            <tr>
              <td style="padding:16px 24px;background-color:#1f2937;text-align:center;">
                <p style="margin:0;color:#9ca3af;font-size:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                  Questions? Just reply to this email.<br>
                  — The PrecisionTrader Team
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>`;

  return { from, to, subject: emailSubject, text, html };
}

/**
 * Build email verification code email
 */
function buildVerificationCodeEmail({ to, code }) {
  const from = process.env.EMAIL_FROM || 'support@precisiontrader.tech';
  const emailSubject = 'Verify your email - PrecisionTrader';
  
  const text = `
Welcome to PrecisionTrader!

Please verify your email address by entering this code:

${code}

This code will expire in 15 minutes.

If you didn't create an account, you can safely ignore this email.

Best regards,
The PrecisionTrader Team
  `.trim();

  const html = `
  <div style="background:#111827;padding:32px;margin:0;width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e6edf3">
    <div style="max-width:560px;margin:0 auto;background:#151c2b;border-radius:12px;overflow:hidden">
      <div style="padding:20px 24px;border-bottom:1px solid #1f2937">
        <div style="font-weight:600;color:#e6edf3;font-size:18px">PrecisionTrader</div>
      </div>
      <div style="padding:24px">
        <h2 style="margin:0 0 8px 0;color:#e6edf3;font-size:20px">Verify your email</h2>
        <p style="margin:0 0 20px 0;color:#c7d2fe;line-height:1.5">Welcome to PrecisionTrader! Please enter this verification code to complete your registration:</p>
        
        <div style="background:linear-gradient(135deg, rgba(139, 92, 246, 0.1) 0%, rgba(124, 58, 237, 0.1) 100%);border:2px solid rgba(139, 92, 246, 0.3);border-radius:12px;padding:24px;text-align:center;margin:20px 0">
          <div style="color:#9ca3af;font-size:13px;margin-bottom:8px;text-transform:uppercase;letter-spacing:1px">Your Verification Code</div>
          <div style="color:#8B5CF6;font-size:42px;font-weight:700;letter-spacing:8px;font-family:monospace">${code}</div>
        </div>
        
        <p style="margin:16px 0 0 0;color:#9ca3af;font-size:13px;text-align:center">This code expires in <strong style="color:#c7d2fe">15 minutes</strong></p>
        <p style="margin:8px 0 0 0;color:#9ca3af;font-size:12px;text-align:center">If you didn't create an account, you can safely ignore this email.</p>
      </div>
    </div>
  </div>`;

  return { from, to, subject: emailSubject, text, html };
}

module.exports = { 
  createTransport, 
  buildResetEmail, 
  buildContactNotificationEmail, 
  buildContactConfirmationEmail,
  buildBugReportNotificationEmail,
  buildBugReportConfirmationEmail,
  buildPriceAlertEmail,
  buildPositionLossEmail,
  buildBetaWelcomeEmail,
  buildVerificationCodeEmail
};


