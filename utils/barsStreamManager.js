const { StreamMultiplexer } = require('./streamMultiplexer');
const logger = require('../config/logging');

const mux = new StreamMultiplexer({
  name: 'Bars',
  makeKey: (userId, { ticker, interval, unit, barsback, sessiontemplate }) => {
    const key = [userId, ticker, interval, unit, barsback, sessiontemplate || 'Default'].join('|');
    return key;
  },
  buildRequest: (userId, { ticker, interval, unit, barsback, sessiontemplate }) => {
    logger.info(`[Bars] 🔌 Stream requested: ${ticker} ${interval}${unit} (barsback: ${barsback || 100}, session: ${sessiontemplate || 'Default'}) for user ${userId}`);
    return {
      path: `/marketdata/stream/barcharts/${ticker}`,
      paperTrading: false,
      query: { interval, unit, barsback, sessiontemplate }
    };
  }
});

// Wrap addSubscriber to add connection lifecycle logging
const originalAddSubscriber = mux.addSubscriber.bind(mux);
const wrappedAddSubscriber = async (userId, params, res) => {
  const { ticker, interval, unit, barsback, sessiontemplate } = params;
  const streamDesc = `${ticker} ${interval}${unit} (barsback: ${barsback || 100}, session: ${sessiontemplate || 'Default'})`;
  
  // Track when stream actually starts sending data
  let firstBarReceived = false;
  let barCount = 0;
  let lastLogTime = Date.now();
  
  // Intercept the response write to log bar reception
  const originalWrite = res.write.bind(res);
  res.write = (chunk) => {
    try {
      // Try to parse and log bar data
      const chunkStr = chunk.toString('utf8');
      const lines = chunkStr.split('\n').filter(line => line.trim());
      
      lines.forEach(line => {
        try {
          const data = JSON.parse(line);
          
          if (data.Heartbeat) {
            // Only log heartbeat in debug mode
            if (process.env.DEBUG_STREAMS === 'true') {
              logger.debug(`[Bars] 💓 Heartbeat: ${streamDesc}`);
            }
          } else if (data.LateJoin) {
            logger.info(`[Bars] 🔄 Late join notification: ${streamDesc}`);
          } else if (data.Error || data.Message) {
            logger.error(`[Bars] ❌ Stream error: ${streamDesc} - ${data.Message}`);
          } else if (data.Symbol || data.TimeStamp) {
            // This is actual bar data
            if (!firstBarReceived) {
              firstBarReceived = true;
              logger.info(`[Bars] ✅ First bar received: ${streamDesc} (Symbol: ${data.Symbol}, Time: ${data.TimeStamp})`);
            }
            barCount++;
            
            // Log bar count every 10 seconds to show stream is active
            const now = Date.now();
            if (now - lastLogTime > 10000) {
              logger.info(`[Bars] 📊 Stream active: ${streamDesc} (${barCount} bars received)`);
              lastLogTime = now;
            }
          }
        } catch (parseErr) {
          // Ignore parse errors (partial chunks, etc.)
        }
      });
    } catch (err) {
      // Ignore logging errors
    }
    
    // Call original write
    return originalWrite(chunk);
  };
  
  // Log connection attempt
  logger.info(`[Bars] 🔄 Connecting stream: ${streamDesc} for user ${userId}`);
  
  try {
    const result = await originalAddSubscriber(userId, params, res);
    logger.info(`[Bars] ✓ Stream connected: ${streamDesc}`);
    return result;
  } catch (err) {
    logger.error(`[Bars] ❌ Stream connection failed: ${streamDesc} - ${err.message}`);
    throw err;
  }
};

// Use addSubscriber (not addExclusiveSubscriber) to allow multiple concurrent streams per user
// The multiplexer will automatically share upstreams when multiple charts use the same ticker/interval/unit
module.exports = { 
  multiplexer: mux,  // Export the instance for debug access
  addSubscriber: wrappedAddSubscriber
};


