const pool = require('../db');

/**
 * Migration: Create beta tracking system
 * Tracks the complete beta user journey from request to survey completion
 */

async function up() {
  const client = await pool.connect();
  
  try {
    console.log('Creating beta tracking table...');
    
    // Create beta_tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS beta_tracking (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        email VARCHAR(255) NOT NULL,
        contact_submission_id INTEGER,
        beta_code VARCHAR(50),
        
        -- Journey timestamps
        requested_at TIMESTAMP,
        started_at TIMESTAMP,
        intro_email_sent_at TIMESTAMP,
        followup_email_sent_at TIMESTAMP,
        survey_sent_at TIMESTAMP,
        survey_completed_at TIMESTAMP,
        
        -- Survey response (JSONB for flexibility)
        survey_response JSONB,
        
        -- Meta
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        UNIQUE(email)
      );
    `);
    
    // Create indexes for performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_beta_tracking_user_id ON beta_tracking(user_id);
      CREATE INDEX IF NOT EXISTS idx_beta_tracking_email ON beta_tracking(email);
      CREATE INDEX IF NOT EXISTS idx_beta_tracking_beta_code ON beta_tracking(beta_code);
      CREATE INDEX IF NOT EXISTS idx_beta_tracking_started_at ON beta_tracking(started_at);
    `);
    
    // Trigger to update updated_at timestamp
    await client.query(`
      CREATE OR REPLACE FUNCTION update_beta_tracking_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      
      DROP TRIGGER IF EXISTS beta_tracking_updated_at ON beta_tracking;
      
      CREATE TRIGGER beta_tracking_updated_at
        BEFORE UPDATE ON beta_tracking
        FOR EACH ROW
        EXECUTE FUNCTION update_beta_tracking_updated_at();
    `);
    
    console.log('✅ Successfully created beta tracking table');
    
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
    console.log('Removing beta tracking table...');
    
    // Drop trigger and function
    await client.query(`
      DROP TRIGGER IF EXISTS beta_tracking_updated_at ON beta_tracking;
      DROP FUNCTION IF EXISTS update_beta_tracking_updated_at();
    `);
    
    // Drop indexes
    await client.query(`
      DROP INDEX IF EXISTS idx_beta_tracking_user_id;
      DROP INDEX IF EXISTS idx_beta_tracking_email;
      DROP INDEX IF EXISTS idx_beta_tracking_beta_code;
      DROP INDEX IF EXISTS idx_beta_tracking_started_at;
    `);
    
    // Drop table
    await client.query(`
      DROP TABLE IF EXISTS beta_tracking;
    `);
    
    console.log('✅ Successfully removed beta tracking table');
    
  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };






