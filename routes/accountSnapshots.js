const pool = require('../db');
const { tradestationRequest } = require('../utils/tradestationProxy');
const { encryptToken, decryptToken } = require('../utils/secureCredentials');
const logger = require('../config/logging');

/**
 * Captures a snapshot of all accounts for a given user
 * This includes fetching the list of accounts and their balances
 */
async function captureAccountSnapshot(req, res) {
  const userId = req.user.id;
  
  try {
    logger.info(`[Account Snapshot] Starting snapshot capture for user ${userId}`);
    
    // Step 1: Fetch list of accounts for both paper trading and live trading
    const allAccounts = [];
    
    // Fetch live accounts
    const liveAccountsResult = await tradestationRequest(userId, {
      method: 'GET',
      path: '/brokerage/accounts',
      paperTrading: false,
    });
    
    if (liveAccountsResult.ok && liveAccountsResult.data?.Accounts) {
      const liveAccounts = liveAccountsResult.data.Accounts.map(acc => ({ ...acc, isPaperTrading: false }));
      allAccounts.push(...liveAccounts);
      logger.info(`[Account Snapshot] Found ${liveAccounts.length} live accounts for user ${userId}`);
    } else {
      logger.warn(`[Account Snapshot] Failed to fetch live accounts for user ${userId}:`, liveAccountsResult.status);
    }
    
    // Fetch paper trading accounts
    const paperAccountsResult = await tradestationRequest(userId, {
      method: 'GET',
      path: '/brokerage/accounts',
      paperTrading: true,
    });
    
    if (paperAccountsResult.ok && paperAccountsResult.data?.Accounts) {
      const paperAccounts = paperAccountsResult.data.Accounts.map(acc => ({ ...acc, isPaperTrading: true }));
      allAccounts.push(...paperAccounts);
      logger.info(`[Account Snapshot] Found ${paperAccounts.length} paper trading accounts for user ${userId}`);
    } else {
      logger.warn(`[Account Snapshot] Failed to fetch paper trading accounts for user ${userId}:`, paperAccountsResult.status);
    }
    
    if (allAccounts.length === 0) {
      logger.warn(`[Account Snapshot] No accounts found for user ${userId}`);
      return res.status(200).json({
        success: true,
        message: 'No accounts to snapshot',
        snapshots: []
      });
    }
    
    logger.info(`[Account Snapshot] Total accounts to snapshot: ${allAccounts.length} (live + paper)`);
    
    // Step 2: Fetch balances for each account and store snapshot
    const snapshots = [];
    const errors = [];
    
    for (const account of allAccounts) {
      try {
        const accountId = account.AccountID;
        const isPaperTrading = account.isPaperTrading || false;
        logger.info(`[Account Snapshot] Fetching balances for account ${accountId} (${isPaperTrading ? 'Paper' : 'Live'})`);
        
        const balancesResult = await tradestationRequest(userId, {
          method: 'GET',
          path: `/brokerage/accounts/${accountId}/balances`,
          paperTrading: isPaperTrading,
        });
        
        if (!balancesResult.ok) {
          logger.error(`[Account Snapshot] Failed to fetch balances for account ${accountId}:`, balancesResult.status);
          errors.push({
            accountId,
            isPaperTrading,
            error: 'Failed to fetch balances',
            status: balancesResult.status
          });
          continue;
        }
        
        const balanceData = balancesResult.data?.Balances?.[0];
        if (!balanceData) {
          logger.warn(`[Account Snapshot] No balance data for account ${accountId}`);
          errors.push({
            accountId,
            isPaperTrading,
            error: 'No balance data returned'
          });
          continue;
        }
        
        // Step 3: Encrypt the full balance data
        const encryptedBalanceData = encryptToken(JSON.stringify(balanceData));
        
        // Step 4: Extract summary fields (non-sensitive)
        const equity = parseFloat(balanceData.Equity) || null;
        const todaysProfitLoss = parseFloat(balanceData.TodaysProfitLoss) || null;
        const dayTrades = parseInt(balanceData.BalanceDetail?.DayTrades) || null;
        
        // Step 5: Store the snapshot
        const now = new Date();
        const snapshotDate = now.toISOString().split('T')[0]; // YYYY-MM-DD
        const snapshotTime = now.toTimeString().split(' ')[0]; // HH:MM:SS
        
        const insertQuery = `
          INSERT INTO account_snapshots (
            user_id, 
            account_id, 
            account_type, 
            snapshot_date, 
            snapshot_time,
            balance_data_encrypted,
            equity,
            todays_profit_loss,
            day_trades,
            is_paper_trading
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (user_id, account_id, snapshot_date, is_paper_trading)
          DO UPDATE SET
            snapshot_time = EXCLUDED.snapshot_time,
            balance_data_encrypted = EXCLUDED.balance_data_encrypted,
            equity = EXCLUDED.equity,
            todays_profit_loss = EXCLUDED.todays_profit_loss,
            day_trades = EXCLUDED.day_trades,
            created_at = NOW()
          RETURNING id
        `;
        
        const result = await pool.query(insertQuery, [
          userId,
          accountId,
          balanceData.AccountType,
          snapshotDate,
          snapshotTime,
          encryptedBalanceData,
          equity,
          todaysProfitLoss,
          dayTrades,
          isPaperTrading
        ]);
        
        logger.info(`[Account Snapshot] Stored snapshot ${result.rows[0].id} for account ${accountId} (${isPaperTrading ? 'Paper' : 'Live'})`);
        
        snapshots.push({
          snapshotId: result.rows[0].id,
          accountId,
          accountType: balanceData.AccountType,
          isPaperTrading,
          equity,
          todaysProfitLoss,
          dayTrades,
          snapshotDate,
          snapshotTime
        });
        
      } catch (accountError) {
        logger.error(`[Account Snapshot] Error processing account ${account.AccountID}:`, accountError);
        errors.push({
          accountId: account.AccountID,
          isPaperTrading: account.isPaperTrading || false,
          error: accountError.message
        });
      }
    }
    
    logger.info(`[Account Snapshot] Completed snapshot capture for user ${userId}. Success: ${snapshots.length}, Errors: ${errors.length}`);
    
    res.status(200).json({
      success: true,
      message: `Captured ${snapshots.length} snapshots`,
      snapshots,
      errors: errors.length > 0 ? errors : undefined
    });
    
  } catch (error) {
    logger.error(`[Account Snapshot] Error capturing snapshots for user ${userId}:`, error);
    res.status(500).json({
      error: 'Failed to capture account snapshots',
      message: error.message
    });
  }
}

