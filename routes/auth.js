const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const crypto = require('crypto');
const { createTransport, buildResetEmail, buildVerificationCodeEmail } = require('../config/email');
const logger = require("../config/logging");

const register = async (req, res) => {
    const { email, password, password_confirm, referral_code, registration_source } = req.body;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    
    // Log registration source for debugging
    logger.info(`Registration attempt for ${email}, registration_source:`, registration_source);
    
    // Normalize email to lowercase
    const normalizedEmail = email.toLowerCase().trim();

    // Enforce moderate password complexity at registration
    const complexity = validatePasswordComplexity(password);
    if (!complexity.valid) {
        return res.status(400).json({ error: complexity.message });
    }

    pool.query('SELECT email, email_verified FROM users WHERE LOWER(email) = $1', [normalizedEmail], async (error, result) => {
        if(error){
            return res.status(400).json({ error: 'Failed to check if user exists' })
        } else if( result.rows.length > 0 ) {
            // If user exists but email is not verified, allow them to get a new verification code
            if (!result.rows[0].email_verified) {
                // Generate new verification code
                const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
                
                try {
                    // Store new verification code
                    const insertResult = await pool.query(
                        `INSERT INTO email_verification_codes (email, code, expires_at, ip_address) 
                         VALUES ($1, $2, NOW() + INTERVAL '15 minutes', $3) 
                         RETURNING expires_at`,
                        [normalizedEmail, verificationCode, clientIp]
                    );
                    
                    logger.info(`New verification code ${verificationCode} generated for unverified user ${normalizedEmail}`);
                    
                    // Send verification email
                    const transport = createTransport();
                    const mail = buildVerificationCodeEmail({ to: normalizedEmail, code: verificationCode });
                    await transport.sendMail(mail);
                    
                    logger.info(`Verification email resent to unverified user ${normalizedEmail}`);
                    
                    return res.json({ 
                        success: true, 
                        requiresVerification: true,
                        email: normalizedEmail,
                        message: 'Account exists but not verified. New verification code sent to your email.'
                    });
                } catch (emailError) {
                    console.error('Error sending verification email:', emailError);
                    return res.status(500).json({ error: 'Failed to send verification email' });
                }
            }
            
            // Email is already in use and verified
            return res.status(400).json({ error: 'Email is already in use' })
        } else if(password !== password_confirm) {
            return res.status(400).json({ error: 'Password Didn\'t Match!'})
        }

        let hashedPassword = await bcrypt.hash(password, 8)
        let beta_user = false
        let early_access = true  // All new users get early access
        let final_referral_code = null
        const earlyAccessStartTime = new Date();

        // If referral code is provided, validate it and set beta_user to true for backward compatibility
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

        // Capture legal acceptance timestamp
        const acceptanceTimestamp = new Date();

        // Prepare registration_source JSONB data
        // Handle both object and string formats (in case it's already stringified)
        let registrationSourceData = null;
        if (registration_source) {
            if (typeof registration_source === 'string') {
                // Already a string, use as-is
                try {
                    JSON.parse(registration_source); // Validate it's valid JSON
                    registrationSourceData = registration_source;
                } catch (e) {
                    logger.warn(`Invalid JSON string for registration_source: ${registration_source}`);
                }
            } else if (typeof registration_source === 'object' && Object.keys(registration_source).length > 0) {
                // Object, stringify it
                registrationSourceData = JSON.stringify(registration_source);
            }
        }
        
        logger.info(`Registration source for ${normalizedEmail}:`, {
            raw: registration_source,
            type: typeof registration_source,
            stringified: registrationSourceData
        });

        pool.query(
            'INSERT INTO users (email, password, beta_user, referral_code, early_access, early_access_started_at, tos_accepted_at, privacy_policy_accepted_at, risk_disclosure_accepted_at, registration_source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *',
            [normalizedEmail, hashedPassword, beta_user, final_referral_code, early_access, earlyAccessStartTime, acceptanceTimestamp, acceptanceTimestamp, acceptanceTimestamp, registrationSourceData], 
            async (error, result) => {
                if(error) {
                    console.error('Database error during user creation:', error);
                    return res.status(400).json({ error: 'Failed to create new user' })
                } else {
                    if (!result.rows || result.rows.length === 0) {
                        console.error('No rows returned from INSERT');
                        return res.status(500).json({ error: 'User created but no data returned' })
                    }
                    
                    const newUser = result.rows[0];
                    
                    // Save current password to history
                    try { await pool.query('INSERT INTO password_history (user_id, password_hash) VALUES ($1, $2)', [newUser.id, hashedPassword]); } catch (_) {}
                    
                    // Create beta tracking record for early access users
                    if (early_access) {
                        try {
                            await pool.query(
                                'INSERT INTO beta_tracking (user_id, email, started_at) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING',
                                [newUser.id, normalizedEmail, earlyAccessStartTime]
                            );
                        } catch (err) {
                            console.error('Error creating beta tracking record:', err);
                        }
                    }
                    
                    // Generate 6-digit verification code
                    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
                    
                    try {
                        // Store verification code with normalized email - use PostgreSQL NOW() to avoid timezone issues
                        const insertResult = await pool.query(
                            `INSERT INTO email_verification_codes (email, code, expires_at, ip_address) 
                             VALUES ($1, $2, NOW() + INTERVAL '15 minutes', $3) 
                             RETURNING expires_at`,
                            [normalizedEmail, verificationCode, clientIp]
                        );
                        
                        logger.info(`Verification code ${verificationCode} generated and stored for ${normalizedEmail}, expires at ${insertResult.rows[0].expires_at}`);
                        
                        // Send verification email
                        const transport = createTransport();
                        const mail = buildVerificationCodeEmail({ to: normalizedEmail, code: verificationCode });
                        await transport.sendMail(mail);
                        
                        logger.info(`Verification email sent successfully to ${normalizedEmail}`);
                    } catch (emailError) {
                        console.error('Error with verification code/email:', emailError);
                        logger.error('Verification error details:', emailError);
                        
                        // Check if table exists
                        if (emailError.message && emailError.message.includes('email_verification_codes')) {
                            console.error('⚠️  email_verification_codes table does not exist. Please run migrations.');
                        }
                        // Don't fail registration if email fails - but log it
                    }
                    
                    return res.json({ 
                        success: true, 
                        requiresVerification: true,
                        email: normalizedEmail,
                        message: 'Verification code sent to your email'
                    })
                }
            }
        )        
    })
};

