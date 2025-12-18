/**
 * Script to fix incorrectly set position loss enabled flags
 * This will disable position loss for all accounts EXCEPT those with active locks
 * 
 * Run with: node scripts/fix_position_loss_enabled_flags.js
 */

const pool = require('../db');

async function fixEnabledFlags() {
  const client = await pool.connect();
  
  try {
    console.log('\n=== Fixing Position Loss Enabled Flags ===\n');
    
    await client.query('BEGIN');
    
    // Get all users with account_defaults
    const users = await client.query(`
      SELECT id, email, account_defaults
      FROM users
      WHERE account_defaults IS NOT NULL
        AND account_defaults::text != '{}'
    `);
    
    // Get all active locks (accounts that SHOULD have position loss enabled)
    const activeLocks = await client.query(`
      SELECT DISTINCT user_id, account_id, limit_type
      FROM loss_limit_locks
      WHERE expires_at > NOW()
        AND limit_type = 'trade'
    `);
    
    // Build a Set of accounts that should be enabled
    const shouldBeEnabled = new Set();
    for (const lock of activeLocks.rows) {
      shouldBeEnabled.add(`${lock.user_id}|${lock.account_id}`);
    }
    
    console.log(`Found ${activeLocks.rows.length} active position loss lock(s)\n`);
    
    let updatedUsers = 0;
    let totalAccountsFixed = 0;
    
    for (const user of users.rows) {
      const accountDefaults = user.account_defaults || {};
      let modified = false;
      let accountsFixed = 0;
      
      for (const [accountId, settings] of Object.entries(accountDefaults)) {
        const key = `${user.id}|${accountId}`;
        const shouldEnable = shouldBeEnabled.has(key);
        
        const currentlyEnabled = settings.maxLossPerPositionEnabled || settings.maxLossPerTradeEnabled || false;
        
        if (currentlyEnabled !== shouldEnable) {
          // Update the enabled flag
          accountDefaults[accountId].maxLossPerPositionEnabled = shouldEnable;
          
          // Also update old field name for backward compatibility
          if (accountDefaults[accountId].maxLossPerTradeEnabled !== undefined) {
            accountDefaults[accountId].maxLossPerTradeEnabled = shouldEnable;
          }
          
          modified = true;
          accountsFixed++;
          
          const threshold = settings.maxLossPerPosition || settings.maxLossPerTrade || 0;
          console.log(`  User ${user.id} (${user.email}), Account ${accountId}:`);
          console.log(`    Changed: ${currentlyEnabled} → ${shouldEnable} (threshold: $${threshold})`);
        }
      }
      
      if (modified) {
        await client.query(
          'UPDATE users SET account_defaults = $1 WHERE id = $2',
          [JSON.stringify(accountDefaults), user.id]
        );
        updatedUsers++;
        totalAccountsFixed += accountsFixed;
      }
    }
    
    await client.query('COMMIT');
    
    console.log(`\n✅ Fixed ${totalAccountsFixed} account(s) across ${updatedUsers} user(s)\n`);
    
    process.exit(0);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error:', error);
    process.exit(1);
  } finally {
    client.release();
  }
}

fixEnabledFlags();






