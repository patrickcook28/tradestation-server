const pool = require('../db');

/**
 * Migration: Remove email_templates table
 * Templates are now defined in code (config/emailTemplates.js) instead of database
 * 
 * Note: This migration handles the case where email_templates table was created
 * by a previous migration (1788000000000) that has since been removed from the codebase
 */

async function up() {
  const client = await pool.connect();
  
  try {
    console.log('Removing email_templates table...');
    
    // Drop trigger if it exists
    await client.query(`
      DROP TRIGGER IF EXISTS trigger_update_email_templates_updated_at ON email_templates;
    `);
    
    // Drop function if it exists
    await client.query(`
      DROP FUNCTION IF EXISTS update_email_templates_updated_at();
    `);
    
    // Drop indexes
    await client.query(`
      DROP INDEX IF EXISTS idx_email_templates_is_active;
      DROP INDEX IF EXISTS idx_email_templates_label;
      DROP INDEX IF EXISTS idx_email_templates_name;
    `);
    
    // Drop table
    await client.query(`
      DROP TABLE IF EXISTS email_templates;
    `);
    
    console.log('✅ Successfully removed email_templates table');
    
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
    console.log('Recreating email_templates table...');
    
    // Recreate the table (simplified version without label since we're removing it)
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_templates (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        subject VARCHAR(500) NOT NULL,
        text_content TEXT NOT NULL,
        html_content TEXT NOT NULL,
        description TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // Create indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_email_templates_name ON email_templates(name);
      CREATE INDEX IF NOT EXISTS idx_email_templates_is_active ON email_templates(is_active);
    `);
    
    console.log('✅ Successfully recreated email_templates table');
    
  } catch (error) {
    console.error('❌ Error in migration rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };
