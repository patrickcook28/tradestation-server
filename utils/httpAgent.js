/**
 * Custom HTTP/HTTPS agents for node-fetch with increased socket limits
 * to support many concurrent streaming connections without blocking.
 * 
 * Node.js default maxSockets is 5 per host, which causes requests to hang
 * when multiple streaming connections are active (quotes, positions, orders, etc.)
 */

const http = require('http');
const https = require('https');

// Create agents with unlimited sockets (Infinity = no limit)
// This prevents socket exhaustion when multiple streaming connections are open
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000, // Keep connections alive for 60 seconds
  maxSockets: Infinity,   // No limit on concurrent sockets (was 5 by default)
  maxFreeSockets: 256,    // Keep up to 256 idle sockets ready for reuse
  timeout: 0,             // No socket timeout for streaming connections
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: Infinity,
  maxFreeSockets: 256,
  timeout: 0,
  rejectUnauthorized: true, // Verify SSL certificates
});

/**
 * Get the appropriate agent for a given URL
 * @param {string} url - The URL to fetch
 * @returns {http.Agent|https.Agent} The appropriate agent
 */
function getAgentForUrl(url) {
  return url.startsWith('https://') ? httpsAgent : httpAgent;
}

/**
 * Get fetch options with the appropriate agent for the URL
 * @param {string} url - The URL to fetch
 * @param {object} options - Base fetch options
 * @param {number} timeoutMs - Optional timeout in milliseconds (default: 30000)
 * @returns {object} Fetch options with agent configured
 */
function getFetchOptionsWithAgent(url, options = {}, timeoutMs = 30000) {
  return {
    ...options,
    agent: getAgentForUrl(url),
    timeout: timeoutMs, // Set fetch timeout to prevent hanging requests
  };
}

module.exports = {
  httpAgent,
  httpsAgent,
  getAgentForUrl,
  getFetchOptionsWithAgent,
};

