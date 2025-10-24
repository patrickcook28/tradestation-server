const express = require('express');
const router = express.Router();
const pool = require('../db');
const { createTransport, buildBugReportNotificationEmail, buildBugReportConfirmationEmail } = require('../config/email');
const logger = require('../config/logging');

// Bug report submission
router.post('/', async (req, res) => {
  try {
    console.log('Bug report submission received:', req.method, req.body);
    const { email, subject, description, stateSnapshot, userId, timestamp } = req.body;

    // Validate required fields
    if (!email || !subject || !description) {
      return res.status(400).json({ 
        error: 'Missing required fields: email, subject, and description are required' 
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ 
        error: 'Invalid email format' 
      });
    }

    // Insert bug report into database
    const result = await pool.query(
      `INSERT INTO bug_reports (email, subject, description, state_snapshot, user_id, created_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'new')
       RETURNING id`,
      [
        email, 
        subject, 
        description, 
        stateSnapshot ? JSON.stringify(stateSnapshot) : null,
        userId || null, 
        timestamp || new Date().toISOString()
      ]
    );

    const reportId = result.rows[0].id;
    console.log(`Bug report received from ${email}: ${subject} (ID: ${reportId})`);

    // Send emails (don't let email failures block the request)
    const transport = createTransport();
    
    // Send notification to admin
    try {
      const adminMailOptions = buildBugReportNotificationEmail({
        email,
        subject,
        description,
        userId,
        stateSnapshot,
        reportId
      });
      
      await transport.sendMail(adminMailOptions);
      logger.info(`Bug report notification email sent for submission ${reportId}`);
    } catch (emailError) {
      logger.error('Failed to send admin bug report notification email:', emailError);
      console.error('Admin email error:', emailError);
    }

    // Send confirmation to user
    try {
      const userMailOptions = buildBugReportConfirmationEmail({
        to: email,
        subject
      });
      
      console.log(`Attempting to send bug report confirmation email to: ${email}`);
      
      await transport.sendMail(userMailOptions);
      logger.info(`Bug report confirmation email sent to user ${email} for submission ${result.rows[0].id}`);
      console.log(`✅ Successfully sent bug report confirmation email to ${email}`);
    } catch (emailError) {
      logger.error('Failed to send user bug report confirmation email:', emailError);
      console.error('❌ User email error:', emailError);
      console.error('Error details:', emailError.message);
    }

    res.json({ 
      success: true, 
      message: 'Bug report submitted successfully',
      reportId: result.rows[0].id
    });

  } catch (error) {
    console.error('Error processing bug report:', error);
    res.status(500).json({ 
      error: 'Failed to submit bug report. Please try again later.' 
    });
  }
});

// Get bug reports (admin only)
router.get('/', async (req, res) => {
  try {
    const userId = req.user && req.user.id;
    // Verify superuser from DB
    const userResult = await pool.query('SELECT superuser FROM users WHERE id = $1', [userId]);
    if (!userResult.rows.length || !userResult.rows[0].superuser) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await pool.query(
      `SELECT id, email, subject, description, user_id, created_at, status
       FROM bug_reports
       ORDER BY created_at DESC
       LIMIT 100`
    );

    res.json(result.rows);

  } catch (error) {
    console.error('Error fetching bug reports:', error);
    res.status(500).json({ 
      error: 'Failed to fetch bug reports' 
    });
  }
});

// Get specific bug report with full state snapshot (admin only)
router.get('/:id', async (req, res) => {
  try {
    const userId = req.user && req.user.id;
    // Verify superuser from DB
    const userResult = await pool.query('SELECT superuser FROM users WHERE id = $1', [userId]);
    if (!userResult.rows.length || !userResult.rows[0].superuser) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { id } = req.params;
    const result = await pool.query(
      `SELECT * FROM bug_reports WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bug report not found' });
    }

    res.json(result.rows[0]);

  } catch (error) {
    console.error('Error fetching bug report:', error);
    res.status(500).json({ 
      error: 'Failed to fetch bug report' 
    });
  }
});

// Update bug report status (admin only)
router.put('/:id', async (req, res) => {
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
      `UPDATE bug_reports 
       SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bug report not found' });
    }

    res.json({ 
      success: true, 
      message: 'Status updated successfully',
      report: result.rows[0]
    });

  } catch (error) {
    console.error('Error updating bug report:', error);
    res.status(500).json({ 
      error: 'Failed to update bug report' 
    });
  }
});

module.exports = router;

