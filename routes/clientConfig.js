const pool = require('../db');
const logger = require('../config/logging');

const getInitialConfig = async (req, res) => {
    const client = await pool.connect();
    
    try {
        const { user_id } = req.user;
        await client.query('BEGIN');

        // Get all user data in one query
        const userQuery = `
            SELECT 
                u.id, u.email, u.superuser, u.beta_user, u.referral_code,
                u.trade_confirmation as "tradeConfirmation",
                u.show_tooltips as "showTooltips",
                u.cost_basis_data,
                u.account_defaults,
                u.app_settings,
                ts.access_token, ts.refresh_token, ts.expires_at,
                m.is_enabled as maintenance_enabled, m.message as maintenance_message,
                (SELECT json_agg(ta.*) 
                 FROM trade_alerts ta 
                 WHERE ta.user_id = u.id 
                 ORDER BY ta.created_at DESC) as alerts
            FROM users u
            LEFT JOIN tradestation_credentials ts ON ts.user_id = u.id
            CROSS JOIN (SELECT is_enabled, message FROM maintenance_mode LIMIT 1) m
            WHERE u.id = $1
        `;

        const result = await client.query(userQuery, [user_id]);
        const userData = result.rows[0];

        if (!userData) {
            throw new Error('User not found');
        }
        
        // Get ALL loss limit locks (expired or not) - monitoring continues until explicitly disabled
        const locksResult = await client.query(`
            SELECT account_id, limit_type, threshold_amount, expires_at
            FROM loss_limit_locks
            WHERE user_id = $1
        `, [user_id]);

        await client.query('COMMIT');

        // Build accountSettings by combining account_defaults with active loss_limit_locks
        const accountDefaults = userData.account_defaults || {};
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
        
        // Construct the full config object (do not return decrypted TradeStation tokens to the client)
        const config = {
            user: {
                id: userData.id,
                email: userData.email,
                superuser: userData.superuser,
                beta_user: userData.beta_user,
                referral_code: userData.referral_code,
                tradeConfirmation: userData.tradeConfirmation,
                showTooltips: userData.showTooltips,
                hasTradeStationCredentials: Boolean(userData.access_token),
                appSettings: userData.app_settings || {},
                accountSettings: accountSettings  // Renamed from accountDefaults
            },
            settings: {
                costBasis: userData.cost_basis_data || {},
                tooltipsEnabled: userData.showTooltips,
                tradeConfirmationEnabled: userData.tradeConfirmation
            },
            alerts: userData.alerts || [],
            maintenance: {
                isEnabled: userData.maintenance_enabled,
                message: userData.maintenance_message || 'System is operational'
            },
            trading: {
                balances: [],
                selectedAccount: null,
                selectedTicker: 'SPY',
                selectedTickerDetails: null,
                isPaperTrading: true,
                currentStopLossOrders: null,
                accounts: [],
                orders: [],
                positions: [],
                isLoading: false,
                tickers: []
            }
        };

        res.json({ success: true, config });
    } catch (error) {
        await client.query('ROLLBACK');
        logger.error('Error fetching client config:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to fetch client configuration' 
        });
    } finally {
        client.release();
    }
};

// Export the route handlers
const clientConfigRoutes = {
    getInitialConfig
};

module.exports = clientConfigRoutes;