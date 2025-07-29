const pool = require('../db');

/**
 * Migration: Insert Schwab cost basis data for user
 * Populates the cost_basis_data field with the original Schwab average prices
 */

async function up() {
  const client = await pool.connect();
  
  try {
    console.log('Inserting Schwab cost basis data...');
    
    // Original Schwab average prices
    const schwabCostBasisData = {
      'ACMR': 24.89,
      'AMAT': 179.19,
      'FIVN': 61.29,
      'FORM': 40.53,
      'GDYN': 18.14,
      'MA': 441.62,
      'MGRC': 100.39,
      'PHLT': 2.74,
      'VEEV': 183.57,
      'V': 291.66,
      'WDAY': 226.06,
      'VFIAX': 567.99,
      'QQQ': 446.11,
      'XMMO': 114.29,
      'IWM': 220.40,
      'XLF': 41.28,
      'SPY': 560.89,
      'VBK': 253.47,
      'BITX': 42.99
    };
    
    // Update the user's cost_basis_data (assuming you're the first user or we can identify your account)
    // You may need to adjust the WHERE clause to target your specific user account
    const result = await client.query(`
      UPDATE users 
      SET cost_basis_data = $1 
      WHERE id = 1
      RETURNING id, email, cost_basis_data;
    `, [JSON.stringify(schwabCostBasisData)]);
    
    if (result.rows.length > 0) {
      console.log('✅ Successfully updated user with Schwab cost basis data');
      console.log('Updated user:', result.rows[0].email);
      console.log('Cost basis data keys:', Object.keys(schwabCostBasisData));
    } else {
      console.log('⚠️  No user found with id = 1. You may need to adjust the user ID.');
      console.log('Available users:');
      const users = await client.query('SELECT id, email FROM users ORDER BY id');
      users.rows.forEach(user => {
        console.log(`  ID: ${user.id}, Email: ${user.email}`);
      });
    }
    
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
    console.log('Removing Schwab cost basis data...');
    
    // Clear the cost_basis_data for the user
    const result = await client.query(`
      UPDATE users 
      SET cost_basis_data = '{}' 
      WHERE id = 1
      RETURNING id, email;
    `);
    
    if (result.rows.length > 0) {
      console.log('✅ Successfully cleared cost basis data for user:', result.rows[0].email);
    } else {
      console.log('⚠️  No user found with id = 1');
    }
    
  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down }; 