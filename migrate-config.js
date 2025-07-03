module.exports = {
  migrationFolder: './migrations',
  direction: 'up',
  databaseUrl:
    process.env.DATABASE_URL ||
    `postgres://${process.env.PGUSER || 'postgres'}:${process.env.PGPASSWORD || ''}@${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE || 'tradestation'}`,
  migrationsTable: 'pgmigrations',
  schema: 'public'
}; 