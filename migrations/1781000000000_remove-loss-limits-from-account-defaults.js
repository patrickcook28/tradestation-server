const pool = require('../db');

/**
 * Migration: Remove loss limit fields from account_defaults
 * 
 * Loss limits should ONLY live in loss_limit_locks table (single source of truth)
 * 
 * account_defaults should only contain:
 * - risk (per-trade risk amount)
 * - riskPercentage (risk percentage)
 * - isPaperTrading (paper or live account)
 * 
 * Removes:
 * - maxLossPerDay, maxLossPerDayEnabled
 * - maxLossPerPosition, maxLossPerPositionEnabled  
 * - maxLossPerTrade, maxLossPerTradeEnabled (old names)
 */

async function up() {
  const client = await pool.connect();
  try {
    console.log('Removing loss limit fields from account_defaults...');

    const result = await client.query(`
      SELECT id, account_defaults
      FROM users
      WHERE account_defaults IS NOT NULL
        AND account_defaults::text != '{}'
    `);

    let updatedCount = 0;

    for (const row of result.rows) {
      const userId = row.id;
      const accountDefaults = row.account_defaults || {};
      let modified = false;

      for (const [accountId, settings] of Object.entries(accountDefaults)) {
        // Keep only: risk, riskPercentage, isPaperTrading
        const cleaned = {};
        
        if (settings.risk !== undefined) cleaned.risk = settings.risk;
        if (settings.riskPercentage !== undefined) cleaned.riskPercentage = settings.riskPercentage;
        if (settings.isPaperTrading !== undefined) cleaned.isPaperTrading = settings.isPaperTrading;
        
        // Infer isPaperTrading if not set
        if (cleaned.isPaperTrading === undefined) {
          cleaned.isPaperTrading = accountId.startsWith('SIM');
        }

        accountDefaults[accountId] = cleaned;
        modified = true;
      }

      if (modified) {
        await client.query(
          'UPDATE users SET account_defaults = $1 WHERE id = $2',
          [JSON.stringify(accountDefaults), userId]
        );
        updatedCount++;
        console.log(`✓ Cleaned account_defaults for user ${userId}`);
      }
    }

    console.log(`✅ Successfully cleaned account_defaults for ${updatedCount} user(s)`);
    console.log('\n📝 Note: Loss limits now ONLY live in loss_limit_locks table');
  } catch (error) {
    console.error('❌ Error in migration:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function down() {
  console.log('⚠️ Cannot automatically revert - loss limit data was removed');
  console.log('If needed, restore from backup or recreate loss limits via UI');
}

module.exports = { up, down };

