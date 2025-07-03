const dotenv = require("dotenv");
const { Pool } = require('pg');

dotenv.config({ path: './.env'})

const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT || 5432
});

module.exports = pool;