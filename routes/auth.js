const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const logger = require("../config/logging");

const register = async (req, res) => {
    const { email, password, password_confirm, referral_code } = req.body;

    pool.query('SELECT email FROM users WHERE email = $1', [email], async (error, result) => {
        if(error){
            return res.status(400).json({ error: 'Failed to check if user exists' })
        } else if( result.rows.length > 0 ) {
            return res.status(400).json({ error: 'Email is already in use' })
        } else if(password !== password_confirm) {
            return res.status(400).json({ error: 'Password Didn\'t Match!'})
        }

        let hashedPassword = await bcrypt.hash(password, 8)
        let beta_user = false
        let final_referral_code = null

        // If referral code is provided, validate it and set beta_user to true
        if (referral_code) {
            try {
                const referralResult = await pool.query(
                    'SELECT * FROM referral_codes WHERE code = $1 AND is_active = true',
                    [referral_code]
                );

                if (referralResult.rows.length > 0) {
                    const referralCode = referralResult.rows[0];
                    
                    // Check if max uses reached
                    if (!referralCode.max_uses || referralCode.current_uses < referralCode.max_uses) {
                        beta_user = true;
                        final_referral_code = referral_code;
                        
                        // Increment usage count
                        await pool.query(
                            'UPDATE referral_codes SET current_uses = current_uses + 1 WHERE code = $1',
                            [referral_code]
                        );
                    } else {
                        return res.status(400).json({ error: 'Referral code usage limit reached' })
                    }
                } else {
                    return res.status(400).json({ error: 'Invalid referral code' })
                }
            } catch (error) {
                console.error('Error validating referral code:', error);
                return res.status(500).json({ error: 'Failed to validate referral code' })
            }
        }

        pool.query(
            'INSERT INTO users (email, password, beta_user, referral_code) VALUES ($1, $2, $3, $4)',
            [email, hashedPassword, beta_user, final_referral_code], 
            (error, result) => {
                if(error) {
                    return res.status(400).json({ error: 'Failed to create new user' })
                } else {
                                    return res.json({ 
                    success: true, 
                    beta_user: beta_user,
                    message: beta_user ? 'Welcome to the beta!' : 'Account created successfully',
                    id: result.rows[0].id,
                    email: email,
                    maxLossPerDay: 0,
                    maxLossPerDayEnabled: false,
                    maxLossPerTrade: 0,
                    maxLossPerTradeEnabled: false,
                    superuser: false,
                    referral_code: final_referral_code
                })
                }
            }
        )        
    })
};

const login = async (req, res) => {
    const { email, password } = req.body;

    pool.query('SELECT * FROM users WHERE email = $1', [email], async (error, result) => {
        if(error){
            return res.status(400).json({ error: 'Failed to check if user exists' })
        } else if( result.rows.length === 0 ) {
            return res.status(400).json({ error: 'User not found' })
        }

        let user = result.rows[0]

        let isMatch = await bcrypt.compare(password, user.password)

        if(!isMatch){
            return res.status(400).json({ error: 'Invalid credentials' })
        }

        let token = jwt.sign({ id: user.id }, process.env.JWT_SECRET)

        return res.json({
            token,
            id: user.id,
            email: user.email,
            maxLossPerDay: user.max_loss_per_day || 0,
            maxLossPerDayEnabled: user.max_loss_per_day_enabled || false,
            maxLossPerTrade: user.max_loss_per_trade || 0,
            maxLossPerTradeEnabled: user.max_loss_per_trade_enabled || false,
            superuser: user.superuser || false,
            beta_user: user.beta_user || false,
            referral_code: user.referral_code
        })
    })
};

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token == null) {
    logger.auth(req.method, req.path, 'Token Missing');
    return res.sendStatus(401); // if there isn't any token
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      logger.auth(req.method, req.path, 'Failed', null);
      return res.sendStatus(403);
    }
    logger.auth(req.method, req.path, 'Success', user.id);
    req.user = user;
    next();
  });
};

