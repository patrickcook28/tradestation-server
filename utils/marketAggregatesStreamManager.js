const { StreamMultiplexer } = require('./streamMultiplexer');

const mux = new StreamMultiplexer({
  name: 'MarketAggregates',
  makeKey: (userId, { ticker }) => [userId, ticker].join('|'),
  buildRequest: (userId, { ticker }) => ({
    path: `/marketdata/stream/marketdepth/aggregates/${ticker}`,
    paperTrading: false,
  })
});

module.exports = { ...mux, addSubscriber: mux.addExclusiveSubscriber.bind(mux) };



