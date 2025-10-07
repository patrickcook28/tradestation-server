const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const crypto = require('crypto');
const { createTransport, buildResetEmail } = require('../config/email');
const logger = require("../config/logging");

const register = async (req, res) => {
    const { email, password, password_confirm, referral_code } = req.body;

    // Enforce moderate password complexity at registration
    const complexity = validatePasswordComplexity(password);
    if (!complexity.valid) {
        return res.status(400).json({ error: complexity.message });
    }

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
            async (error, result) => {
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
                    
                    // Save current password to history
                    try { await pool.query('INSERT INTO password_history (user_id, password_hash) VALUES ($1, $2)', [newUser.id, hashedPassword]); } catch (_) {}
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

    // Enforce the same complexity rule even on login to nudge updates (but do not block legacy)
    // Only warn if clearly too weak to avoid locking out existing users
    const complexity = validatePasswordComplexity(password);
    if (!complexity.valid && complexity.severity === 'weak') {
        // Proceed without blocking login
        console.log('[Auth] Weak password used on login for', email);
    }

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

        let token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { algorithm: 'HS256' })
        console.log('Login successful, returning user:', user);

        // Get subscription status
        const { getSubscriptionStatus } = require('../utils/subscriptionHelpers');
        let subscriptionStatus = null;
        try {
            subscriptionStatus = await getSubscriptionStatus(user.id);
        } catch (err) {
            console.error('Error fetching subscription status in login:', err);
        }

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
            referral_code: user.referral_code,
            subscriptionStatus: subscriptionStatus
        })
    })
};

// Helper: moderate complexity — min 10, upper, lower, digit, special; allow common patterns like Buzzandcash1996!
function validatePasswordComplexity(password) {
    if (typeof password !== 'string') {
        return { valid: false, severity: 'invalid', message: 'Password is required' };
    }
    const minLen = 10;
    const hasUpper = /[A-Z]/.test(password);
    const hasLower = /[a-z]/.test(password);
    const hasDigit = /\d/.test(password);
    const hasSpecial = /[^A-Za-z0-9]/.test(password);
    if (password.length < minLen) return { valid: false, severity: 'block', message: 'Password must be at least 10 characters' };
    if (!hasUpper || !hasLower || !hasDigit || !hasSpecial) return { valid: false, severity: 'block', message: 'Password must include upper, lower, number, and symbol' };
    return { valid: true };
}

// Request password reset
const requestPasswordReset = async (req, res) => {
    try {
        const { email } = req.body;
        const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
        if (!email) return res.status(200).json({ success: true });

        const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (userResult.rows.length === 0) {
            // Always respond the same
            return res.status(200).json({ success: true });
        }

        const userId = userResult.rows[0].id;

        // Optional: simple rate limit per user (max 3 per hour)
        await pool.query(`DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NOT NULL`, [userId]);
        const recent = await pool.query(`
            SELECT count(*) FROM password_resets WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'
        `, [userId]);
        if (Number(recent.rows[0].count) >= Number(process.env.PASSWORD_RESET_RATE_LIMIT_PER_HOUR || 5)) {
            return res.status(200).json({ success: true });
        }

        // Invalidate any previous unused tokens for this user so only the latest works
        await pool.query(
          `UPDATE password_resets SET used_at = NOW(), updated_at = NOW(), invalidated_reason = 'superseded' 
           WHERE user_id = $1 AND used_at IS NULL`, [userId]
        );

        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const ttlMinutes = Number(process.env.RESET_TOKEN_TTL_MINUTES || 15);
        const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

        await pool.query(`
            INSERT INTO password_resets (user_id, token_hash, expires_at, requested_ip)
            VALUES ($1, $2, $3, $4)
        `, [userId, tokenHash, expiresAt, clientIp]);

        const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3002';
        const resetUrl = `${baseUrl}/reset-password?token=${token}`;

        try {
            const transport = createTransport();
            const mail = buildResetEmail({ to: email, resetUrl });
            await transport.sendMail(mail);
        } catch (err) {
            console.error('Failed to send reset email:', err.message);
        }

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error('requestPasswordReset error:', error);
        return res.status(200).json({ success: true });
    }
};