/**
 * Gets historical snapshots for the authenticated user
 * Query params:
 * - accountId: filter by specific account (optional)
 * - startDate: filter snapshots from this date (optional, YYYY-MM-DD)
 * - endDate: filter snapshots to this date (optional, YYYY-MM-DD)
 * - limit: max number of results (default: 30)
 * - includeBalanceData: whether to include decrypted balance data (default: false)
 */
async function getAccountSnapshots(req, res) {
  const userId = req.user.id;
  const { accountId, startDate, endDate, limit = 30, includeBalanceData = false } = req.query;
  
  try {
    let query = `
      SELECT 
        id,
        account_id,
        account_type,
        snapshot_date,
        snapshot_time,
        equity,
        todays_profit_loss,
        day_trades,
        created_at
        ${includeBalanceData === 'true' ? ', balance_data_encrypted' : ''}
      FROM account_snapshots
      WHERE user_id = $1
    `;
    
    const params = [userId];
    let paramCount = 1;
    
    if (accountId) {
      paramCount++;
      query += ` AND account_id = $${paramCount}`;
      params.push(accountId);
    }
    
    if (startDate) {
      paramCount++;
      query += ` AND snapshot_date >= $${paramCount}`;
      params.push(startDate);
    }
    
    if (endDate) {
      paramCount++;
      query += ` AND snapshot_date <= $${paramCount}`;
      params.push(endDate);
    }
    
    query += ` ORDER BY snapshot_date DESC, snapshot_time DESC`;
    
    if (limit) {
      paramCount++;
      query += ` LIMIT $${paramCount}`;
      params.push(parseInt(limit));
    }
    
    const result = await pool.query(query, params);
    
    // Decrypt balance data if requested
    const snapshots = result.rows.map(row => {
      const snapshot = {
        id: row.id,
        accountId: row.account_id,
        accountType: row.account_type,
        snapshotDate: row.snapshot_date,
        snapshotTime: row.snapshot_time,
        equity: row.equity,
        todaysProfitLoss: row.todays_profit_loss,
        dayTrades: row.day_trades,
        createdAt: row.created_at
      };
      
      if (includeBalanceData === 'true' && row.balance_data_encrypted) {
        try {
          const decrypted = decryptToken(row.balance_data_encrypted);
          snapshot.balanceData = JSON.parse(decrypted);
        } catch (decryptError) {
          logger.error(`[Account Snapshot] Failed to decrypt balance data for snapshot ${row.id}:`, decryptError);
          snapshot.balanceData = null;
          snapshot.decryptError = 'Failed to decrypt balance data';
        }
      }
      
      return snapshot;
    });
    
    res.status(200).json({
      success: true,
      count: snapshots.length,
      snapshots
    });
    
  } catch (error) {
    logger.error(`[Account Snapshot] Error fetching snapshots for user ${userId}:`, error);
    res.status(500).json({
      error: 'Failed to fetch account snapshots',
      message: error.message
    });
  }
}

