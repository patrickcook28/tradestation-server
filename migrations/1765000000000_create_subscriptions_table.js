const pool = require('../db');

/**
 * Migration: Create subscriptions and webhook_events tables for Stripe billing
 */

async function up() {
  const client = await pool.connect();
  try {
    console.log('Creating subscriptions and webhook_events tables...');

    // Create subscriptions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        stripe_customer_id VARCHAR(255) UNIQUE,
        stripe_subscription_id VARCHAR(255) UNIQUE,
        status VARCHAR(50), -- 'trialing', 'active', 'past_due', 'canceled', 'unpaid'
        plan VARCHAR(50), -- 'monthly', 'annual'
        stripe_price_id VARCHAR(255), -- Stripe price ID reference
        current_period_start TIMESTAMP,
        current_period_end TIMESTAMP,
        cancel_at_period_end BOOLEAN DEFAULT false,
        canceled_at TIMESTAMP,
        trial_start TIMESTAMP,
        trial_end TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create indexes for subscriptions
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer_id ON subscriptions(stripe_customer_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
    `);

    // Create webhook_events table for idempotency
    await client.query(`
      CREATE TABLE IF NOT EXISTS webhook_events (
        id SERIAL PRIMARY KEY,
        stripe_event_id VARCHAR(255) UNIQUE NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        payload JSONB
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_webhook_events_stripe_event_id ON webhook_events(stripe_event_id);
    `);

    // Add stripe_customer_id to users table for faster lookups (optional but recommended)
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255) UNIQUE;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_stripe_customer_id ON users(stripe_customer_id);
    `);

    console.log('✅ Successfully created subscriptions and webhook_events tables');
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
    console.log('Reverting subscriptions and webhook_events tables...');

    await client.query(`DROP INDEX IF EXISTS idx_users_stripe_customer_id;`);
    await client.query(`ALTER TABLE users DROP COLUMN IF EXISTS stripe_customer_id;`);
    
    await client.query(`DROP INDEX IF EXISTS idx_webhook_events_stripe_event_id;`);
    await client.query(`DROP TABLE IF EXISTS webhook_events;`);
    
    await client.query(`DROP INDEX IF EXISTS idx_subscriptions_status;`);
    await client.query(`DROP INDEX IF EXISTS idx_subscriptions_stripe_customer_id;`);
    await client.query(`DROP INDEX IF EXISTS idx_subscriptions_user_id;`);
    await client.query(`DROP TABLE IF EXISTS subscriptions;`);

    console.log('✅ Successfully reverted migration');
  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };

