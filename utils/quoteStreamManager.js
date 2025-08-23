const { StreamMultiplexer } = require('./streamMultiplexer');

function normalizeSymbolsCsv(csv) {
  const list = String(csv).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  return Array.from(new Set(list)).join(',');
}

const mux = new StreamMultiplexer({
  name: 'Quotes',
  makeKey: (userId, symbolsCsv) => `${userId}|${normalizeSymbolsCsv(symbolsCsv)}`,
  buildRequest: (userId, symbolsCsv) => ({ path: `/marketdata/stream/quotes/${normalizeSymbolsCsv(symbolsCsv)}`, paperTrading: false })
});

module.exports = mux;


