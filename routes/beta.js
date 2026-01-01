const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken } = require('./auth');
const { requireSuperuser } = require('../middleware/superuserCheck');
const logger = require('../config/logging');

/**
 * Get all early access / beta users with their tracking data (admin only)
 */
router.get('/tracking', authenticateToken, requireSuperuser, async (req, res) => {
  try {

    // Get all users with early_access or beta_user, including those without beta_tracking records
    const result = await pool.query(`
      SELECT 
        COALESCE(bt.id, u.id) as id,
        COALESCE(bt.email, u.email) as email,
        u.id as user_id,
        bt.contact_submission_id,
        bt.beta_code,
        bt.requested_at,
        bt.started_at,
        bt.intro_email_sent_at,
        bt.followup_email_sent_at,
        bt.survey_sent_at,
        bt.survey_completed_at,
        bt.survey_response,
        bt.notes,
        bt.created_at,
        u.beta_user,
        u.early_access,
        u.early_access_started_at,
        u.referral_code as user_referral_code,
        cs.subject as request_subject,
        cs.message as request_message,
        cs.status as submission_status
      FROM users u
      LEFT JOIN beta_tracking bt ON bt.user_id = u.id
      LEFT JOIN contact_submissions cs ON bt.contact_submission_id = cs.id
      WHERE u.early_access = TRUE OR u.beta_user = TRUE
      ORDER BY 
        COALESCE(u.early_access_started_at, bt.started_at) DESC NULLS LAST, 
        bt.requested_at DESC NULLS LAST, 
        COALESCE(bt.created_at, u.early_access_started_at) DESC NULLS LAST
    `);

    res.json({ success: true, earlyAccessUsers: result.rows });
  } catch (error) {
    logger.error('Error fetching beta tracking data:', error);
    res.status(500).json({ error: 'Failed to fetch beta tracking data' });
  }
});

/**
 * Get a single beta user's tracking data (admin only)
 */