// Reset password
const resetPassword = async (req, res) => {
    try {
        const { token, new_password } = req.body;
        if (!token || !new_password) return res.status(400).json({ error: 'Invalid request' });

        const complexity = validatePasswordComplexity(new_password);
        if (!complexity.valid) return res.status(400).json({ error: complexity.message });

        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const pr = await pool.query(`
            SELECT pr.*, u.id as uid FROM password_resets pr
            JOIN users u ON u.id = pr.user_id
            WHERE pr.token_hash = $1
            ORDER BY pr.created_at DESC
            LIMIT 1
        `, [tokenHash]);

        if (pr.rows.length === 0) return res.status(400).json({ error: 'Invalid or expired token' });
        const row = pr.rows[0];
        if (row.used_at) {
            if (row.invalidated_reason === 'superseded') {
                return res.status(400).json({ error: 'Token superseded by newer request' });
            }
            return res.status(400).json({ error: 'Token already used' });
        }
        if (new Date(row.expires_at).getTime() < Date.now()) return res.status(400).json({ error: 'Token expired' });

        // Prevent reusing last N password hashes (e.g., 5)
        const history = await pool.query('SELECT password_hash FROM password_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5', [row.uid]);
        for (const h of history.rows) {
            const reused = await bcrypt.compare(new_password, h.password_hash);
            if (reused) {
                return res.status(400).json({ error: 'You cannot reuse a recent password' });
            }
        }

        const hashedPassword = await bcrypt.hash(new_password, 8);

        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, row.uid]);
        await pool.query('UPDATE password_resets SET used_at = NOW(), updated_at = NOW() WHERE id = $1', [row.id]);
        // Invalidate other outstanding reset tokens for this user
        await pool.query('DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL', [row.uid]);
        // Insert new hash into password history and prune to last 5
        await pool.query('INSERT INTO password_history (user_id, password_hash) VALUES ($1, $2)', [row.uid, hashedPassword]);
        await pool.query(`
          DELETE FROM password_history
          WHERE user_id = $1
          AND id NOT IN (
            SELECT id FROM password_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5
          )
        `, [row.uid]);

        return res.json({ success: true });
    } catch (error) {
        console.error('resetPassword error:', error);
        return res.status(500).json({ error: 'Failed to reset password' });
    }
};

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token == null) {
    logger.auth(req.method, req.path, 'Token Missing');
    return res.sendStatus(401); // if there isn't any token
  }

  jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] }, (err, user) => {
    if (err) {
      logger.auth(req.method, req.path, 'Failed', null);
      return res.sendStatus(403);
    }
    logger.auth(req.method, req.path, 'Success', user.id);
    req.user = user;
    next();
  });
};

