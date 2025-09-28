const pool = require('../db');

// Reads the single-row maintenance_mode table and returns { is_enabled, message }
async function getMaintenanceStatus() {
  try {
    const res = await pool.query('SELECT is_enabled, message FROM maintenance_mode LIMIT 1');
    if (res.rows && res.rows[0]) {
      return { is_enabled: !!res.rows[0].is_enabled, message: res.rows[0].message || '' };
    }
    return { is_enabled: false, message: '' };
  } catch (_) {
    return { is_enabled: false, message: '' };
  }
}

module.exports = { getMaintenanceStatus };


