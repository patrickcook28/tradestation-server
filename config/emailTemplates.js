const { buildEarlyAccessWelcomeEmail } = require('./email');

/**
 * Email template registry
 * Maps template labels to their builder functions
 */
const EMAIL_TEMPLATES = {
  early_access_onboarding: {
    label: 'early_access_onboarding',
    name: 'Early Access Onboarding',
    description: 'Welcome email sent when a user completes account setup and email verification',
    builder: ({ to }) => {
      const frontendUrl = 'https://precisiontrader.tech';
      const subject = 'Welcome to PrecisionTrader - Early Access';
      
      const text = `
Welcome to PrecisionTrader!

You now have early access to all features. Your account is ready—just link your TradeStation account and start trading.

Get Started:
• Link your TradeStation account on the Trade page
• Start placing bracket orders with our drag-and-drop interface
• Set up position sizing and daily loss limits

What You're Getting:
• Full access to all PrecisionTrader features
• No credit card required
• No surprise charges

We ask one thing: use it on real trades and tell us what you think.

Important: PrecisionTrader is a tool to help you execute with discipline. It doesn't guarantee profits or prevent losses. Your trading decisions are yours alone.

Need Help?
• Don't have a TradeStation account? Sign up here: https://www.tradestation.com/
• Then link it on the Trade page: ${frontendUrl}/trade
• Questions? Just reply to this email

Thank you for being an early adopter. Most traders use the same platform everyone else uses. You're trying something new because you believe better execution matters.

Let's make something great.

— The PrecisionTrader Team

P.S. — Have questions? Hit reply. We read every email.
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
                <div style="font-weight:600;color:#e6edf3;font-size:18px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">PrecisionTrader</div>
              </td>
            </tr>
            <!-- Content -->
            <tr>
              <td style="padding:24px;background-color:#151c2b;">
                <table width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding-bottom:20px;">
                      <h2 style="margin:0 0 12px 0;color:#e6edf3;font-size:22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Welcome to PrecisionTrader!</h2>
                      <p style="margin:0;color:#c7d2fe;font-size:15px;line-height:1.5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                        You now have early access to all features. Your account is ready—just link your TradeStation account and start trading.
                      </p>
                    </td>
                  </tr>
                  
                  <!-- CTA Button -->
                  <tr>
                    <td align="center" style="padding-bottom:24px;">
                      <a href="${frontendUrl}/trade" style="display:inline-block;background-color:#3b82f6;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;font-size:15px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Link TradeStation Account</a>
                    </td>
                  </tr>

                  <!-- Quick Start -->
                  <tr>
                    <td style="background-color:#1f2937;border-radius:8px;padding:16px;margin-bottom:16px;">
                      <div style="color:#e6edf3;font-size:15px;font-weight:600;margin-bottom:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Get Started</div>
                      <ul style="margin:0;padding-left:20px;color:#cbd5e1;line-height:1.7;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                        <li>Link your TradeStation account on the Trade page</li>
                        <li>Start placing bracket orders with drag-and-drop</li>
                        <li>Set up position sizing and daily loss limits</li>
                      </ul>
                    </td>
                  </tr>

                  <!-- What You Get -->
                  <tr>
                    <td style="background-color:#1f2937;border-radius:8px;padding:16px;margin-bottom:16px;">
                      <div style="color:#e6edf3;font-size:15px;font-weight:600;margin-bottom:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">What You're Getting</div>
                      <ul style="margin:0;padding-left:20px;color:#cbd5e1;line-height:1.7;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                        <li>Full access to all PrecisionTrader features</li>
                        <li>No credit card required</li>
                        <li>No surprise charges</li>
                      </ul>
                    </td>
                  </tr>

                  <!-- Important Note -->
                  <tr>
                    <td style="padding-top:16px;padding-bottom:16px;">
                      <div style="background-color:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);border-radius:8px;padding:12px;">
                        <p style="margin:0;color:#fbbf24;font-size:13px;line-height:1.5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                          <strong>Important:</strong> PrecisionTrader is a tool to help you execute with discipline. It doesn't guarantee profits or prevent losses. Your trading decisions are yours alone.
                        </p>
                      </div>
                    </td>
                  </tr>

                  <!-- Need Help -->
                  <tr>
                    <td style="padding-top:16px;">
                      <div style="color:#e6edf3;font-size:15px;font-weight:600;margin-bottom:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Need Help?</div>
                      <p style="margin:0 0 8px 0;color:#cbd5e1;font-size:14px;line-height:1.6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                        Don't have a TradeStation account? <a href="https://www.tradestation.com/" style="color:#60a5fa;text-decoration:none;">Sign up here</a>
                      </p>
                      <p style="margin:0 0 8px 0;color:#cbd5e1;font-size:14px;line-height:1.6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                        Then link it on the <a href="${frontendUrl}/trade" style="color:#60a5fa;text-decoration:none;">Trade page</a>
                      </p>
                      <p style="margin:0;color:#cbd5e1;font-size:14px;line-height:1.6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                        Questions? Just reply to this email.
                      </p>
                    </td>
                  </tr>

                  <!-- Closing -->
                  <tr>
                    <td style="padding-top:24px;border-top:1px solid #374151;">
                      <p style="margin:0;color:#cbd5e1;font-size:14px;line-height:1.6;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                        Thank you for being an early adopter. Most traders use the same platform everyone else uses. You're trying something new because you believe better execution matters.
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
                  — The PrecisionTrader Team<br>
                  <span style="font-size:11px;margin-top:4px;display:block;">P.S. — Have questions? Hit reply. We read every email.</span>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>`;
      
      return {
        from: process.env.EMAIL_FROM || 'support@precisiontrader.tech',
        to,
        subject,
        text,
        html
      };
    }
  },
  early_access_feedback_request: {
    label: 'early_access_feedback_request',
    name: 'Early Access Feedback Request',
    description: 'Request feedback from early access users',
    builder: ({ to }) => {
      const subject = 'How\'s PrecisionTrader working for you?';
      const text = `
Hi there!

We'd love to hear how PrecisionTrader is working for you. Your feedback helps us build better tools for traders.

Quick questions:
• What features are you using most?
• Any issues or bugs you've encountered?
• What would make PrecisionTrader even better?

Just reply to this email with your thoughts.

Thanks for being an early adopter!

— The PrecisionTrader Team
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
            <tr>
              <td style="padding:20px 24px;border-bottom:1px solid #1f2937;background-color:#151c2b;">
                <div style="font-weight:600;color:#e6edf3;font-size:18px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">PrecisionTrader</div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px;background-color:#151c2b;">
                <h2 style="margin:0 0 12px 0;color:#e6edf3;font-size:22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">How's PrecisionTrader working for you?</h2>
                <p style="margin:0 0 16px 0;color:#c7d2fe;font-size:15px;line-height:1.5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                  We'd love to hear how PrecisionTrader is working for you. Your feedback helps us build better tools for traders.
                </p>
                <div style="background-color:#1f2937;border-radius:8px;padding:16px;margin-bottom:16px;">
                  <div style="color:#e6edf3;font-size:15px;font-weight:600;margin-bottom:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Quick questions:</div>
                  <ul style="margin:0;padding-left:20px;color:#cbd5e1;line-height:1.7;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                    <li>What features are you using most?</li>
                    <li>Any issues or bugs you've encountered?</li>
                    <li>What would make PrecisionTrader even better?</li>
                  </ul>
                </div>
                <p style="margin:16px 0 0 0;color:#cbd5e1;font-size:14px;line-height:1.6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                  Just reply to this email with your thoughts.
                </p>
                <p style="margin:16px 0 0 0;color:#cbd5e1;font-size:14px;line-height:1.6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                  Thanks for being an early adopter!
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 24px;background-color:#1f2937;text-align:center;">
                <p style="margin:0;color:#9ca3af;font-size:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
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
      
      return {
        from: process.env.EMAIL_FROM || 'support@precisiontrader.tech',
        to,
        subject,
        text,
        html
      };
    }
  }
};

/**
 * Get all available email templates
 */
function getAvailableTemplates() {
  return Object.values(EMAIL_TEMPLATES).map(template => ({
    label: template.label,
    name: template.name,
    description: template.description
  }));
}

/**
 * Get a template by label
 */
function getTemplate(label) {
  return EMAIL_TEMPLATES[label];
}

/**
 * Build email using a template label
 */
function buildEmailFromTemplate(label, params = {}) {
  const template = EMAIL_TEMPLATES[label];
  if (!template) {
    throw new Error(`Email template not found: ${label}`);
  }
  return template.builder(params);
}

module.exports = {
  EMAIL_TEMPLATES,
  getAvailableTemplates,
  getTemplate,
  buildEmailFromTemplate
};
