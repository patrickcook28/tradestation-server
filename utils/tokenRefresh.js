const fetch = require('node-fetch');
const pool = require('../db');

// Ensures only one refresh per user runs at a time across all managers
const inFlightRefresh = new Map(); // userId -> Promise<{access_token, expires_at}>

async function refreshAccessTokenForUserLocked(userId) {
  const existing = inFlightRefresh.get(userId);
  if (existing) {
    return existing; // Reuse in-flight refresh
  }

  const promise = (async () => {
    const result = await pool.query('SELECT * FROM api_credentials WHERE user_id = $1', [userId]);
    if (result.rows.length === 0) {
      throw new Error('User not found');
    }
    const oauthCredentials = result.rows[0];
    const token_url = 'https://signin.tradestation.com/oauth/token';
    const data = {
      'grant_type': 'refresh_token',
      'client_id': process.env.TRADESTATION_CLIENT_ID,
      'client_secret': process.env.TRADESTATION_CLIENT_SECRET,
      'refresh_token': oauthCredentials.refresh_token
    };
    const response = await fetch(token_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Attempt to refresh token failed: ${text || response.status}`);
    }
    const json = await response.json();
    const access_token = json['access_token'];
    const expires_at = new Date(Date.now() + 1200 * 1000).toISOString();
    await pool.query('UPDATE api_credentials SET access_token = $1, expires_at = $2 WHERE user_id = $3', [access_token, expires_at, userId]);
    return { access_token, expires_at };
  })();

  inFlightRefresh.set(userId, promise);
  try {
    const result = await promise;
    return result;
  } finally {
    inFlightRefresh.delete(userId);
  }
}

module.exports = { refreshAccessTokenForUserLocked };