// Get user settings
const getUserSettings = async (req, res) => {
    try {
        const userId = req.user.id;
        
        const result = await pool.query(
            'SELECT max_loss_per_day, max_loss_per_day_enabled, max_loss_per_trade, max_loss_per_trade_enabled, superuser, beta_user, referral_code FROM users WHERE id = $1',
            [userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = result.rows[0];
        return res.json({
            maxLossPerDay: user.max_loss_per_day || 0,
            maxLossPerDayEnabled: user.max_loss_per_day_enabled || false,
            maxLossPerTrade: user.max_loss_per_trade || 0,
            maxLossPerTradeEnabled: user.max_loss_per_trade_enabled || false,
            superuser: user.superuser || false,
            beta_user: user.beta_user || false,
            referral_code: user.referral_code
        });
    } catch (error) {
        logger.error('Error getting user settings:', error);
        return res.status(500).json({ error: 'Failed to get user settings' });
    }
};

// Update user settings
const updateUserSettings = async (req, res) => {
    try {
        const userId = req.user.id;
        const { 
            maxLossPerDay, 
            maxLossPerDayEnabled, 
            maxLossPerTrade, 
            maxLossPerTradeEnabled 
        } = req.body;

        const result = await pool.query(
            `UPDATE users SET 
                max_loss_per_day = $1,
                max_loss_per_day_enabled = $2,
                max_loss_per_trade = $3,
                max_loss_per_trade_enabled = $4
            WHERE id = $5
            RETURNING max_loss_per_day, max_loss_per_day_enabled, max_loss_per_trade, max_loss_per_trade_enabled, superuser, beta_user, referral_code`,
            [maxLossPerDay, maxLossPerDayEnabled, maxLossPerTrade, maxLossPerTradeEnabled, userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = result.rows[0];
        return res.json({
            maxLossPerDay: user.max_loss_per_day || 0,
            maxLossPerDayEnabled: user.max_loss_per_day_enabled || false,
            maxLossPerTrade: user.max_loss_per_trade || 0,
            maxLossPerTradeEnabled: user.max_loss_per_trade_enabled || false,
            superuser: user.superuser || false,
            beta_user: user.beta_user || false,
            referral_code: user.referral_code
        });
    } catch (error) {
        logger.error('Error updating user settings:', error);
        return res.status(500).json({ error: 'Failed to update user settings' });
    }
};

// Apply referral code to existing user
const applyReferralCode = async (req, res) => {
    try {
        const userId = req.user.id;
        const { referral_code } = req.body;

        if (!referral_code) {
            return res.status(400).json({ error: 'Referral code is required' });
        }

        // Check if user already has beta access
        const userCheck = await pool.query(
            'SELECT beta_user FROM users WHERE id = $1',
            [userId]
        );

        if (userCheck.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (userCheck.rows[0].beta_user) {
            return res.status(400).json({ error: 'User already has beta access' });
        }

        // Validate the referral code
        const referralResult = await pool.query(
            'SELECT * FROM referral_codes WHERE code = $1 AND is_active = true',
            [referral_code]
        );

        if (referralResult.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid referral code' });
        }

        const referralCode = referralResult.rows[0];
        
        // Check if max uses reached
        if (referralCode.max_uses && referralCode.current_uses >= referralCode.max_uses) {
            return res.status(400).json({ error: 'Referral code usage limit reached' });
        }

        // Update user to beta and set referral code
        await pool.query(
            'UPDATE users SET beta_user = true, referral_code = $1 WHERE id = $2',
            [referral_code, userId]
        );

        // Increment usage count
        await pool.query(
            'UPDATE referral_codes SET current_uses = current_uses + 1 WHERE code = $1',
            [referral_code]
        );

        res.json({ 
            success: true, 
            message: 'Referral code applied successfully! You now have beta access.',
            beta_user: true,
            referral_code: referral_code
        });
    } catch (error) {
        console.error('Error applying referral code:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

module.exports = {
    register,
    login,
    authenticateToken,
    getUserSettings,
    updateUserSettings,
    applyReferralCode
};
