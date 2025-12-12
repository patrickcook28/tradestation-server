const { StreamMultiplexer } = require('./streamMultiplexer');

function normalizeSymbolsCsv(csv) {
  const list = String(csv).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  // Deduplicate and sort to ensure stable keys regardless of order
  return Array.from(new Set(list)).sort().join(',');
}

const mux = new StreamMultiplexer({
  name: 'Quotes',
  makeKey: (userId, symbolsCsv) => `${userId}|${normalizeSymbolsCsv(symbolsCsv)}`,
  buildRequest: (userId, symbolsCsv) => ({ path: `/marketdata/stream/quotes/${normalizeSymbolsCsv(symbolsCsv)}`, paperTrading: false })
});

// MEMORY LEAK FIX: Don't use exclusive subscribers for quotes
// This allows user streams and background alert streams to share the same upstream connection
// The stream only closes when ALL subscribers (user + background) disconnect
// This prevents the infinite reconnection loop that was causing memory leaks
module.exports = { 
  multiplexer: mux,  // Export the instance for debug access
  // Both user streams and background streams use non-exclusive mode
  addSubscriber: mux.addSubscriber.bind(mux),
  addBackgroundSubscriber: mux.addSubscriber.bind(mux)
};


