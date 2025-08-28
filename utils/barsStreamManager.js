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

module.exports = { ...mux, addSubscriber: mux.addExclusiveSubscriber.bind(mux) };


