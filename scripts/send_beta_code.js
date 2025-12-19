#!/usr/bin/env node

/**
 * Beta Code Generator & Email Sender
 * 
 * Usage:
 *   node scripts/send_beta_code.js user@example.com
 * 
 * This script:
 * 1. Generates a unique 6-character beta code
 * 2. Creates it in the database
 * 3. Sends the beta welcome email to the specified user
 */

const pool = require('../db');
const { createTransport, buildBetaWelcomeEmail } = require('../config/email');
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

async function sendBetaCode(email) {
  const client = await pool.connect();
  
  try {
    console.log(`\n🚀 Generating beta code for ${email}...\n`);
    
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
      [code, `Beta code for ${email}`, 1]
    );

    console.log(`✅ Code saved to database`);
    
    // Send email
    const transport = createTransport();
    const mailOptions = buildBetaWelcomeEmail({
      to: email,
      betaCode: code
    });
    
    await transport.sendMail(mailOptions);
    console.log(`✅ Beta welcome email sent to ${email}`);
    
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📧 Email: ${email}`);
    console.log(`🎫 Code: ${code}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    console.log(`✨ Beta onboarding complete!\n`);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Main execution
const email = process.argv[2];

if (!email) {
  console.error('\n❌ Error: Email address is required\n');
  console.log('Usage: node scripts/send_beta_code.js user@example.com\n');
  process.exit(1);
}

// Validate email format
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
if (!emailRegex.test(email)) {
  console.error('\n❌ Error: Invalid email format\n');
  process.exit(1);
}

sendBetaCode(email).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

