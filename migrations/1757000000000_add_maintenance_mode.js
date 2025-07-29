const pool = require('../db');

/**
 * Migration: Add maintenance mode system
 * Creates a maintenance_mode table to control app availability
 */

async function up() {
  const client = await pool.connect();
  
  try {
    console.log('Adding maintenance mode system...');
    
    // Create maintenance_mode table
    await client.query(`
      CREATE TABLE IF NOT EXISTS maintenance_mode (
        id SERIAL PRIMARY KEY,
        is_enabled BOOLEAN DEFAULT false,
        message TEXT DEFAULT 'The application is currently under maintenance. Please try again later.',
        enabled_by_user_id INTEGER REFERENCES users(id),
        enabled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        disabled_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // Insert default maintenance mode record (disabled)
    await client.query(`
      INSERT INTO maintenance_mode (is_enabled, message) 
      VALUES (false, 'The application is currently under maintenance. Please try again later.')
      ON CONFLICT DO NOTHING;
    `);
    
    // Create indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_maintenance_mode_enabled ON maintenance_mode(is_enabled);
      CREATE INDEX IF NOT EXISTS idx_maintenance_mode_enabled_by ON maintenance_mode(enabled_by_user_id);
    `);
    
    console.log('✅ Successfully added maintenance mode system');
    
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
    console.log('Removing maintenance mode system...');
    
    // Remove indexes
    await client.query(`
      DROP INDEX IF EXISTS idx_maintenance_mode_enabled;
      DROP INDEX IF EXISTS idx_maintenance_mode_enabled_by;
    `);
    
    // Drop maintenance_mode table
    await client.query(`
      DROP TABLE IF EXISTS maintenance_mode;
    `);
    
    console.log('✅ Successfully removed maintenance mode system');
    
  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down }; 