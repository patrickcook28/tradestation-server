const pool = require('../db');
const { tradestationRequest } = require('../utils/tradestationProxy');
const { encryptToken } = require('../utils/secureCredentials');
const logger = require('../config/logging');

/**
 * Account Snapshot Scheduler
 * 
 * Automatically captures account snapshots for all active users at a scheduled time.
 * This worker runs daily to ensure we have historical balance data for all users.
 * 
 * Features:
 * - Captures snapshots for all users with valid TradeStation credentials
 * - Encrypts sensitive balance data before storage
 * - Handles errors gracefully per-user/per-account
 * - Configurable schedule time
 */
class AccountSnapshotScheduler {
  constructor() {
    this.isRunning = false;
    this.scheduledTime = '18:28'; // 3:30 PM ET (before market close at 4 PM ET)
    this.timezone = 'America/New_York'; // Eastern Time
    this.cronJob = null;
  }

  /**
   * Starts the scheduler with cron-based timing
   * Requires node-cron to be installed
   */
  async start() {
    if (this.isRunning) {
      logger.warn('[Account Snapshot Scheduler] Already running');
      return;
    }

    this.isRunning = true;
    logger.info(`[Account Snapshot Scheduler] Starting scheduler for ${this.scheduledTime} ${this.timezone}`);
    
    try {
      const cron = require('node-cron');
      
      // Parse the scheduled time (format: HH:MM)
      const [hour, minute] = this.scheduledTime.split(':');
      
      // Create cron expression: "minute hour * * *" (runs daily)
      const cronExpression = `${minute} ${hour} * * *`;
      
      logger.info(`[Account Snapshot Scheduler] Cron expression: ${cronExpression}`);
      
      // Schedule the job
      this.cronJob = cron.schedule(cronExpression, async () => {
        logger.info('[Account Snapshot Scheduler] Triggered scheduled snapshot capture');
        await this.captureAllUserSnapshots();
      }, {
        scheduled: true,
        timezone: this.timezone
      });
      
      logger.info('[Account Snapshot Scheduler] ✅ Scheduler started successfully');
      logger.info(`[Account Snapshot Scheduler] Next snapshot will be captured at ${this.scheduledTime} ${this.timezone}`);
      
    } catch (error) {
      logger.error('[Account Snapshot Scheduler] Failed to start scheduler:', error);
      
      // Fallback to simple interval-based scheduling (checks every hour)
      logger.warn('[Account Snapshot Scheduler] Falling back to interval-based scheduling');
      this.startIntervalBased();
    }
  }

  /**
   * Fallback method: uses setInterval to check every hour if it's time to run
   * Less precise than cron but doesn't require additional dependencies
   */
  startIntervalBased() {
    // Check every hour
    this.interval = setInterval(async () => {
      const now = new Date();
      const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      
      // Check if current time matches scheduled time (within the hour)
      if (currentTime === this.scheduledTime) {
        logger.info('[Account Snapshot Scheduler] Triggered scheduled snapshot capture (interval-based)');
        await this.captureAllUserSnapshots();
      }
    }, 60 * 60 * 1000); // Check every hour
    
    logger.info('[Account Snapshot Scheduler] ✅ Interval-based scheduler started');
  }

  /**
   * Stops the scheduler
   */
  async stop() {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
    
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    
    this.isRunning = false;
    logger.info('[Account Snapshot Scheduler] Stopped');
  }

