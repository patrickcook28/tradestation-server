/**
 * Script to check and display position loss settings for debugging
 * Run with: node scripts/check_position_loss_settings.js
 */

const pool = require('../db');

async function checkSettings() {
  try {
    console.log('\n=== Position Loss Settings Check ===\n');
    
    const result = await pool.query(`
      SELECT 
        id,
        email,
        account_defaults
      FROM users
      WHERE account_defaults IS NOT NULL
        AND account_defaults::text != '{}'
      ORDER BY id
    `);

    for (const user of result.rows) {
      console.log(`\nUser ${user.id}: ${user.email}`);
      console.log('─'.repeat(80));
      
      const accountDefaults = user.account_defaults || {};
      
      for (const [accountId, settings] of Object.entries(accountDefaults)) {
        const hasPositionLoss = settings.maxLossPerPositionEnabled || settings.maxLossPerTradeEnabled;
        const threshold = settings.maxLossPerPosition || settings.maxLossPerTrade;
        
        if (hasPositionLoss || threshold) {
          console.log(`\n  Account: ${accountId}`);
          console.log(`    isPaperTrading: ${settings.isPaperTrading}`);
          console.log(`    maxLossPerPosition: $${threshold || 0}`);
          console.log(`    maxLossPerPositionEnabled: ${settings.maxLossPerPositionEnabled || settings.maxLossPerTradeEnabled || false}`);
          console.log(`    (Old field) maxLossPerTrade: $${settings.maxLossPerTrade || 0}`);
          console.log(`    (Old field) maxLossPerTradeEnabled: ${settings.maxLossPerTradeEnabled || false}`);
        }
      }
    }
    
    console.log('\n\n=== Active Loss Limit Locks ===\n');
    
    const locks = await pool.query(`
      SELECT 
        l.*,
        u.email
      FROM loss_limit_locks l
      JOIN users u ON l.user_id = u.id
      WHERE l.expires_at > NOW()
      ORDER BY l.user_id, l.account_id, l.limit_type
    `);
    
    if (locks.rows.length === 0) {
      console.log('  No active locks found.');
    } else {
      for (const lock of locks.rows) {
        console.log(`\n  User ${lock.user_id} (${lock.email})`);
        console.log(`    Account: ${lock.account_id}`);
        console.log(`    Type: ${lock.limit_type}`);
        console.log(`    Threshold: $${lock.threshold_amount}`);
        console.log(`    Expires: ${lock.expires_at}`);
      }
    }
    
    console.log('\n');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

checkSettings();



