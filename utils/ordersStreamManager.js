const { StreamMultiplexer } = require('./streamMultiplexer');
const logger = require('../config/logging');

const mux = new StreamMultiplexer({
  name: 'Orders',
  makeKey: (userId, { accountId, paperTrading }) => `${userId}|${String(accountId)}|${paperTrading ? 1 : 0}`,
  buildRequest: (userId, { accountId, paperTrading }) => ({ path: `/brokerage/stream/accounts/${accountId}/orders`, paperTrading: !!paperTrading })
});

// Add consistent logging and heartbeat to orders stream as well
const addSubscriber = async (userId, deps, res) => {
  if (process.env.DEBUG_STREAMS === 'true') try { logger && logger.info && logger.info(`[Orders] addSubscriber user=${userId} account=${deps && deps.accountId} paper=${!!(deps && deps.paperTrading)}`); } catch (_) {}

  try { res.setHeader('Content-Type', 'application/json'); } catch (_) {}
  const heartbeat = setInterval(() => {
    try { res.write('{"Heartbeat":true}\n'); } catch (_) {}
  }, 15000);
  res.on('close', () => { try { clearInterval(heartbeat); } catch (_) {} });

  return mux.addExclusiveSubscriber(userId, deps, res);
};

// For background streams - non-exclusive, simpler setup
const addBackgroundSubscriber = async (userId, deps, res) => {
  if (process.env.DEBUG_STREAMS === 'true') try { logger && logger.info && logger.info(`[Orders] addBackgroundSubscriber user=${userId} account=${deps && deps.accountId} paper=${!!(deps && deps.paperTrading)}`); } catch (_) {}
  return mux.addSubscriber(userId, deps, res);
};

module.exports = { 
  multiplexer: mux,  // Export the instance for debug access
  addSubscriber, 
  addBackgroundSubscriber 
};