const login = async (req, res) => {
    const { email, password, login_source } = req.body;
    
    // Normalize email to lowercase for case-insensitive comparison
    const normalizedEmail = email.toLowerCase().trim();

    // Enforce the same complexity rule even on login to nudge updates (but do not block legacy)
    // Only warn if clearly too weak to avoid locking out existing users
    const complexity = validatePasswordComplexity(password);
    if (!complexity.valid && complexity.severity === 'weak') {
        // Proceed without blocking login
        console.log('[Auth] Weak password used on login for', normalizedEmail);
    }

    pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [normalizedEmail], async (error, result) => {
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
        
        // Check if email is verified
        if (!user.email_verified) {
            return res.status(403).json({ 
                error: 'Please verify your email before logging in',
                requiresVerification: true,
                email: user.email
            })
        }

        let token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { algorithm: 'HS256' })

        // Get subscription status
        const { getSubscriptionStatus } = require('../utils/subscriptionHelpers');
        let subscriptionStatus = null;
        try {
            subscriptionStatus = await getSubscriptionStatus(user.id);
        } catch (err) {
            console.error('Error fetching subscription status in login:', err);
        }

        // Update registration_source if login_source is provided and user doesn't have one yet
        // This handles cases where user registered before source tracking was implemented
        if (login_source && Object.keys(login_source).length > 0 && !user.registration_source) {
            try {
                await pool.query(
                    'UPDATE users SET registration_source = $1 WHERE id = $2',
                    [JSON.stringify(login_source), user.id]
                );
            } catch (err) {
                // Don't fail login if source update fails
                console.error('Error updating registration_source on login:', err);
            }
        }

        return res.json({
            token,
            id: user.id,
            email: user.email,
            superuser: user.superuser || false,
            beta_user: user.beta_user || false,
            early_access: user.early_access || false,
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
        
        // Normalize email to lowercase
        const normalizedEmail = email.toLowerCase().trim();

        const userResult = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
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
            const mail = buildResetEmail({ to: normalizedEmail, resetUrl });
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

// Optional authentication - extracts user if token is present, but doesn't fail if missing
const optionalAuthenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token == null) {
    // No token provided - continue without setting req.user
    return next();
  }

  jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] }, (err, user) => {
    if (err) {
      // Invalid token - continue without setting req.user
      return next();
    }
    // Valid token - set req.user
    req.user = user;
    next();
  });
};

