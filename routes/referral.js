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

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
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





module.exports = router; 