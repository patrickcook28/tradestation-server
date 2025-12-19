const express = require('express');
const router = express.Router();
const pool = require('../db');
const { createTransport, buildContactNotificationEmail, buildContactConfirmationEmail, buildBetaWelcomeEmail } = require('../config/email');
const logger = require('../config/logging');

// Contact form submission handler (public endpoint - no auth required)
const postContact = async (req, res) => {
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

    // Extract userId from token if available (optional)
    let finalUserId = userId || null;
    if (!finalUserId && req.user && req.user.id) {
      finalUserId = req.user.id;
    }

    // Insert contact form submission into database
    const result = await pool.query(
      `INSERT INTO contact_submissions (email, subject, message, user_id, created_at, status)
       VALUES ($1, $2, $3, $4, $5, 'new')
       RETURNING id`,
      [email, subject, message, finalUserId, timestamp || new Date().toISOString()]
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
        userId: finalUserId,
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
};

// Register the POST handler in router (will be overridden by public route in index.js)
router.post('/', postContact);

// Get contact submissions (admin only)
router.get('/submissions', async (req, res) => {
  try {
    const userId = req.user && req.user.id;
    // Verify superuser from DB
    const userResult = await pool.query('SELECT superuser FROM users WHERE id = $1', [userId]);
    if (!userResult.rows.length || !userResult.rows[0].superuser) {
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
    const userId = req.user && req.user.id;
    // Verify superuser from DB
    const userResult = await pool.query('SELECT superuser FROM users WHERE id = $1', [userId]);
    if (!userResult.rows.length || !userResult.rows[0].superuser) {
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

// Send beta code to user (admin only)
router.post('/submissions/:id/send-beta-code', async (req, res) => {
  try {
    const userId = req.user && req.user.id;
    // Verify superuser from DB
    const userResult = await pool.query('SELECT superuser FROM users WHERE id = $1', [userId]);
    if (!userResult.rows.length || !userResult.rows[0].superuser) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { id } = req.params;
    const { betaCode } = req.body;

    if (!betaCode) {
      return res.status(400).json({ error: 'Beta code is required' });
    }

    // Get the submission
    const submissionResult = await pool.query(
      'SELECT email, user_id, created_at FROM contact_submissions WHERE id = $1',
      [id]
    );

    if (submissionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Contact submission not found' });
    }

    const submission = submissionResult.rows[0];
    const email = submission.email;

    // Send the beta welcome email
    try {
      const transport = createTransport();
      const mailOptions = buildBetaWelcomeEmail({
        to: email,
        betaCode: betaCode
      });
      
      await transport.sendMail(mailOptions);
      logger.info(`Beta welcome email sent to ${email} with code ${betaCode}`);

      // Update submission status to resolved
      await pool.query(
        `UPDATE contact_submissions 
         SET status = 'resolved', updated_at = NOW()
         WHERE id = $1`,
        [id]
      );

      // Create or update beta tracking record
      const now = new Date().toISOString();
      await pool.query(`
        INSERT INTO beta_tracking (
          email, user_id, contact_submission_id, beta_code,
          requested_at, started_at, intro_email_sent_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $6)
        ON CONFLICT (email) 
        DO UPDATE SET
          user_id = COALESCE($2, beta_tracking.user_id),
          contact_submission_id = COALESCE($3, beta_tracking.contact_submission_id),
          beta_code = COALESCE($4, beta_tracking.beta_code),
          requested_at = COALESCE($5, beta_tracking.requested_at),
          started_at = COALESCE($6, beta_tracking.started_at),
          intro_email_sent_at = COALESCE($6, beta_tracking.intro_email_sent_at)
      `, [email, submission.user_id, id, betaCode, submission.created_at, now]);

      logger.info(`Beta tracking record created/updated for ${email}`);

      res.json({ 
        success: true, 
        message: `Beta code ${betaCode} sent to ${email}` 
      });
    } catch (emailError) {
      logger.error('Failed to send beta welcome email:', emailError);
      res.status(500).json({ 
        error: 'Failed to send beta welcome email' 
      });
    }

  } catch (error) {
    console.error('Error sending beta code:', error);
    res.status(500).json({ 
      error: 'Failed to send beta code' 
    });
  }
});

module.exports = router;
module.exports.postContact = postContact;
