const pool = require('../db');

async function up() {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE bug_reports 
      ADD COLUMN IF NOT EXISTS resolution_notes TEXT,
      ADD COLUMN IF NOT EXISTS resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP WITH TIME ZONE;
    `);

    console.log('✅ Added resolution_notes, resolved_by, and resolved_at columns to bug_reports table');
  } finally {
    client.release();
  }
}

async function down() {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE bug_reports 
      DROP COLUMN IF EXISTS resolution_notes,
      DROP COLUMN IF EXISTS resolved_by,
      DROP COLUMN IF EXISTS resolved_at;
    `);
    console.log('✅ Dropped resolution_notes, resolved_by, and resolved_at columns from bug_reports table');
  } finally {
    client.release();
  }
}

module.exports = { up, down };