/**
 * Gets the latest snapshot for each account for the authenticated user
 */
async function getLatestAccountSnapshots(req, res) {
  const userId = req.user.id;
  const { includeBalanceData = false } = req.query;
  
  try {
    const query = `
      SELECT DISTINCT ON (account_id)
        id,
        account_id,
        account_type,
        snapshot_date,
        snapshot_time,
        equity,
        todays_profit_loss,
        day_trades,
        created_at
        ${includeBalanceData === 'true' ? ', balance_data_encrypted' : ''}
      FROM account_snapshots
      WHERE user_id = $1
      ORDER BY account_id, snapshot_date DESC, snapshot_time DESC
    `;
    
    const result = await pool.query(query, [userId]);
    
    // Decrypt balance data if requested
    const snapshots = result.rows.map(row => {
      const snapshot = {
        id: row.id,
        accountId: row.account_id,
        accountType: row.account_type,
        snapshotDate: row.snapshot_date,
        snapshotTime: row.snapshot_time,
        equity: row.equity,
        todaysProfitLoss: row.todays_profit_loss,
        dayTrades: row.day_trades,
        createdAt: row.created_at
      };
      
      if (includeBalanceData === 'true' && row.balance_data_encrypted) {
        try {
          const decrypted = decryptToken(row.balance_data_encrypted);
          snapshot.balanceData = JSON.parse(decrypted);
        } catch (decryptError) {
          logger.error(`[Account Snapshot] Failed to decrypt balance data for snapshot ${row.id}:`, decryptError);
          snapshot.balanceData = null;
          snapshot.decryptError = 'Failed to decrypt balance data';
        }
      }
      
      return snapshot;
    });
    
    res.status(200).json({
      success: true,
      count: snapshots.length,
      snapshots
    });
    
  } catch (error) {
    logger.error(`[Account Snapshot] Error fetching latest snapshots for user ${userId}:`, error);
    res.status(500).json({
      error: 'Failed to fetch latest account snapshots',
      message: error.message
    });
  }
}

/**
 * Gets snapshot data for the authenticated user (superuser only)
 * Returns personal stats and per-account time series data for charts
 */
