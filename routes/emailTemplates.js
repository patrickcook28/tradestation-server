const express = require('express');
const router = express.Router();
const { createTransport } = require('../config/email');
const { getAvailableTemplates, getTemplate, buildEmailFromTemplate } = require('../config/emailTemplates');
const logger = require('../config/logging');
const { requireSuperuser } = require('../middleware/superuserCheck');

/**
 * Get all available email templates (superuser only)
 */
router.get('/', requireSuperuser, async (req, res) => {
  try {
    const templates = getAvailableTemplates();
    res.json({ success: true, templates });
  } catch (error) {
    logger.error('Error fetching email templates:', error);
    res.status(500).json({ error: 'Failed to fetch email templates' });
  }
});

/**
 * Get a specific email template by label (superuser only)
 */
router.get('/:label', requireSuperuser, async (req, res) => {
  try {
    const { label } = req.params;
    
    const template = getTemplate(label);
    
    if (!template) {
      return res.status(404).json({ error: 'Email template not found' });
    }
    
    res.json({ 
      success: true, 
      template: {
        label: template.label,
        name: template.name,
        description: template.description
      }
    });
  } catch (error) {
    logger.error('Error fetching email template:', error);
    res.status(500).json({ error: 'Failed to fetch email template' });
  }
});


/**
 * Send email to users using a template (superuser only)
 * Accepts single email or comma-separated list of emails
 * Uses template_label to identify the template
 */
router.post('/send', requireSuperuser, async (req, res) => {
  try {
    const { template_label, emails } = req.body;
    
    if (!template_label || !emails) {
      return res.status(400).json({ 
        error: 'Missing required fields: template_label and emails are required' 
      });
    }
    
    // Get the template
    const template = getTemplate(template_label);
    
    if (!template) {
      return res.status(404).json({ error: 'Email template not found' });
    }
    
    // Parse emails (support comma-separated list)
    const emailList = typeof emails === 'string' 
      ? emails.split(',').map(e => e.trim()).filter(e => e)
      : Array.isArray(emails) ? emails : [emails];
    
    if (emailList.length === 0) {
      return res.status(400).json({ error: 'No valid emails provided' });
    }
    
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const invalidEmails = emailList.filter(email => !emailRegex.test(email));
    if (invalidEmails.length > 0) {
      return res.status(400).json({ 
        error: `Invalid email addresses: ${invalidEmails.join(', ')}` 
      });
    }
    
    // Send emails
    const transport = createTransport();
    const results = {
      sent: [],
      failed: []
    };
    
    for (const email of emailList) {
      try {
        const mailOptions = buildEmailFromTemplate(template_label, { to: email });
        await transport.sendMail(mailOptions);
        
        results.sent.push(email);
        logger.info(`Email sent to ${email} using template: ${template_label}`);
      } catch (emailError) {
        results.failed.push({ email, error: emailError.message });
        logger.error(`Failed to send email to ${email}:`, emailError);
      }
    }
    
    res.json({ 
      success: true, 
      message: `Sent ${results.sent.length} email(s), ${results.failed.length} failed`,
      results 
    });
  } catch (error) {
    logger.error('Error sending emails:', error);
    res.status(500).json({ error: 'Failed to send emails' });
  }
});


module.exports = router;
