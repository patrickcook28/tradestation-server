const { StreamMultiplexer } = require('./streamMultiplexer');
const logger = require('../config/logging');

const mux = new StreamMultiplexer({
  name: 'Positions',
  makeKey: (userId, { accountId, paperTrading }) => `${userId}|${String(accountId)}|${paperTrading ? 1 : 0}`,
  buildRequest: (userId, { accountId, paperTrading }) => ({ 
    path: `/brokerage/stream/accounts/${accountId}/positions`, 
    paperTrading: !!paperTrading,
    query: { changes: 'true' } // Only send changes after initial snapshot to prevent duplicates
  })
});

// Wrap addSubscriber to inject lightweight start log and heartbeat to subscribers
const addSubscriber = async (userId, deps, res) => {
  if (process.env.DEBUG_STREAMS === 'true') try { logger.debug(`[Positions] addSubscriber user=${userId} account=${deps && deps.accountId} paper=${!!(deps && deps.paperTrading)}`); } catch (_) {}

  // Add periodic heartbeat to keep client-side connection active even if upstream is idle
  try {
    res.setHeader('Content-Type', 'application/json');
  } catch (_) {}
  const heartbeat = setInterval(() => {
    try { res.write('{"Heartbeat":true}\n'); } catch (_) {}
  }, 15000);
  res.on('close', () => { try { clearInterval(heartbeat); } catch (_) {} });

  return mux.addExclusiveSubscriber(userId, deps, res);
};

// For background streams - non-exclusive, simpler setup
const addBackgroundSubscriber = async (userId, deps, res) => {
  if (process.env.DEBUG_STREAMS === 'true') try { logger.debug(`[Positions] addBackgroundSubscriber user=${userId} account=${deps && deps.accountId} paper=${!!(deps && deps.paperTrading)}`); } catch (_) {}
  return mux.addSubscriber(userId, deps, res);
};

module.exports = { 
  multiplexer: mux,  // Export the instance for debug access
  addSubscriber, 
  addBackgroundSubscriber 
};


