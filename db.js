const dotenv = require("dotenv");
const { Pool } = require('pg');

dotenv.config({ path: './.env'})

// const pool = new Pool({
//   host: process.env.PGHOST,
//   user: process.env.PGUSER,
//   password: process.env.PGPASSWORD,
//   database: process.env.PGDATABASE,
//   port: process.env.PGPORT || 5432
// });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
  // Increase pool size to handle multiple tabs with streaming connections
  max: 50, // Maximum number of clients in the pool (was 10 default)
  min: 5,  // Minimum number of clients to keep alive
  idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
  connectionTimeoutMillis: 10000, // Return error after 10 seconds if no connection available
});

// Monitor pool events for debugging
let logPoolEvents = false; // Enable with pool.logPoolEvents = true

pool.on('connect', (client) => {
  if (logPoolEvents) {
    console.log(`[DB Pool] Client connected. Total: ${pool.totalCount}, Idle: ${pool.idleCount}, Waiting: ${pool.waitingCount}`);
  }
});

pool.on('acquire', (client) => {
  if (logPoolEvents) {
    console.log(`[DB Pool] Client acquired. Total: ${pool.totalCount}, Idle: ${pool.idleCount}, Waiting: ${pool.waitingCount}`);
  }
});

pool.on('release', (client) => {
  if (logPoolEvents) {
    console.log(`[DB Pool] Client released. Total: ${pool.totalCount}, Idle: ${pool.idleCount}, Waiting: ${pool.waitingCount}`);
  }
});

pool.on('error', (err, client) => {
  console.error('[DB Pool] Unexpected error on idle client', err);
});

// Log warning when pool is getting full
const checkPoolCapacity = () => {
  const usage = pool.totalCount / pool.options.max;
  if (usage > 0.8 && pool.waitingCount > 0) {
    console.warn(`[DB Pool] ⚠️  High usage: ${pool.totalCount}/${pool.options.max} connections, ${pool.waitingCount} waiting`);
  }
};

// Check pool capacity periodically
setInterval(checkPoolCapacity, 5000);

// Export method to enable detailed logging
pool.enableDetailedLogging = () => {
  logPoolEvents = true;
  console.log('[DB Pool] Detailed logging enabled');
};

pool.disableDetailedLogging = () => {
  logPoolEvents = false;
  console.log('[DB Pool] Detailed logging disabled');
};

module.exports = pool;