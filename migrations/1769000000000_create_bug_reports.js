const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function up() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS bug_reports (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        subject VARCHAR(500) NOT NULL,
        description TEXT NOT NULL,
        state_snapshot JSONB,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        status VARCHAR(20) DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'resolved', 'closed')),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // Create index for faster queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON bug_reports(status);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bug_reports_created_at ON bug_reports(created_at DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bug_reports_user_id ON bug_reports(user_id);
    `);

    console.log('✅ Created bug_reports table');
  } finally {
    client.release();
  }
}

async function down() {
  const client = await pool.connect();
  try {
    await client.query('DROP TABLE IF EXISTS bug_reports CASCADE;');
    console.log('✅ Dropped bug_reports table');
  } finally {
    client.release();
  }
}

module.exports = { up, down };

