const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken } = require('./auth');

// Create a new trade journal entry (JSONB-based)
router.post('/trade_journals', authenticateToken, async (req, res) => {
  try {
    const { entry } = req.body || {};
    if (!entry || typeof entry !== 'object') {
      return res.status(400).json({ error: 'Invalid entry payload' });
    }
    const userId = req.user.id;
    const result = await pool.query(
      `INSERT INTO trade_journal (user_id, entry) VALUES ($1, $2::jsonb) RETURNING id, user_id, entry`,
      [userId, JSON.stringify(entry)]
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating trade journal:', error);
    return res.status(500).json({ error: 'Failed to create trade journal' });
  }
});

// Get all trade journals (currently global; can be filtered per user if column exists)
router.get('/trade_journals', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      'SELECT id, user_id, entry FROM trade_journal WHERE user_id = $1 ORDER BY id DESC',
      [userId]
    );
    return res.json(result.rows);
  } catch (error) {
    console.error('Error fetching trade journals:', error);
    return res.status(500).json({ error: 'Failed to fetch trade journals' });
  }
});

// Delete a trade journal by id
router.delete('/trade_journals/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    await pool.query('DELETE FROM trade_journal WHERE id = $1 AND user_id = $2', [id, userId]);
    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting trade journal:', error);
    return res.status(500).json({ error: 'Failed to delete trade journal' });
  }
});

// Get current user's active journal template
router.get('/trade_journal_template', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      `SELECT id, name, template FROM trade_journal_templates WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
      [userId]
    );
    if (result.rows.length === 0) {
      return res.json({ id: null, name: 'Default', template: { fields: [] } });
    }
    return res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching trade journal template:', error);
    return res.status(500).json({ error: 'Failed to fetch trade journal template' });
  }
});

// Upsert (create/update) current user's journal template
router.put('/trade_journal_template', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, template } = req.body || {};
    if (!template || typeof template !== 'object' || !Array.isArray(template.fields)) {
      return res.status(400).json({ error: 'Invalid template payload' });
    }
    const templateName = name || 'Default';
    // Normalize and persist position for each field
    const normalized = {
      ...template,
      fields: template.fields.map((f, i) => ({ ...f, position: typeof f.position === 'number' ? f.position : i }))
    };

    // Try update latest, else insert
    const existing = await pool.query(
      `SELECT id FROM trade_journal_templates WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
      [userId]
    );
    let result;
    if (existing.rows.length > 0) {
      const id = existing.rows[0].id;
      result = await pool.query(
        `UPDATE trade_journal_templates SET name = $1, template = $2::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING id, name, template`,
        [templateName, JSON.stringify(normalized), id]
      );
    } else {
      result = await pool.query(
        `INSERT INTO trade_journal_templates (user_id, name, template) VALUES ($1, $2, $3::jsonb) RETURNING id, name, template`,
        [userId, templateName, JSON.stringify(normalized)]
      );
    }
    return res.json(result.rows[0]);
  } catch (error) {
    console.error('Error upserting trade journal template:', error);
    return res.status(500).json({ error: 'Failed to save trade journal template' });
  }
});

// Update a trade journal by id
router.put('/trade_journals/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { entry } = req.body || {};
    if (!entry || typeof entry !== 'object') {
      return res.status(400).json({ error: 'Invalid entry payload' });
    }
    const userId = req.user.id;
    // Allow updating when the row belongs to the user OR is legacy (user_id IS NULL). Also claim legacy row.
    const result = await pool.query(
      'UPDATE trade_journal SET entry = $3::jsonb, user_id = COALESCE(user_id, $2) WHERE id = $1 AND (user_id = $2 OR user_id IS NULL) RETURNING id, user_id, entry',
      [id, userId, JSON.stringify(entry)]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    return res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating trade journal:', error);
    return res.status(500).json({ error: 'Failed to update trade journal' });
  }
});

module.exports = router;