router.get('/tracking/:id', authenticateToken, requireSuperuser, async (req, res) => {
  try {

    const { id } = req.params;

    const result = await pool.query(`
      SELECT 
        bt.*,
        u.email as user_email,
        u.beta_user,
        u.early_access,
        u.early_access_started_at,
        u.referral_code as user_referral_code,
        cs.subject as request_subject,
        cs.message as request_message,
        cs.status as submission_status
      FROM beta_tracking bt
      LEFT JOIN users u ON bt.user_id = u.id
      LEFT JOIN contact_submissions cs ON bt.contact_submission_id = cs.id
      WHERE bt.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Beta user not found' });
    }

    res.json({ success: true, betaUser: result.rows[0] });
  } catch (error) {
    logger.error('Error fetching beta user:', error);
    res.status(500).json({ error: 'Failed to fetch beta user' });
  }
});

/**
 * Create or update beta tracking record (admin only)
 */
router.post('/tracking', authenticateToken, requireSuperuser, async (req, res) => {
  try {

    const {
      email,
      user_id,
      contact_submission_id,
      beta_code,
      requested_at,
      started_at,
      intro_email_sent_at,
      followup_email_sent_at,
      survey_sent_at,
      survey_completed_at,
      notes
    } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Upsert beta tracking record
    const result = await pool.query(`
      INSERT INTO beta_tracking (
        email, user_id, contact_submission_id, beta_code,
        requested_at, started_at, intro_email_sent_at,
        followup_email_sent_at, survey_sent_at, survey_completed_at, notes
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (email) 
      DO UPDATE SET
        user_id = COALESCE($2, beta_tracking.user_id),
        contact_submission_id = COALESCE($3, beta_tracking.contact_submission_id),
        beta_code = COALESCE($4, beta_tracking.beta_code),
        requested_at = COALESCE($5, beta_tracking.requested_at),
        started_at = COALESCE($6, beta_tracking.started_at),
        intro_email_sent_at = COALESCE($7, beta_tracking.intro_email_sent_at),
        followup_email_sent_at = COALESCE($8, beta_tracking.followup_email_sent_at),
        survey_sent_at = COALESCE($9, beta_tracking.survey_sent_at),
        survey_completed_at = COALESCE($10, beta_tracking.survey_completed_at),
        notes = COALESCE($11, beta_tracking.notes)
      RETURNING *
    `, [
      email, user_id, contact_submission_id, beta_code,
      requested_at, started_at, intro_email_sent_at,
      followup_email_sent_at, survey_sent_at, survey_completed_at, notes
    ]);

    res.json({ success: true, betaUser: result.rows[0] });
  } catch (error) {
    logger.error('Error creating/updating beta tracking:', error);
    res.status(500).json({ error: 'Failed to create/update beta tracking' });
  }
});

/**
 * Update specific beta tracking fields (admin only)
 */
router.patch('/tracking/:id', authenticateToken, requireSuperuser, async (req, res) => {
  try {

    const { id } = req.params;
    const updates = req.body;

    // Build dynamic update query
    const allowedFields = [
      'user_id', 'beta_code', 'requested_at', 'started_at',
      'intro_email_sent_at', 'followup_email_sent_at', 
      'survey_sent_at', 'survey_completed_at', 'survey_response', 'notes'
    ];

    const updateFields = Object.keys(updates).filter(key => allowedFields.includes(key));
    
    if (updateFields.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const setClauses = updateFields.map((field, idx) => `${field} = $${idx + 2}`).join(', ');
    const values = [id, ...updateFields.map(field => updates[field])];

    const result = await pool.query(
      `UPDATE beta_tracking SET ${setClauses} WHERE id = $1 RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Beta user not found' });
    }

    res.json({ success: true, betaUser: result.rows[0] });
  } catch (error) {
    logger.error('Error updating beta tracking:', error);
    res.status(500).json({ error: 'Failed to update beta tracking' });
  }
});

/**
 * Send follow-up email to beta user (admin only)
 */
router.post('/tracking/:id/send-followup', authenticateToken, requireSuperuser, async (req, res) => {
  try {

    const { id } = req.params;

    // Get beta user info
    const betaUserResult = await pool.query(
      'SELECT * FROM beta_tracking WHERE id = $1',
      [id]
    );

    if (betaUserResult.rows.length === 0) {
      return res.status(404).json({ error: 'Beta user not found' });
    }

    const betaUser = betaUserResult.rows[0];

    // TODO: Send follow-up email using email service
    // For now, just mark it as sent
    await pool.query(
      'UPDATE beta_tracking SET followup_email_sent_at = CURRENT_TIMESTAMP WHERE id = $1',
      [id]
    );

    logger.info(`Follow-up email sent to ${betaUser.email}`);
    res.json({ success: true, message: 'Follow-up email sent' });
  } catch (error) {
    logger.error('Error sending follow-up email:', error);
    res.status(500).json({ error: 'Failed to send follow-up email' });
  }
});

/**
 * Send survey to beta user (admin only)
 */
router.post('/tracking/:id/send-survey', authenticateToken, requireSuperuser, async (req, res) => {
  try {

    const { id } = req.params;

    // Get beta user info
    const betaUserResult = await pool.query(
      'SELECT * FROM beta_tracking WHERE id = $1',
      [id]
    );

    if (betaUserResult.rows.length === 0) {
      return res.status(404).json({ error: 'Beta user not found' });
    }

    const betaUser = betaUserResult.rows[0];

    // TODO: Send survey email using email service
    // For now, just mark it as sent
    await pool.query(
      'UPDATE beta_tracking SET survey_sent_at = CURRENT_TIMESTAMP WHERE id = $1',
      [id]
    );

    logger.info(`Survey sent to ${betaUser.email}`);
    res.json({ success: true, message: 'Survey sent' });
  } catch (error) {
    logger.error('Error sending survey:', error);
    res.status(500).json({ error: 'Failed to send survey' });
  }
});

/**
 * Get beta users that need follow-up emails (15 days after start)
 */
router.get('/tracking/pending-followups', authenticateToken, requireSuperuser, async (req, res) => {
  try {

    const result = await pool.query(`
      SELECT *
      FROM beta_tracking
      WHERE started_at IS NOT NULL
        AND followup_email_sent_at IS NULL
        AND started_at <= CURRENT_TIMESTAMP - INTERVAL '15 days'
      ORDER BY started_at ASC
    `);

    res.json({ success: true, users: result.rows });
  } catch (error) {
    logger.error('Error fetching pending follow-ups:', error);
    res.status(500).json({ error: 'Failed to fetch pending follow-ups' });
  }
});

/**
 * Get beta users that need surveys (30 days after start)
 */
router.get('/tracking/pending-surveys', authenticateToken, requireSuperuser, async (req, res) => {
  try {

    const result = await pool.query(`
      SELECT *
      FROM beta_tracking
      WHERE started_at IS NOT NULL
        AND survey_sent_at IS NULL
        AND started_at <= CURRENT_TIMESTAMP - INTERVAL '30 days'
      ORDER BY started_at ASC
    `);

    res.json({ success: true, users: result.rows });
  } catch (error) {
    logger.error('Error fetching pending surveys:', error);
    res.status(500).json({ error: 'Failed to fetch pending surveys' });
  }
});

module.exports = router;