  /**
   * Manually triggers snapshot capture for all users
   * Can be called independently of the schedule
   */
  async captureAllUserSnapshots() {
    const startTime = Date.now();
    logger.info('[Account Snapshot Scheduler] Starting snapshot capture for all users');
    
    try {
      // Get all users with valid API credentials
      const usersQuery = `
        SELECT DISTINCT u.id, u.email
        FROM users u
        INNER JOIN api_credentials ac ON u.id = ac.user_id
        WHERE ac.access_token IS NOT NULL 
        AND ac.refresh_token IS NOT NULL
        ORDER BY u.id
      `;
      
      const usersResult = await pool.query(usersQuery);
      const users = usersResult.rows;
      
      if (users.length === 0) {
        logger.warn('[Account Snapshot Scheduler] No users with API credentials found');
        return { success: 0, failed: 0, totalUsers: 0 };
      }
      
      logger.info(`[Account Snapshot Scheduler] Found ${users.length} users to process`);
      
      let successCount = 0;
      let failedCount = 0;
      
      // Process each user sequentially to avoid overwhelming the API
      for (const user of users) {
        try {
          const result = await this.captureUserSnapshot(user.id);
          if (result.success) {
            successCount++;
            logger.info(`[Account Snapshot Scheduler] ✅ User ${user.id} (${user.email}): ${result.accountsProcessed} accounts`);
          } else {
            failedCount++;
            logger.error(`[Account Snapshot Scheduler] ❌ User ${user.id} (${user.email}): ${result.error}`);
          }
        } catch (userError) {
          failedCount++;
          logger.error(`[Account Snapshot Scheduler] ❌ User ${user.id} (${user.email}):`, userError);
        }
        
        // Small delay between users to be respectful to the API
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      logger.info(`[Account Snapshot Scheduler] ✅ Completed in ${duration}s. Success: ${successCount}, Failed: ${failedCount}, Total: ${users.length}`);
      
      return {
        success: successCount,
        failed: failedCount,
        totalUsers: users.length,
        durationSeconds: parseFloat(duration)
      };
      
    } catch (error) {
      logger.error('[Account Snapshot Scheduler] Error in captureAllUserSnapshots:', error);
      throw error;
    }
  }

  /**
   * Captures snapshots for a single user's accounts (both paper and live)
   */
  async captureUserSnapshot(userId) {
    try {
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
      }
      
      if (allAccounts.length === 0) {
        return {
          success: true,
          accountsProcessed: 0,
          message: 'No accounts found'
        };
      }
      
      // Step 2: Fetch balances for each account and store snapshot
      let successfulAccounts = 0;
      
      for (const account of allAccounts) {
        try {
          const accountId = account.AccountID;
          const isPaperTrading = account.isPaperTrading || false;
          
          const balancesResult = await tradestationRequest(userId, {
            method: 'GET',
            path: `/brokerage/accounts/${accountId}/balances`,
            paperTrading: isPaperTrading,
          });
          
          if (!balancesResult.ok) {
            logger.warn(`[Account Snapshot Scheduler] Failed to fetch balances for account ${accountId}`);
            continue;
          }
          
          const balanceData = balancesResult.data?.Balances?.[0];
          if (!balanceData) {
            logger.warn(`[Account Snapshot Scheduler] No balance data for account ${accountId}`);
            continue;
          }
          
          // Encrypt the full balance data
          const encryptedBalanceData = encryptToken(JSON.stringify(balanceData));
          
          // Extract summary fields
          const equity = parseFloat(balanceData.Equity) || null;
          const todaysProfitLoss = parseFloat(balanceData.TodaysProfitLoss) || null;
          const dayTrades = parseInt(balanceData.BalanceDetail?.DayTrades) || null;
          
          // Store the snapshot
          const now = new Date();
          const snapshotDate = now.toISOString().split('T')[0];
          const snapshotTime = now.toTimeString().split(' ')[0];
          
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
          `;
          
          await pool.query(insertQuery, [
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
          
          successfulAccounts++;
          
          // Small delay between accounts
          await new Promise(resolve => setTimeout(resolve, 500));
          
        } catch (accountError) {
          logger.error(`[Account Snapshot Scheduler] Error processing account ${account.AccountID}:`, accountError);
        }
      }
      
      return {
        success: true,
        accountsProcessed: successfulAccounts,
        totalAccounts: allAccounts.length
      };
      
    } catch (error) {
      logger.error(`[Account Snapshot Scheduler] Error capturing snapshot for user ${userId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = AccountSnapshotScheduler;
