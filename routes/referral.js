const express = require('express');
const router = express.Router();
const db = require('../db');
const jwt = require('jsonwebtoken');

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.sendStatus(401);
    }

    jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] }, (err, user) => {
        if (err) {
            return res.sendStatus(403);
        }
        req.user = user;
        next();
    });
};

// Validate referral code
router.get('/validate/:code', async (req, res) => {
    try {
        const { code } = req.params;
        
        const result = await db.query(
            'SELECT * FROM referral_codes WHERE code = $1 AND is_active = true',
            [code]
        );

        if (result.rows.length === 0) {
            return res.json({ valid: false, message: 'Invalid referral code' });
        }

        const referralCode = result.rows[0];
        
        // Check if max uses reached
        if (referralCode.max_uses && referralCode.current_uses >= referralCode.max_uses) {
            return res.json({ valid: false, message: 'Referral code usage limit reached' });
        }

        res.json({ 
            valid: true, 
            code: referralCode.code,
            description: referralCode.description 
        });
    } catch (error) {
        console.error('Error validating referral code:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Admin: Get all referral codes
router.get('/admin/codes', authenticateToken, async (req, res) => {
    try {
        // Check if user is superuser
        const userResult = await db.query(
            'SELECT superuser FROM users WHERE id = $1',
            [req.user.id]
        );

        if (!userResult.rows[0]?.superuser) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const result = await db.query(`
            SELECT 
                id, 
                code, 
                description, 
                is_active, 
                max_uses, 
                current_uses,
                created_at,
                updated_at
            FROM referral_codes
            ORDER BY created_at DESC
        `);

        res.json({ codes: result.rows });
    } catch (error) {
        console.error('Error fetching referral codes:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Admin: Create new referral code
router.post('/admin/codes', authenticateToken, async (req, res) => {
    try {
        // Check if user is superuser
        const userResult = await db.query(
            'SELECT superuser FROM users WHERE id = $1',
            [req.user.id]
        );

        if (!userResult.rows[0]?.superuser) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { code, description, max_uses } = req.body;

        if (!code || !code.trim()) {
            return res.status(400).json({ error: 'Code is required' });
        }

        // Check if code already exists
        const existingCode = await db.query(
            'SELECT id FROM referral_codes WHERE code = $1',
            [code.trim().toUpperCase()]
        );

        if (existingCode.rows.length > 0) {
            return res.status(400).json({ error: 'Code already exists' });
        }

        const result = await db.query(
            `INSERT INTO referral_codes (code, description, is_active, max_uses, current_uses)
             VALUES ($1, $2, true, $3, 0)
             RETURNING *`,
            [code.trim().toUpperCase(), description || null, max_uses || null]
        );

        res.json({ 
            success: true, 
            message: 'Referral code created successfully',
            code: result.rows[0]
        });
    } catch (error) {
        console.error('Error creating referral code:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Admin: Update referral code (toggle active status)
router.patch('/admin/codes/:id', authenticateToken, async (req, res) => {
    try {
        // Check if user is superuser
        const userResult = await db.query(
            'SELECT superuser FROM users WHERE id = $1',
            [req.user.id]
        );

        if (!userResult.rows[0]?.superuser) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { id } = req.params;
        const { is_active } = req.body;

        const result = await db.query(
            `UPDATE referral_codes 
             SET is_active = $1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $2
             RETURNING *`,
            [is_active, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Referral code not found' });
        }

        res.json({ 
            success: true, 
            message: 'Referral code updated successfully',
            code: result.rows[0]
        });
    } catch (error) {
        console.error('Error updating referral code:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router; 