const { StreamMultiplexer } = require('./streamMultiplexer');

const mux = new StreamMultiplexer({
  name: 'Bars',
  makeKey: (userId, { ticker, interval, unit, barsback, sessiontemplate }) => [userId, ticker, interval, unit, barsback, sessiontemplate || 'Default'].join('|'),
  buildRequest: (userId, { ticker, interval, unit, barsback, sessiontemplate }) => ({
    path: `/marketdata/stream/barcharts/${ticker}`,
    paperTrading: false,
    query: { interval, unit, barsback, sessiontemplate }
  })
});

// Start periodic cleanup to handle stale connections and pending opens
mux.startPeriodicCleanup(5000); // Check every 5 seconds for aggressive zombie cleanup

// Use addSubscriber (not addExclusiveSubscriber) to allow multiple concurrent streams per user
// The multiplexer will automatically share upstreams when multiple charts use the same ticker/interval/unit
module.exports = { 
  multiplexer: mux,  // Export the instance for debug access
  addSubscriber: mux.addSubscriber.bind(mux) 
};