async function getAdminSnapshotOverview(req, res) {
  const userId = req.user.id;
  
  try {
    // Check if is_paper_trading column exists - if not, migration needs to be run
    const columnCheckQuery = `
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_schema = 'public'
        AND table_name = 'account_snapshots' 
        AND column_name = 'is_paper_trading'
    `;
    const columnCheck = await pool.query(columnCheckQuery);
    
    if (columnCheck.rows.length === 0) {
      logger.error('[Account Snapshot Admin] Missing is_paper_trading column - migration not run');
      return res.status(500).json({
        error: 'Database schema is out of date',
        message: 'The is_paper_trading column does not exist. Please run migrations: npm run migrate',
        details: 'Migration 1793000000000_add_is_paper_trading_to_account_snapshots.js needs to be applied'
      });
    }
    
    // Get user's stats
    const statsQuery = `
      SELECT 
        COUNT(DISTINCT account_id) as total_accounts,
        COUNT(*) as total_snapshots,
        MAX(created_at) as last_snapshot_time
      FROM account_snapshots
      WHERE user_id = $1
    `;
    
    const statsResult = await pool.query(statsQuery, [userId]);
    const stats = statsResult.rows[0];
    
    // Get list of accounts with their types and paper trading flag
    const accountsQuery = `
      SELECT DISTINCT 
        account_id,
        account_type,
        is_paper_trading,
        MIN(snapshot_date) as first_snapshot,
        MAX(snapshot_date) as last_snapshot
      FROM account_snapshots
      WHERE user_id = $1
      GROUP BY account_id, account_type, is_paper_trading
      ORDER BY account_id, is_paper_trading
    `;
    
    const accountsResult = await pool.query(accountsQuery, [userId]);
    const accounts = accountsResult.rows.map(row => ({
      accountId: row.account_id,
      accountType: row.account_type,
      isPaperTrading: row.is_paper_trading || false,
      firstSnapshot: row.first_snapshot,
      lastSnapshot: row.last_snapshot
    }));
    
    // Get time series data per account (last 90 days) - NOT grouped by date
    const timeSeriesQuery = `
      SELECT 
        account_id,
        account_type,
        is_paper_trading,
        snapshot_date,
        equity,
        todays_profit_loss
      FROM account_snapshots
      WHERE user_id = $1
        AND snapshot_date >= CURRENT_DATE - INTERVAL '90 days'
      ORDER BY account_id, is_paper_trading, snapshot_date ASC
    `;
    
    const timeSeriesResult = await pool.query(timeSeriesQuery, [userId]);
    
    // Group by account for chart data (include paper trading flag in key)
    const accountData = {};
    timeSeriesResult.rows.forEach(row => {
      const accountKey = `${row.account_id}_${row.is_paper_trading}`;
      if (!accountData[accountKey]) {
        accountData[accountKey] = {
          accountId: row.account_id,
          accountType: row.account_type,
          isPaperTrading: row.is_paper_trading || false,
          data: []
        };
      }
      const dateStr = row.snapshot_date instanceof Date 
        ? row.snapshot_date.toISOString().split('T')[0]
        : row.snapshot_date;
      accountData[accountKey].data.push({
        date: dateStr,
        equity: row.equity != null ? parseFloat(row.equity) : 0,
        profitLoss: row.todays_profit_loss != null ? parseFloat(row.todays_profit_loss) : 0
      });
    });
    
    res.status(200).json({
      success: true,
      stats: {
        totalAccounts: parseInt(stats.total_accounts) || 0,
        totalSnapshots: parseInt(stats.total_snapshots) || 0,
        lastSnapshotTime: stats.last_snapshot_time
      },
      accounts,
      accountData: Object.values(accountData)
    });
    
  } catch (error) {
    logger.error('[Account Snapshot Admin] Error fetching overview:', error);
    res.status(500).json({
      error: 'Failed to fetch snapshot overview',
      message: error.message
    });
  }
}

module.exports = {
  captureAccountSnapshot,
  getAccountSnapshots,
  getLatestAccountSnapshots,
  getAdminSnapshotOverview
};
