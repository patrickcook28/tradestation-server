const { StreamMultiplexer } = require('./streamMultiplexer');

const mux = new StreamMultiplexer({
  name: 'MarketAggregates',
  makeKey: (userId, { ticker }) => [userId, ticker].join('|'),
  buildRequest: (userId, { ticker }) => ({
    // Use Market Depth Aggregates stream for aggregated bids/asks by price level
    // https://api.tradestation.com/docs/specification/#tag/MarketData/operation/StreamMarketDepthAggregates
    path: `/marketdata/stream/marketdepth/aggregates/${ticker}`,
    paperTrading: false,
    query: { maxlevels: '50' },
  })
});

// Start periodic cleanup to handle stale connections and pending opens
mux.startPeriodicCleanup(5000); // Check every 5 seconds for aggressive zombie cleanup

// Use regular addSubscriber (not exclusive) to support multiple concurrent streams
// for different tickers when user has multiple charts open
module.exports = { 
  multiplexer: mux,  // Export the instance for debug access
  addSubscriber: mux.addSubscriber.bind(mux) 
};



