const crypto = require('crypto');
const pool = require('../db');

const PREFIX = 'enc.v1';

function getKey() {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!raw) throw new Error('CREDENTIALS_ENCRYPTION_KEY is not set');
  // Accept base64 or hex; prefer base64
  let key;
  try {
    key = Buffer.from(raw, 'base64');
  } catch (_) {
    key = null;
  }
  if (!key || key.length !== 32) {
    const hex = Buffer.from(raw, 'hex');
    if (hex.length === 32) key = hex;
  }
  if (!key || key.length !== 32) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY must be 32 bytes (base64 or hex)');
  }
  return key;
}

function isEncrypted(value) {
  return typeof value === 'string' && String(value).startsWith(PREFIX + '.');
}

function encryptToken(plaintext) {
  if (plaintext == null) return plaintext;
  if (isEncrypted(plaintext)) return plaintext;
  const key = getKey();
  const iv = crypto.randomBytes(12); // GCM recommended IV size
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}.${iv.toString('base64')}.${tag.toString('base64')}.${ciphertext.toString('base64')}`;
}

function decryptToken(serialized) {
  if (serialized == null) return serialized;
  if (!isEncrypted(serialized)) return serialized; // backward-compat for plaintext values
  const key = getKey();
  const str = String(serialized);
  if (!str.startsWith(PREFIX + '.')) throw new Error('Invalid encrypted token format');
  const rest = str.slice(PREFIX.length + 1); // remove "enc.v1." prefix
  const parts = rest.split('.');
  if (parts.length !== 3) throw new Error('Invalid encrypted token format');
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  return plaintext;
}

async function getUserCredentials(userId) {
  const result = await pool.query('SELECT access_token, refresh_token, expires_at FROM api_credentials WHERE user_id = $1 LIMIT 1', [userId]);
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    access_token: decryptToken(row.access_token),
    refresh_token: decryptToken(row.refresh_token),
    expires_at: row.expires_at
  };
}

async function setUserCredentials(userId, { access_token, refresh_token, expires_at }) {
  const encAccess = encryptToken(access_token);
  const encRefresh = encryptToken(refresh_token);
  const existing = await pool.query('SELECT user_id FROM api_credentials WHERE user_id = $1', [userId]);
  if (existing.rows.length > 0) {
    await pool.query(
      'UPDATE api_credentials SET access_token = $1, refresh_token = $2, expires_at = $3 WHERE user_id = $4',
      [encAccess, encRefresh, expires_at, userId]
    );
  } else {
    await pool.query(
      'INSERT INTO api_credentials (user_id, access_token, refresh_token, expires_at) VALUES ($1, $2, $3, $4)',
      [userId, encAccess, encRefresh, expires_at]
    );
  }
}

async function updateAccessToken(userId, access_token, expires_at) {
  const encAccess = encryptToken(access_token);
  await pool.query('UPDATE api_credentials SET access_token = $1, expires_at = $2 WHERE user_id = $3', [encAccess, expires_at, userId]);
}

module.exports = {
  encryptToken,
  decryptToken,
  getUserCredentials,
  setUserCredentials,
  updateAccessToken,
  isEncrypted
};


