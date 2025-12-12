const pool = require('../db');

/**
 * Migration: Normalize account_defaults structure
 * 
 * BEFORE (inconsistent):
 * {
 *   "11591302": { risk, riskPercentage },
 *   "11591302_live": { maxLossPerDay, maxLossPerTrade, ... },
 *   "SIM2397314M": { risk, riskPercentage },
 *   "SIM2397314M_paper": { maxLossPerDay, maxLossPerTrade, ... }
 * }
 * 
 * AFTER (consistent):
 * {
 *   "11591302": { risk, riskPercentage, maxLossPerDay, maxLossPerPosition, maxLossPerDayEnabled, maxLossPerPositionEnabled, isPaperTrading: false },
 *   "SIM2397314M": { risk, riskPercentage, maxLossPerDay, maxLossPerPosition, maxLossPerDayEnabled, maxLossPerPositionEnabled, isPaperTrading: true }
 * }
 */

async function up() {
  const client = await pool.connect();
  try {
    console.log('Normalizing account_defaults structure...');

    // Get all users with account_defaults
    const result = await client.query(`
      SELECT id, account_defaults
      FROM users
      WHERE account_defaults IS NOT NULL
        AND account_defaults::text != '{}'
    `);

    let updatedCount = 0;

    for (const row of result.rows) {
      const userId = row.id;
      const oldDefaults = row.account_defaults || {};
      const newDefaults = {};

      // Track which accounts we've processed
      const processedAccounts = new Set();

      // First pass: Copy all base account settings (risk/riskPercentage)
      for (const [key, value] of Object.entries(oldDefaults)) {
        // Skip _paper and _live keys in first pass
        if (key.includes('_paper') || key.includes('_live')) continue;

        // This is a base account (just account ID)
        newDefaults[key] = { ...value };
        processedAccounts.add(key);
      }

      // Second pass: Merge _paper and _live settings into base accounts
      for (const [key, value] of Object.entries(oldDefaults)) {
        let accountId;
        let isPaperTrading;

        if (key.endsWith('_paper')) {
          accountId = key.replace('_paper', '');
          isPaperTrading = true;
        } else if (key.endsWith('_live')) {
          accountId = key.replace('_live', '');
          isPaperTrading = false;
        } else {
          // Already processed in first pass
          continue;
        }

        // Create account entry if it doesn't exist
        if (!newDefaults[accountId]) {
          newDefaults[accountId] = {};
        }

        // Merge loss limit settings
        if (value.maxLossPerDay !== undefined) {
          newDefaults[accountId].maxLossPerDay = value.maxLossPerDay;
        }
        if (value.maxLossPerDayEnabled !== undefined) {
          newDefaults[accountId].maxLossPerDayEnabled = value.maxLossPerDayEnabled;
        }
        
        // Rename maxLossPerTrade -> maxLossPerPosition
        if (value.maxLossPerTrade !== undefined) {
          newDefaults[accountId].maxLossPerPosition = value.maxLossPerTrade;
        }
        if (value.maxLossPerTradeEnabled !== undefined) {
          newDefaults[accountId].maxLossPerPositionEnabled = value.maxLossPerTradeEnabled;
        }

        // Add isPaperTrading flag
        newDefaults[accountId].isPaperTrading = isPaperTrading;

        processedAccounts.add(accountId);
      }
      
      // Third pass: For accounts without _paper/_live entries, infer isPaperTrading from account ID
      for (const accountId of Object.keys(newDefaults)) {
        if (newDefaults[accountId].isPaperTrading === undefined) {
          // SIM accounts are paper trading, others are live
          newDefaults[accountId].isPaperTrading = accountId.startsWith('SIM');
        }
      }

      // Update user with normalized structure
      await client.query(
        'UPDATE users SET account_defaults = $1 WHERE id = $2',
        [JSON.stringify(newDefaults), userId]
      );

      updatedCount++;
      console.log(`✓ Normalized account_defaults for user ${userId} (${Object.keys(newDefaults).length} accounts)`);
    }

    console.log(`✅ Successfully normalized account_defaults for ${updatedCount} user(s)`);
  } catch (error) {
    console.error('❌ Error in migration:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function down() {
  const client = await pool.connect();
  try {
    console.log('Reverting account_defaults structure...');

    // Get all users with account_defaults
    const result = await client.query(`
      SELECT id, account_defaults
      FROM users
      WHERE account_defaults IS NOT NULL
        AND account_defaults::text != '{}'
    `);

    let revertedCount = 0;

    for (const row of result.rows) {
      const userId = row.id;
      const newDefaults = row.account_defaults || {};
      const oldDefaults = {};

      for (const [accountId, settings] of Object.entries(newDefaults)) {
        const isPaper = settings.isPaperTrading === true;
        
        // Create base account entry (risk/riskPercentage only)
        oldDefaults[accountId] = {
          risk: settings.risk,
          riskPercentage: settings.riskPercentage
        };

        // Create suffixed entry for loss limits
        const suffix = isPaper ? '_paper' : '_live';
        const lossLimitKey = `${accountId}${suffix}`;
        
        oldDefaults[lossLimitKey] = {};
        
        if (settings.maxLossPerDay !== undefined) {
          oldDefaults[lossLimitKey].maxLossPerDay = settings.maxLossPerDay;
        }
        if (settings.maxLossPerDayEnabled !== undefined) {
          oldDefaults[lossLimitKey].maxLossPerDayEnabled = settings.maxLossPerDayEnabled;
        }
        
        // Rename back: maxLossPerPosition -> maxLossPerTrade
        if (settings.maxLossPerPosition !== undefined) {
          oldDefaults[lossLimitKey].maxLossPerTrade = settings.maxLossPerPosition;
        }
        if (settings.maxLossPerPositionEnabled !== undefined) {
          oldDefaults[lossLimitKey].maxLossPerTradeEnabled = settings.maxLossPerPositionEnabled;
        }
      }

      // Update user with old structure
      await client.query(
        'UPDATE users SET account_defaults = $1 WHERE id = $2',
        [JSON.stringify(oldDefaults), userId]
      );

      revertedCount++;
    }

    console.log(`✅ Successfully reverted ${revertedCount} user(s)`);
  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };

