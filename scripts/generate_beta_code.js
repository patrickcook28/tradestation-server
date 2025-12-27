#!/usr/bin/env node

/**
 * Beta Code Generator (without sending email)
 * 
 * Usage:
 *   node scripts/generate_beta_code.js
 *   node scripts/generate_beta_code.js --description "Special beta user"
 *   node scripts/generate_beta_code.js --max-uses 5
 * 
 * This script generates a unique 6-character beta code and saves it to the database
 * without sending an email. You can then manually send the code to the user.
 */

const pool = require('../db');
const crypto = require('crypto');

/**
 * Generate a unique 6-character alphabetic beta code
 */
function generateBetaCode() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code = '';
  
  const randomBytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    const index = randomBytes[i] % letters.length;
    code += letters[index];
  }
  
  return code;
}

async function createBetaCode(description, maxUses) {
  const client = await pool.connect();
  
  try {
    console.log(`\n🚀 Generating new beta code...\n`);
    
    // Generate unique code (try up to 10 times)
    let code;
    let attempts = 0;
    let isUnique = false;

    while (!isUnique && attempts < 10) {
      code = generateBetaCode();
      
      const existingCode = await client.query(
        'SELECT id FROM referral_codes WHERE code = $1',
        [code]
      );

      if (existingCode.rows.length === 0) {
        isUnique = true;
      }
      attempts++;
    }

    if (!isUnique) {
      console.error('❌ Failed to generate unique code after 10 attempts');
      process.exit(1);
    }

    console.log(`✅ Generated unique code: ${code}`);
    
    // Insert into database
    const result = await client.query(
      `INSERT INTO referral_codes (code, description, is_active, max_uses, current_uses)
       VALUES ($1, $2, true, $3, 0)
       RETURNING *`,
      [code, description || 'Beta code', maxUses || 1]
    );

    console.log(`✅ Code saved to database`);
    
    const betaCode = result.rows[0];
    
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🎫 Beta Code: ${betaCode.code}`);
    console.log(`📝 Description: ${betaCode.description}`);
    console.log(`🔢 Max Uses: ${betaCode.max_uses || 'Unlimited'}`);
    console.log(`✅ Status: Active`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    console.log(`Copy this code and send it to your beta user!\n`);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
let description = null;
let maxUses = 1;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--description' || args[i] === '-d') {
    description = args[i + 1];
    i++;
  } else if (args[i] === '--max-uses' || args[i] === '-m') {
    maxUses = parseInt(args[i + 1], 10);
    i++;
  }
}

createBetaCode(description, maxUses).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});