// Get user settings (includes app_settings and account_defaults)
const getUserSettings = async (req, res) => {
    try {
        const userId = req.user.id;
        
        const result = await pool.query(
            `SELECT max_loss_per_day, max_loss_per_day_enabled, max_loss_per_trade, max_loss_per_trade_enabled, 
                    max_loss_per_day_lock_expires_at, max_loss_per_trade_lock_expires_at,
                    trade_confirmation, show_tooltips, superuser, beta_user, referral_code,
                    app_settings, account_defaults,
                    EXISTS(SELECT 1 FROM api_credentials ac WHERE ac.user_id = $1) AS has_tradestation_credentials
             FROM users WHERE id = $1`,
            [userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = result.rows[0];

        // Get subscription status
        const { getSubscriptionStatus } = require('../utils/subscriptionHelpers');
        let subscriptionStatus = null;
        try {
            subscriptionStatus = await getSubscriptionStatus(userId);
        } catch (err) {
            logger.error('Error fetching subscription status in getUserSettings:', err);
        }

        return res.json({
            maxLossPerDay: user.max_loss_per_day || 0,
            maxLossPerDayEnabled: user.max_loss_per_day_enabled || false,
            maxLossPerDayLockExpiresAt: user.max_loss_per_day_lock_expires_at,
            maxLossPerTrade: user.max_loss_per_trade || 0,
            maxLossPerTradeEnabled: user.max_loss_per_trade_enabled || false,
            maxLossPerTradeLockExpiresAt: user.max_loss_per_trade_lock_expires_at,
            tradeConfirmation: user.trade_confirmation !== false, // Default to true
            showTooltips: user.show_tooltips !== false, // Default to true
            superuser: user.superuser || false,
            beta_user: user.beta_user || false,
            referral_code: user.referral_code,
            hasTradeStationCredentials: user.has_tradestation_credentials === true,
            appSettings: user.app_settings || {},
            accountDefaults: user.account_defaults || {},
            subscriptionStatus: subscriptionStatus
        });
    } catch (error) {
        logger.error('Error getting user settings:', error);
        return res.status(500).json({ error: 'Failed to get user settings' });
    }
};

// Update user settings (and optionally app_settings/account_defaults)
const updateUserSettings = async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            maxLossPerDay,
            maxLossPerDayEnabled,
            maxLossPerDayLockExpiresAt,
            maxLossPerTrade,
            maxLossPerTradeEnabled,
            maxLossPerTradeLockExpiresAt,
            tradeConfirmation,
            showTooltips,
            appSettings, // JSON object of global user settings (e.g., showStdDevLines, showLiquidity, showOrders, sessionTemplate)
            accountDefaults, // JSON object keyed by accountId with risk/riskPercentage etc.
        } = req.body;

        const result = await pool.query(
            `UPDATE users SET 
                max_loss_per_day = COALESCE($1, max_loss_per_day),
                max_loss_per_day_enabled = COALESCE($2, max_loss_per_day_enabled),
                max_loss_per_day_lock_expires_at = COALESCE($3, max_loss_per_day_lock_expires_at),
                max_loss_per_trade = COALESCE($4, max_loss_per_trade),
                max_loss_per_trade_enabled = COALESCE($5, max_loss_per_trade_enabled),
                max_loss_per_trade_lock_expires_at = COALESCE($6, max_loss_per_trade_lock_expires_at),
                trade_confirmation = COALESCE($7, trade_confirmation),
                show_tooltips = COALESCE($8, show_tooltips),
                app_settings = COALESCE($9::jsonb, app_settings),
                account_defaults = COALESCE($10::jsonb, account_defaults)
            WHERE id = $11
            RETURNING max_loss_per_day, max_loss_per_day_enabled, max_loss_per_day_lock_expires_at, max_loss_per_trade, max_loss_per_trade_enabled, max_loss_per_trade_lock_expires_at, trade_confirmation, show_tooltips, superuser, beta_user, referral_code, app_settings, account_defaults`,
            [maxLossPerDay, maxLossPerDayEnabled, maxLossPerDayLockExpiresAt, maxLossPerTrade, maxLossPerTradeEnabled, maxLossPerTradeLockExpiresAt, tradeConfirmation, showTooltips, appSettings ? JSON.stringify(appSettings) : null, accountDefaults ? JSON.stringify(accountDefaults) : null, userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = result.rows[0];
        return res.json({
            maxLossPerDay: user.max_loss_per_day || 0,
            maxLossPerDayEnabled: user.max_loss_per_day_enabled || false,
            maxLossPerDayLockExpiresAt: user.max_loss_per_day_lock_expires_at,
            maxLossPerTrade: user.max_loss_per_trade || 0,
            maxLossPerTradeEnabled: user.max_loss_per_trade_enabled || false,
            maxLossPerTradeLockExpiresAt: user.max_loss_per_trade_lock_expires_at,
            tradeConfirmation: user.trade_confirmation !== false, // Default to true
            showTooltips: user.show_tooltips !== false, // Default to true
            superuser: user.superuser || false,
            beta_user: user.beta_user || false,
            referral_code: user.referral_code,
            appSettings: user.app_settings || {},
            accountDefaults: user.account_defaults || {},
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
    updateMaintenanceMode,
    requestPasswordReset,
    resetPassword
};
