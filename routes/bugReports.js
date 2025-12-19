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

    const { email } = req.query;
    
    let query = `
      SELECT id, email, subject, description, user_id, created_at, status, resolution_notes
      FROM bug_reports
    `;
    const params = [];
    
    if (email) {
      query += ` WHERE email ILIKE $1`;
      params.push(`%${email}%`);
    }
    
    query += ` ORDER BY created_at DESC LIMIT 100`;

    const result = await pool.query(query, params);

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

// Update bug report status and resolution notes (admin only)
router.put('/:id', async (req, res) => {
  try {
    const userId = req.user && req.user.id;
    // Verify superuser from DB
    const userResult = await pool.query('SELECT superuser FROM users WHERE id = $1', [userId]);
    if (!userResult.rows.length || !userResult.rows[0].superuser) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { id } = req.params;
    const { status, resolution_notes } = req.body;

    // Build dynamic update query
    const updates = [];
    const params = [];
    let paramCount = 1;

    if (status !== undefined) {
      if (!['new', 'in_progress', 'resolved', 'closed'].includes(status)) {
        return res.status(400).json({ 
          error: 'Invalid status. Must be: new, in_progress, resolved, or closed' 
        });
      }
      updates.push(`status = $${paramCount++}`);
      params.push(status);
      
      // If marking as resolved, set resolved_by and resolved_at
      if (status === 'resolved') {
        updates.push(`resolved_by = $${paramCount++}`);
        params.push(userId);
        updates.push(`resolved_at = NOW()`);
      }
    }

    if (resolution_notes !== undefined) {
      updates.push(`resolution_notes = $${paramCount++}`);
      params.push(resolution_notes);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`updated_at = NOW()`);
    params.push(id);

    const result = await pool.query(
      `UPDATE bug_reports 
       SET ${updates.join(', ')}
       WHERE id = $${paramCount}
       RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bug report not found' });
    }

    res.json({ 
      success: true, 
      message: 'Bug report updated successfully',
      report: result.rows[0]
    });

  } catch (error) {
    console.error('Error updating bug report:', error);
    res.status(500).json({ 
      error: 'Failed to update bug report' 
    });
  }
});

// Delete bug report (admin only)
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.user && req.user.id;
    // Verify superuser from DB
    const userResult = await pool.query('SELECT superuser FROM users WHERE id = $1', [userId]);
    if (!userResult.rows.length || !userResult.rows[0].superuser) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { id } = req.params;
    const result = await pool.query(
      'DELETE FROM bug_reports WHERE id = $1 RETURNING id',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bug report not found' });
    }

    res.json({ 
      success: true, 
      message: 'Bug report deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting bug report:', error);
    res.status(500).json({ 
      error: 'Failed to delete bug report' 
    });
  }
});

module.exports = router;

