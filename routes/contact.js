const express = require('express');
const router = express.Router();
const pool = require('../db');
const { createTransport, buildContactNotificationEmail, buildContactConfirmationEmail } = require('../config/email');
const logger = require('../config/logging');

// Contact form submission
router.post('/', async (req, res) => {
  try {
    console.log('Contact form submission received:', req.method, req.body);
    const { email, subject, message, userId, timestamp } = req.body;

    // Validate required fields
    if (!email || !subject || !message) {
      return res.status(400).json({ 
        error: 'Missing required fields: email, subject, and message are required' 
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ 
        error: 'Invalid email format' 
      });
    }

    // Check if this is a beta access request
    const isBetaRequest = subject.toLowerCase().includes('beta access');

    // Insert contact form submission into database
    const result = await pool.query(
      `INSERT INTO contact_submissions (email, subject, message, user_id, created_at, status)
       VALUES ($1, $2, $3, $4, $5, 'new')
       RETURNING id`,
      [email, subject, message, userId || null, timestamp || new Date().toISOString()]
    );

    console.log(`Contact form submission received from ${email}: ${subject}`);

    // Send emails (don't let email failures block the request)
    const transport = createTransport();
    
    // Send notification to admin
    try {
      const adminMailOptions = buildContactNotificationEmail({
        email,
        subject,
        message,
        userId,
        isBetaRequest
      });
      
      await transport.sendMail(adminMailOptions);
      logger.info(`Contact notification email sent for submission ${result.rows[0].id}`);
    } catch (emailError) {
      logger.error('Failed to send admin notification email:', emailError);
      console.error('Admin email error:', emailError);
    }

    // Send confirmation to user
    try {
      const userMailOptions = buildContactConfirmationEmail({
        to: email,
        subject,
        isBetaRequest
      });
      
      console.log(`Attempting to send confirmation email to: ${email}`);
      console.log('User mail options:', JSON.stringify({ from: userMailOptions.from, to: userMailOptions.to, subject: userMailOptions.subject }));
      
      await transport.sendMail(userMailOptions);
      logger.info(`Confirmation email sent to user ${email} for submission ${result.rows[0].id}`);
      console.log(`✅ Successfully sent confirmation email to ${email}`);
    } catch (emailError) {
      logger.error('Failed to send user confirmation email:', emailError);
      console.error('❌ User email error:', emailError);
      console.error('Error details:', emailError.message);
    }

    res.json({ 
      success: true, 
      message: 'Contact form submitted successfully',
      submissionId: result.rows[0].id
    });

  } catch (error) {
    console.error('Error processing contact form:', error);
    res.status(500).json({ 
      error: 'Failed to submit contact form. Please try again later.' 
    });
  }
});

// Get contact submissions (admin only)
router.get('/submissions', async (req, res) => {
  try {
    // Check if user is admin (you may want to add proper admin authentication)
    const { user } = req;
    if (!user || !user.superuser) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await pool.query(
      `SELECT id, email, subject, message, user_id, created_at, status
       FROM contact_submissions
       ORDER BY created_at DESC
       LIMIT 100`
    );

    res.json(result.rows);

  } catch (error) {
    console.error('Error fetching contact submissions:', error);
    res.status(500).json({ 
      error: 'Failed to fetch contact submissions' 
    });
  }
});

// Update contact submission status (admin only)
router.put('/submissions/:id', async (req, res) => {
  try {
    const { user } = req;
    if (!user || !user.superuser) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { id } = req.params;
    const { status } = req.body;

    if (!['new', 'in_progress', 'resolved', 'closed'].includes(status)) {
      return res.status(400).json({ 
        error: 'Invalid status. Must be: new, in_progress, resolved, or closed' 
      });
    }

    const result = await pool.query(
      `UPDATE contact_submissions 
       SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Contact submission not found' });
    }

    res.json({ 
      success: true, 
      message: 'Status updated successfully',
      submission: result.rows[0]
    });

  } catch (error) {
    console.error('Error updating contact submission:', error);
    res.status(500).json({ 
      error: 'Failed to update contact submission' 
    });
  }
});

module.exports = router;
