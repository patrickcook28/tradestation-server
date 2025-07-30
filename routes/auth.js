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
            'INSERT INTO users (email, password, beta_user, referral_code) VALUES ($1, $2, $3, $4) RETURNING *',
            [email, hashedPassword, beta_user, final_referral_code], 
            (error, result) => {
                if(error) {
                    console.error('Database error during user creation:', error);
                    return res.status(400).json({ error: 'Failed to create new user' })
                } else {
                    console.log('Insert result:', result);
                    console.log('Result rows:', result.rows);
                    console.log('Result rows length:', result.rows.length);
                    
                    if (!result.rows || result.rows.length === 0) {
                        console.error('No rows returned from INSERT');
                        return res.status(500).json({ error: 'User created but no data returned' })
                    }
                    
                    const newUser = result.rows[0];
                    console.log('New user data:', newUser);
                    
                    return res.json({ 
                        success: true, 
                        beta_user: beta_user,
                        message: beta_user ? 'Welcome to the beta!' : 'Account created successfully',
                        id: newUser.id,
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
        console.log('Login successful, returning user:', user);
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
            'SELECT max_loss_per_day, max_loss_per_day_enabled, max_loss_per_trade, max_loss_per_trade_enabled, trade_confirmation, show_tooltips, superuser, beta_user, referral_code FROM users WHERE id = $1',
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
            tradeConfirmation: user.trade_confirmation !== false, // Default to true
            showTooltips: user.show_tooltips !== false, // Default to true
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
            maxLossPerTradeEnabled,
            tradeConfirmation,
            showTooltips
        } = req.body;

        const result = await pool.query(
            `UPDATE users SET 
                max_loss_per_day = $1,
                max_loss_per_day_enabled = $2,
                max_loss_per_trade = $3,
                max_loss_per_trade_enabled = $4,
                trade_confirmation = $5,
                show_tooltips = $6
            WHERE id = $7
            RETURNING max_loss_per_day, max_loss_per_day_enabled, max_loss_per_trade, max_loss_per_trade_enabled, trade_confirmation, show_tooltips, superuser, beta_user, referral_code`,
            [maxLossPerDay, maxLossPerDayEnabled, maxLossPerTrade, maxLossPerTradeEnabled, tradeConfirmation, showTooltips, userId]
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
            tradeConfirmation: user.trade_confirmation !== false, // Default to true
            showTooltips: user.show_tooltips !== false, // Default to true
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

// Get user cost basis data
const getCostBasisData = async (req, res) => {
    try {
        const userId = req.user.id;

        const result = await pool.query(
            'SELECT cost_basis_data FROM users WHERE id = $1',
            [userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const costBasisData = result.rows[0].cost_basis_data || {};
        return res.json({ costBasisData });
    } catch (error) {
        logger.error('Error getting cost basis data:', error);
        return res.status(500).json({ error: 'Failed to get cost basis data' });
    }
};

// Update user cost basis data
const updateCostBasisData = async (req, res) => {
    try {
        const userId = req.user.id;
        const { costBasisData } = req.body;

        if (!costBasisData || typeof costBasisData !== 'object') {
            return res.status(400).json({ error: 'Invalid cost basis data format' });
        }

        const result = await pool.query(
            'UPDATE users SET cost_basis_data = $1 WHERE id = $2 RETURNING cost_basis_data',
            [JSON.stringify(costBasisData), userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        return res.json({ 
            success: true,
            costBasisData: result.rows[0].cost_basis_data || {}
        });
    } catch (error) {
        logger.error('Error updating cost basis data:', error);
        return res.status(500).json({ error: 'Failed to update cost basis data' });
    }
};

// Get maintenance mode status
const getMaintenanceMode = async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT is_enabled, message, enabled_at, enabled_by_user_id FROM maintenance_mode ORDER BY id DESC LIMIT 1'
        );

        if (result.rows.length === 0) {
            return res.json({ isEnabled: false, message: 'System is operational' });
        }

        const maintenance = result.rows[0];
        return res.json({
            isEnabled: maintenance.is_enabled,
            message: maintenance.message,
            enabledAt: maintenance.enabled_at,
            enabledByUserId: maintenance.enabled_by_user_id
        });
    } catch (error) {
        logger.error('Error getting maintenance mode:', error);
        return res.status(500).json({ error: 'Failed to get maintenance mode status' });
    }
};

// Update maintenance mode (superuser only)
const updateMaintenanceMode = async (req, res) => {
    try {
        const userId = req.user.id;
        const { isEnabled, message } = req.body;

        // Check if user is superuser
        const userCheck = await pool.query(
            'SELECT superuser FROM users WHERE id = $1',
            [userId]
        );

        if (userCheck.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (!userCheck.rows[0].superuser) {
            return res.status(403).json({ error: 'Only superusers can control maintenance mode' });
        }

        if (isEnabled) {
            // Enable maintenance mode
            await pool.query(`
                UPDATE maintenance_mode 
                SET is_enabled = true, 
                    message = $1, 
                    enabled_by_user_id = $2, 
                    enabled_at = CURRENT_TIMESTAMP,
                    disabled_at = NULL,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = (SELECT id FROM maintenance_mode ORDER BY id DESC LIMIT 1)
            `, [message || 'The application is currently under maintenance. Please try again later.', userId]);
        } else {
            // Disable maintenance mode
            await pool.query(`
                UPDATE maintenance_mode 
                SET is_enabled = false, 
                    disabled_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = (SELECT id FROM maintenance_mode ORDER BY id DESC LIMIT 1)
            `);
        }

        // Get updated status
        const result = await pool.query(
            'SELECT is_enabled, message, enabled_at, enabled_by_user_id FROM maintenance_mode ORDER BY id DESC LIMIT 1'
        );

        const maintenance = result.rows[0];
        return res.json({
            success: true,
            isEnabled: maintenance.is_enabled,
            message: maintenance.message,
            enabledAt: maintenance.enabled_at,
            enabledByUserId: maintenance.enabled_by_user_id
        });
    } catch (error) {
        logger.error('Error updating maintenance mode:', error);
        return res.status(500).json({ error: 'Failed to update maintenance mode' });
    }
};

module.exports = {
    register,
    login,
    authenticateToken,
    getUserSettings,
    updateUserSettings,
    applyReferralCode,
    getCostBasisData,
    updateCostBasisData,
    getMaintenanceMode,
    updateMaintenanceMode
};
