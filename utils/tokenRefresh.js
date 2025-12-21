// Native fetch is available in Node.js 18+
const pool = require('../db');
const { decryptToken, updateAccessToken } = require('./secureCredentials');
const logger = require('../config/logging');

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
    const row = result.rows[0];
    const oauthCredentials = {
      access_token: decryptToken(row.access_token),
      refresh_token: decryptToken(row.refresh_token),
      expires_at: row.expires_at
    };
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
      const status = response.status;
      const text = await response.text();
      let errorData;
      try {
        errorData = JSON.parse(text);
      } catch (_) {
        errorData = { raw: text };
      }

      // Check for client ID mismatch (invalid_grant with client ID mismatch message)
      const isClientIdMismatch = (
        errorData.error === 'invalid_grant' &&
        errorData.error_description &&
        errorData.error_description.includes('client associated with this refresh token') &&
        errorData.error_description.includes('is different than the one sent in the request')
      );

      if (status === 401 || isClientIdMismatch) {
        logger.error(`[TokenRefresh] ⚠️ Clearing credentials for user ${userId} - ${isClientIdMismatch ? 'Client ID mismatch' : '401 Unauthorized'}`);
        try {
          await pool.query('DELETE FROM api_credentials WHERE user_id = $1', [userId]);
          logger.info(`[TokenRefresh] ✅ Credentials cleared for user ${userId}`);
        } catch (deleteErr) {
          logger.error(`[TokenRefresh] ❌ Failed to clear credentials for user ${userId}:`, deleteErr);
        }
        
        // Create a specific error for client ID mismatch
        if (isClientIdMismatch) {
          const err = new Error('Refresh token was issued to a different client ID. Please re-authenticate.');
          err.status = 401;
          err.code = 'CLIENT_ID_MISMATCH';
          err.requiresReauth = true;
          throw err;
        }
      }
      
      const err = new Error(`Attempt to refresh token failed: ${text || status}`);
      err.status = status;
      err.errorData = errorData;
      throw err;
    }

    const json = await response.json();
    const access_token = json['access_token'];
    const expires_at = new Date(Date.now() + 1200 * 1000).toISOString();
    await updateAccessToken(userId, access_token, expires_at);
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


