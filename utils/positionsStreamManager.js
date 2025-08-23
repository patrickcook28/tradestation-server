const { StreamMultiplexer } = require('./streamMultiplexer');

const mux = new StreamMultiplexer({
  name: 'Positions',
  makeKey: (userId, { accountId, paperTrading }) => `${userId}|${String(accountId)}|${paperTrading ? 1 : 0}`,
  buildRequest: (userId, { accountId, paperTrading }) => ({ path: `/brokerage/stream/accounts/${accountId}/positions`, paperTrading: !!paperTrading })
});

module.exports = mux;