// Get user settings (includes app_settings and account_defaults)
const getUserSettings = async (req, res) => {
    try {
        const userId = req.user.id;
        
        const result = await pool.query(
            `SELECT id, email, trade_confirmation, show_tooltips, email_alerts_enabled, superuser, beta_user, early_access, early_access_started_at, referral_code,
                    app_settings, account_defaults, cost_basis_data,
                    tos_accepted_at, privacy_policy_accepted_at, risk_disclosure_accepted_at,
                    EXISTS(SELECT 1 FROM api_credentials ac WHERE ac.user_id = $1) AS has_tradestation_credentials
             FROM users WHERE id = $1`,
            [userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = result.rows[0];
        
        // Get ALL loss limit locks (expired or not) - monitoring continues until explicitly disabled
        const locksResult = await pool.query(`
            SELECT account_id, limit_type, threshold_amount, expires_at
            FROM loss_limit_locks
            WHERE user_id = $1
        `, [userId]);

        // Get subscription status
        const { getSubscriptionStatus } = require('../utils/subscriptionHelpers');
        let subscriptionStatus = null;
        try {
            subscriptionStatus = await getSubscriptionStatus(userId);
        } catch (err) {
            logger.error('Error fetching subscription status in getUserSettings:', err);
        }

        // Get maintenance status
        let maintenanceStatus = { isEnabled: false, message: 'System is operational' };
        try {
            const maintenanceResult = await pool.query(
                'SELECT is_enabled, message, enabled_at, enabled_by_user_id FROM maintenance_mode ORDER BY id DESC LIMIT 1'
            );
            if (maintenanceResult.rows.length > 0) {
                const m = maintenanceResult.rows[0];
                maintenanceStatus = {
                    isEnabled: m.is_enabled,
                    message: m.message,
                    enabledAt: m.enabled_at,
                    enabledByUserId: m.enabled_by_user_id
                };
            }
        } catch (err) {
            logger.error('Error fetching maintenance status in getUserSettings:', err);
        }

        // Get ticker options
        const { getCommonFuturesContracts } = require('../utils/contractSymbols');
        const futuresContracts = getCommonFuturesContracts();
        
        const commonStocks = [
            { symbol: 'AAPL', name: 'Apple Inc.' },
            { symbol: 'MSFT', name: 'Microsoft Corporation' },
            { symbol: 'GOOGL', name: 'Alphabet Inc.' },
            { symbol: 'AMZN', name: 'Amazon.com Inc.' },
            { symbol: 'TSLA', name: 'Tesla Inc.' },
            { symbol: 'NVDA', name: 'NVIDIA Corporation' },
            { symbol: 'META', name: 'Meta Platforms Inc.' },
            { symbol: 'SPY', name: 'SPDR S&P 500 ETF' },
            { symbol: 'QQQ', name: 'Invesco QQQ Trust' },
            { symbol: 'IWM', name: 'iShares Russell 2000 ETF' }
        ];
        
        const tickerOptions = [
            ...futuresContracts.map(f => ({
                value: f.currentContract,
                label: `${f.currentContract} - ${f.name}`,
                type: 'futures'
            })),
            ...commonStocks.map(s => ({
                value: s.symbol,
                label: `${s.symbol} - ${s.name}`,
                type: 'stock'
            }))
        ];

        // Build accountSettings by combining account_defaults with active loss_limit_locks
        const accountDefaults = user.account_defaults || {};
        const accountSettings = {};
        
        // Start with account_defaults (risk, riskPercentage, isPaperTrading)
        for (const [accountId, settings] of Object.entries(accountDefaults)) {
            accountSettings[accountId] = { ...settings };
        }
        
        // Merge in active loss limits from loss_limit_locks
        for (const lock of locksResult.rows) {
            const accountId = lock.account_id;
            
            // Ensure account entry exists
            if (!accountSettings[accountId]) {
                accountSettings[accountId] = {};
                // Infer isPaperTrading
                accountSettings[accountId].isPaperTrading = accountId.startsWith('SIM');
            }
            
            const threshold = parseFloat(lock.threshold_amount);
            
            if (lock.limit_type === 'daily') {
                accountSettings[accountId].maxLossPerDay = threshold;
                accountSettings[accountId].maxLossPerDayEnabled = true;
            } else if (lock.limit_type === 'trade') {
                accountSettings[accountId].maxLossPerPosition = threshold;
                accountSettings[accountId].maxLossPerPositionEnabled = true;
            }
        }

        return res.json({
            id: user.id,
            email: user.email,
            tradeConfirmation: user.trade_confirmation !== false, // Default to true
            showTooltips: user.show_tooltips !== false, // Default to true
            emailAlertsEnabled: user.email_alerts_enabled || false,
            superuser: user.superuser || false,
            beta_user: user.beta_user || false,
            early_access: user.early_access || false,
            early_access_started_at: user.early_access_started_at,
            referral_code: user.referral_code,
            hasTradeStationCredentials: user.has_tradestation_credentials === true,
            appSettings: user.app_settings || {},
            accountSettings: accountSettings,  // Renamed from accountDefaults, now combines both sources
            subscriptionStatus: subscriptionStatus,
            costBasisData: user.cost_basis_data || {},
            maintenanceStatus: maintenanceStatus,
            tickerOptions: { success: true, suggestions: tickerOptions },
            legalAcceptance: {
                tosAcceptedAt: user.tos_accepted_at,
                privacyPolicyAcceptedAt: user.privacy_policy_accepted_at,
                riskDisclosureAcceptedAt: user.risk_disclosure_accepted_at
            }
        });
    } catch (error) {
        logger.error('Error getting user settings:', error);
        return res.status(500).json({ error: 'Failed to get user settings' });
    }
};

// Update user settings (NOTE: Loss limits are managed via /loss_limits endpoint, not here)
const updateUserSettings = async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            tradeConfirmation,
            showTooltips,
            emailAlertsEnabled,
            appSettings, // JSON object of global user settings (e.g., showStdDevLines, showLiquidity, showOrders, sessionTemplate)
            accountDefaults, // JSON object keyed by accountId with risk/riskPercentage/isPaperTrading (no loss limits here)
        } = req.body;

        const result = await pool.query(
            `UPDATE users SET 
                trade_confirmation = COALESCE($1, trade_confirmation),
                show_tooltips = COALESCE($2, show_tooltips),
                email_alerts_enabled = COALESCE($3, email_alerts_enabled),
                app_settings = COALESCE($4::jsonb, app_settings),
                account_defaults = COALESCE($5::jsonb, account_defaults)
            WHERE id = $6
            RETURNING trade_confirmation, show_tooltips, email_alerts_enabled, superuser, beta_user, referral_code, app_settings, account_defaults`,
            [tradeConfirmation, showTooltips, emailAlertsEnabled, appSettings ? JSON.stringify(appSettings) : null, accountDefaults ? JSON.stringify(accountDefaults) : null, userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = result.rows[0];
        
        // Get active loss limit locks to merge into response
        const locksResult = await pool.query(`
            SELECT account_id, limit_type, threshold_amount, expires_at
            FROM loss_limit_locks
            WHERE user_id = $1
        `, [userId]);
        
        // Build accountSettings by combining account_defaults with loss_limit_locks
        const userAccountDefaults = user.account_defaults || {};
        const accountSettings = {};
        
        for (const [accountId, settings] of Object.entries(userAccountDefaults)) {
            accountSettings[accountId] = { ...settings };
        }
        
        for (const lock of locksResult.rows) {
            const accountId = lock.account_id;
            if (!accountSettings[accountId]) {
                accountSettings[accountId] = {};
                accountSettings[accountId].isPaperTrading = accountId.startsWith('SIM');
            }
            
            const threshold = parseFloat(lock.threshold_amount);
            if (lock.limit_type === 'daily') {
                accountSettings[accountId].maxLossPerDay = threshold;
                accountSettings[accountId].maxLossPerDayEnabled = true;
            } else if (lock.limit_type === 'trade') {
                accountSettings[accountId].maxLossPerPosition = threshold;
                accountSettings[accountId].maxLossPerPositionEnabled = true;
            }
        }
        
        return res.json({
            tradeConfirmation: user.trade_confirmation !== false, // Default to true
            showTooltips: user.show_tooltips !== false, // Default to true
            emailAlertsEnabled: user.email_alerts_enabled || false,
            superuser: user.superuser || false,
            beta_user: user.beta_user || false,
            early_access: user.early_access || false,
            referral_code: user.referral_code,
            appSettings: user.app_settings || {},
            accountSettings: accountSettings, // Combined view with loss limits from locks
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

// Set account-specific lockout
const setAccountLossLimitLockout = async (req, res) => {
    try {
        const userId = req.user.id;
        const { accountId, isPaperTrading, lockoutType, lockExpiresAt } = req.body;

        if (!accountId || !lockoutType) {
            return res.status(400).json({ error: 'Account ID and lockout type are required' });
        }

        // Get current account defaults
        const currentResult = await pool.query(
            'SELECT account_defaults FROM users WHERE id = $1',
            [userId]
        );

        if (currentResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const currentAccountDefaults = currentResult.rows[0].account_defaults || {};
        const accountKey = `${accountId}_${isPaperTrading ? 'paper' : 'live'}`;
        
        // Update the specific account's lockout settings
        const updatedAccountDefaults = {
            ...currentAccountDefaults,
            [accountKey]: {
                ...currentAccountDefaults[accountKey],
                [`${lockoutType}LockExpiresAt`]: lockExpiresAt
            }
        };

        // Update the database
        const result = await pool.query(
            'UPDATE users SET account_defaults = $1 WHERE id = $2 RETURNING account_defaults',
            [JSON.stringify(updatedAccountDefaults), userId]
        );

        return res.json({ 
            success: true, 
            accountDefaults: result.rows[0].account_defaults 
        });
    } catch (error) {
        logger.error('Error setting account loss limit lockout:', error);
        return res.status(500).json({ error: 'Failed to set account loss limit lockout' });
    }
};

// Verify email with code
const verifyEmail = async (req, res) => {
    try {
        const { email, code } = req.body;
        
        if (!email || !code) {
            return res.status(400).json({ error: 'Email and code are required' });
        }
        
        // Normalize email to lowercase for case-insensitive comparison
        const normalizedEmail = email.toLowerCase().trim();
        const trimmedCode = code.trim();
        
        logger.info(`Verifying email: ${normalizedEmail} with code: ${trimmedCode}`);
        
        // First, check if there are ANY codes for this email (case-insensitive)
        const allCodesResult = await pool.query(
            'SELECT id, code, verified, expires_at, attempts, created_at FROM email_verification_codes WHERE LOWER(email) = $1 ORDER BY created_at DESC',
            [normalizedEmail]
        );
        
        logger.info(`Found ${allCodesResult.rows.length} codes for ${normalizedEmail}`);
        if (allCodesResult.rows.length > 0) {
            const latestCode = allCodesResult.rows[0];
            const now = new Date();
            const expiresAt = new Date(latestCode.expires_at);
            const isExpired = expiresAt < now;
            logger.info(`Latest code details:`, {
                code: latestCode.code,
                codeMatch: latestCode.code === trimmedCode,
                verified: latestCode.verified,
                expires_at: latestCode.expires_at,
                isExpired: isExpired,
                attempts: latestCode.attempts,
                created_at: latestCode.created_at
            });
        }
        
        // Find the most recent valid code for this email (case-insensitive email comparison)
        const codeResult = await pool.query(
            `SELECT * FROM email_verification_codes 
             WHERE LOWER(email) = $1 AND code = $2 AND verified = FALSE AND expires_at > NOW()
             ORDER BY created_at DESC 
             LIMIT 1`,
            [normalizedEmail, trimmedCode]
        );
        
        if (codeResult.rows.length === 0) {
            // Check if code exists but is expired or already verified (case-insensitive)
            const expiredOrUsedResult = await pool.query(
                'SELECT * FROM email_verification_codes WHERE LOWER(email) = $1 AND code = $2 ORDER BY created_at DESC LIMIT 1',
                [normalizedEmail, trimmedCode]
            );
            
            if (expiredOrUsedResult.rows.length > 0) {
                const record = expiredOrUsedResult.rows[0];
                if (record.verified) {
                    return res.status(400).json({ error: 'This code has already been used' });
                }
                if (new Date(record.expires_at) < new Date()) {
                    return res.status(400).json({ error: 'This code has expired. Please request a new one.' });
                }
            }
            
            // Increment attempts for any matching code (case-insensitive)
            await pool.query(
                'UPDATE email_verification_codes SET attempts = attempts + 1 WHERE LOWER(email) = $1 AND code = $2',
                [normalizedEmail, trimmedCode]
            );
            
            logger.warn(`Invalid verification attempt for ${normalizedEmail} with code ${trimmedCode}`);
            return res.status(400).json({ error: 'Invalid verification code' });
        }
        
        const verificationRecord = codeResult.rows[0];
        
        // Check attempts (max 5)
        if (verificationRecord.attempts >= 5) {
            return res.status(429).json({ error: 'Too many verification attempts. Please request a new code.' });
        }
        
        // Mark code as verified
        await pool.query(
            'UPDATE email_verification_codes SET verified = TRUE, verified_at = NOW() WHERE id = $1',
            [verificationRecord.id]
        );
        
        // Mark user email as verified (case-insensitive)
        const userResult = await pool.query(
            'UPDATE users SET email_verified = TRUE, email_verified_at = NOW() WHERE LOWER(email) = $1 RETURNING *',
            [normalizedEmail]
        );
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const user = userResult.rows[0];
        logger.info(`Email verified successfully for ${normalizedEmail}`);
        
        // Send early access welcome email if user has early access
        // Only send if this is a new account setup (email just verified)
        if (user.early_access) {
            try {
                const { createTransport } = require('../config/email');
                const { buildEmailFromTemplate } = require('../config/emailTemplates');
                
                const transport = createTransport();
                const mailOptions = buildEmailFromTemplate('early_access_onboarding', {
                    to: normalizedEmail
                });
                await transport.sendMail(mailOptions);
                logger.info(`Early access welcome email sent to ${normalizedEmail} using template: early_access_onboarding`);
            } catch (emailError) {
                // Don't fail the verification if email fails
                logger.error('Failed to send early access welcome email:', emailError);
            }
        }
        
        return res.json({ 
            success: true, 
            message: 'Email verified successfully!',
            email: normalizedEmail
        });
    } catch (error) {
        logger.error('Error verifying email:', error);
        return res.status(500).json({ error: 'Failed to verify email' });
    }
};

// Resend verification code
const resendVerificationCode = async (req, res) => {
    try {
        const { email } = req.body;
        const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
        
        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }
        
        // Normalize email to lowercase for case-insensitive comparison
        const normalizedEmail = email.toLowerCase().trim();
        
        // Check if user exists (case-insensitive)
        const userResult = await pool.query('SELECT email_verified FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        if (userResult.rows[0].email_verified) {
            return res.status(400).json({ error: 'Email already verified' });
        }
        
        // Rate limiting: Check how many codes sent in last hour (case-insensitive)
        const recentCodesResult = await pool.query(
            'SELECT COUNT(*) as count FROM email_verification_codes WHERE LOWER(email) = $1 AND created_at > NOW() - INTERVAL \'1 hour\'',
            [normalizedEmail]
        );
        
        if (parseInt(recentCodesResult.rows[0].count) >= 5) {
            return res.status(429).json({ error: 'Too many verification codes requested. Please try again in an hour.' });
        }
        
        // Generate new 6-digit code
        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        
        // Store verification code with normalized email - use PostgreSQL NOW() to avoid timezone issues
        const insertResult = await pool.query(
            `INSERT INTO email_verification_codes (email, code, expires_at, ip_address) 
             VALUES ($1, $2, NOW() + INTERVAL '15 minutes', $3) 
             RETURNING expires_at`,
            [normalizedEmail, verificationCode, clientIp]
        );
        
        logger.info(`Verification code ${verificationCode} generated for ${normalizedEmail}, expires at ${insertResult.rows[0].expires_at}`);
        
        // Send verification email
        try {
            const transport = createTransport();
            const mail = buildVerificationCodeEmail({ to: normalizedEmail, code: verificationCode });
            await transport.sendMail(mail);
            
            logger.info(`Verification code resent successfully to ${normalizedEmail}`);
        } catch (emailError) {
            console.error('Error sending verification email:', emailError);
            return res.status(500).json({ error: 'Failed to send verification email' });
        }
        
        return res.json({ 
            success: true, 
            message: 'Verification code sent to your email'
        });
    } catch (error) {
        logger.error('Error resending verification code:', error);
        return res.status(500).json({ error: 'Failed to resend verification code' });
    }
};

// Update user early access status (superuser only)
const updateEarlyAccessStatus = async (req, res) => {
    try {
        const requestingUserId = req.user.id;
        const { userId, earlyAccess } = req.body;

        if (!userId || earlyAccess === undefined) {
            return res.status(400).json({ error: 'User ID and early access status are required' });
        }

        // Check if requesting user is superuser
        const superuserCheck = await pool.query(
            'SELECT superuser FROM users WHERE id = $1',
            [requestingUserId]
        );

        if (superuserCheck.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (!superuserCheck.rows[0].superuser) {
            return res.status(403).json({ error: 'Only superusers can update early access status' });
        }

        // Update the target user's early access status
        const timestamp = earlyAccess ? new Date() : null;
        await pool.query(
            'UPDATE users SET early_access = $1, early_access_started_at = $2 WHERE id = $3',
            [earlyAccess, timestamp, userId]
        );

        logger.info(`Superuser ${requestingUserId} updated early access for user ${userId} to ${earlyAccess}`);
        
        res.json({ 
            success: true, 
            message: `Early access ${earlyAccess ? 'granted' : 'revoked'} successfully` 
        });
    } catch (error) {
        logger.error('Error updating early access status:', error);
        res.status(500).json({ error: 'Failed to update early access status' });
    }
};

module.exports = {
    register,
    login,
    authenticateToken,
    optionalAuthenticateToken,
    getUserSettings,
    updateUserSettings,
    setAccountLossLimitLockout,
    applyReferralCode,
    getCostBasisData,
    updateCostBasisData,
    getMaintenanceMode,
    updateMaintenanceMode,
    requestPasswordReset,
    resetPassword,
    updateEarlyAccessStatus,
    verifyEmail,
    resendVerificationCode
};
