const pool = require('./db');

async function clearStdDevCache() {
  try {
    // Delete all cached std dev levels
    const result = await pool.query('DELETE FROM std_dev_levels');
    console.log(`Cleared std dev levels cache. Rows deleted: ${result.rowCount}`);
  } catch (error) {
    console.error('Error clearing std dev levels cache:', error);
  } finally {
    process.exit(0);
  }
}

clearStdDevCache(); 