/**
 * Script to manually enable position loss monitoring for a specific account
 * Run with: node scripts/enable_position_loss_for_account.js <userId> <accountId> <threshold>
 */

const pool = require('../db');

const userId = process.argv[2] || '1';
const accountId = process.argv[3] || 'SIM2397315F';
const threshold = parseFloat(process.argv[4]) || 100;

async function enablePositionLoss() {
  try {
    console.log(`\nEnabling position loss monitoring:`);
    console.log(`  User ID: ${userId}`);
    console.log(`  Account: ${accountId}`);
    console.log(`  Threshold: $${threshold}\n`);

    // Get current account_defaults
    const userResult = await pool.query(
      'SELECT account_defaults FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      console.error('❌ User not found');
      process.exit(1);
    }

    const accountDefaults = userResult.rows[0].account_defaults || {};

    // Ensure account entry exists
    if (!accountDefaults[accountId]) {
      accountDefaults[accountId] = {};
    }

    // Enable position loss monitoring
    accountDefaults[accountId].maxLossPerPosition = threshold;
    accountDefaults[accountId].maxLossPerPositionEnabled = true;

    // Infer isPaperTrading if not set
    if (accountDefaults[accountId].isPaperTrading === undefined) {
      accountDefaults[accountId].isPaperTrading = accountId.startsWith('SIM');
    }

    // Save updated account_defaults
    await pool.query(
      'UPDATE users SET account_defaults = $1 WHERE id = $2',
      [JSON.stringify(accountDefaults), userId]
    );

    console.log('✅ Position loss monitoring enabled!');
    console.log(`\nAccount settings:`);
    console.log(JSON.stringify(accountDefaults[accountId], null, 2));
    console.log('\nRestart the server to apply changes.');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

enablePositionLoss();











