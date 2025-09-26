const { StreamMultiplexer } = require('./streamMultiplexer');

const mux = new StreamMultiplexer({
  name: 'MarketAggregates',
  makeKey: (userId, { ticker }) => [userId, ticker].join('|'),
  buildRequest: (userId, { ticker }) => ({
    // Use Market Depth Quotes stream per TradeStation docs
    // https://api.tradestation.com/docs/specification/#tag/MarketData/operation/StreamMarketDepthQuotes
    path: `/marketdata/stream/marketdepth/quotes/${ticker}`,
    paperTrading: false,
    query: { maxlevels: '50' },
  })
});

module.exports = { ...mux, addSubscriber: mux.addExclusiveSubscriber.bind(mux) };



