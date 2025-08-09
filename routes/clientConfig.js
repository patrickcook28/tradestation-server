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
                u.max_loss_per_day, u.max_loss_per_day_enabled,
                u.max_loss_per_trade, u.max_loss_per_trade_enabled,
                u.trade_confirmation as "tradeConfirmation",
                u.show_tooltips as "showTooltips",
                u.cost_basis_data,
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

        await client.query('COMMIT');

        // Construct the full config object
        const config = {
            user: {
                id: userData.id,
                email: userData.email,
                superuser: userData.superuser,
                beta_user: userData.beta_user,
                referral_code: userData.referral_code,
                tradeConfirmation: userData.tradeConfirmation,
                showTooltips: userData.showTooltips
            },
            credentials: {
                access_token: userData.access_token,
                refresh_token: userData.refresh_token,
                expires_in: userData.expires_at,
            },
            settings: {
                maxLossPerDay: userData.max_loss_per_day,
                maxLossPerDayEnabled: userData.max_loss_per_day_enabled,
                maxLossPerTrade: userData.max_loss_per_trade,
                maxLossPerTradeEnabled: userData.max_loss_per_trade_enabled,
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
                tickers: [],
                risk: userData.max_loss_per_trade,
                riskPercentage: userData.max_loss_per_day
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