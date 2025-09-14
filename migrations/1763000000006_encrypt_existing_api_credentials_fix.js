/* eslint-disable camelcase */

// Encrypt existing plaintext credentials after columns were expanded

exports.shorthands = undefined;

exports.up = async (pgm) => {
  const { encryptToken, isEncrypted } = require('../utils/secureCredentials');

  if (!process.env.CREDENTIALS_ENCRYPTION_KEY) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY must be set to run this migration');
  }

  const { rows } = await pgm.db.query('SELECT user_id, access_token, refresh_token FROM api_credentials');
  for (const row of rows) {
    const userId = row.user_id;
    const currentAccess = row.access_token;
    const currentRefresh = row.refresh_token;

    const encAccess = isEncrypted(currentAccess) ? currentAccess : encryptToken(currentAccess);
    const encRefresh = isEncrypted(currentRefresh) ? currentRefresh : encryptToken(currentRefresh);

    if (encAccess !== currentAccess || encRefresh !== currentRefresh) {
      await pgm.db.query('UPDATE api_credentials SET access_token = $1, refresh_token = $2 WHERE user_id = $3', [encAccess, encRefresh, userId]);
    }
  }
};

exports.down = async (pgm) => {
  // Irreversible
};


