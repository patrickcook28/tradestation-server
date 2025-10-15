/**
 * Test script to verify the socket limit fix
 * 
 * This script simulates a realistic trading session with multiple concurrent streams:
 * - Multiple bar chart streams (simulating several open charts)
 * - Quote streams for watchlist tickers
 * - Position and order streams for account monitoring
 * 
 * Before the fix: Node.js defaulted to 5 sockets per host, causing the 6th stream to hang.
 * After the fix: Unlimited sockets allow as many concurrent streams as needed.
 * 
 * Usage:
 *   node tests/test_concurrent_streams.js <JWT_TOKEN>
 * 
 * The JWT token should be from a logged-in user with TradeStation credentials.
 */

const http = require('http');

const SERVER_HOST = 'localhost';
const SERVER_PORT = 3001;

// Test configuration
const NUM_STREAMS = 10; // Test with 10 concurrent streams (default limit was 5)
const STREAM_DURATION_MS = 10000; // Keep each stream open for 10 seconds

function makeStreamRequest(path, token, streamId) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: SERVER_HOST,
      port: SERVER_PORT,
      path: path,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Connection': 'keep-alive'
      }
    };

    console.log(`[Stream ${streamId}] Opening stream: ${path}`);
    const startTime = Date.now();
    let connected = false;
    let dataReceived = false;

    const req = http.request(options, (res) => {
      console.log(`[Stream ${streamId}] Connected (status: ${res.statusCode})`);
      connected = true;

      res.on('data', (chunk) => {
        if (!dataReceived) {
          dataReceived = true;
          const elapsed = Date.now() - startTime;
          console.log(`[Stream ${streamId}] First data received after ${elapsed}ms`);
        }
      });

      res.on('end', () => {
        const elapsed = Date.now() - startTime;
        console.log(`[Stream ${streamId}] Stream ended after ${elapsed}ms`);
        resolve({ streamId, connected, dataReceived, elapsed, status: res.statusCode });
      });

      res.on('error', (err) => {
        // Don't treat "aborted" as an error - it's expected when we forcefully close the stream
        if (err.message === 'aborted' && dataReceived) {
          console.log(`[Stream ${streamId}] Stream closed successfully (${err.message})`);
          const elapsed = Date.now() - startTime;
          resolve({ streamId, connected, dataReceived, elapsed, status: res.statusCode, aborted: true });
        } else {
          console.error(`[Stream ${streamId}] Response error:`, err.message);
          reject({ streamId, error: err.message });
        }
      });
    });

    req.on('error', (err) => {
      console.error(`[Stream ${streamId}] Request error:`, err.message);
      reject({ streamId, error: err.message });
    });

    // Close the stream after the specified duration
    setTimeout(() => {
      console.log(`[Stream ${streamId}] Closing stream after ${STREAM_DURATION_MS}ms`);
      req.destroy();
    }, STREAM_DURATION_MS);

    req.end();
  });
}

async function runTest(token) {
  console.log('\n=== Concurrent Multi-Stream Test ===');
  console.log(`Simulating realistic trading session with ${NUM_STREAMS} concurrent streams`);
  console.log(`Testing socket limit fix (default limit was 5 sockets)`);
  console.log(`Stream types: Bar charts, Quotes, Positions, Orders`);
  console.log(`Each stream will run for ${STREAM_DURATION_MS}ms\n`);

  // Define test streams - mix of all stream types to simulate real usage
  const streamPaths = [
    // Bar chart streams (simulating 4 open charts with different timeframes)
    '/tradestation/marketdata/stream/barcharts/AAPL?interval=1&unit=Minute',
    '/tradestation/marketdata/stream/barcharts/MSFT?interval=5&unit=Minute',
    '/tradestation/marketdata/stream/barcharts/SPY?interval=1&unit=Minute',
    '/tradestation/marketdata/stream/barcharts/QQQ?interval=15&unit=Minute',
    // Quote streams (watchlist tickers)
    '/tradestation/stream/quotes?symbols=AAPL,MSFT,GOOGL',
    '/tradestation/stream/quotes?symbols=TSLA,NVDA,META',
    '/tradestation/stream/quotes?symbols=SPY,QQQ,IWM',
    // Account streams (positions and orders)
    '/tradestation/stream/accounts/11591302/positions',
    '/tradestation/stream/accounts/11591302/orders',
    // Additional chart for testing
    '/tradestation/marketdata/stream/barcharts/NVDA?interval=1&unit=Minute',
  ];

  const promises = [];
  const startTime = Date.now();

  // Open all streams concurrently
  for (let i = 0; i < NUM_STREAMS && i < streamPaths.length; i++) {
    promises.push(makeStreamRequest(streamPaths[i], token, i + 1));
  }

  // Wait for all streams to complete
  try {
    const results = await Promise.allSettled(promises);
    const totalTime = Date.now() - startTime;

    console.log('\n=== Test Results ===');
    console.log(`Total test duration: ${totalTime}ms`);
    
    const successful = results.filter(r => r.status === 'fulfilled' && r.value.connected && r.value.dataReceived);
    const connected = results.filter(r => r.status === 'fulfilled' && r.value.connected);
    const failed = results.filter(r => r.status === 'rejected');
    
    console.log(`\nConnection Summary:`);
    console.log(`- Connected: ${connected.length}/${NUM_STREAMS}`);
    console.log(`- Received data: ${successful.length}/${NUM_STREAMS}`);
    console.log(`- Failed to connect: ${failed.length}/${NUM_STREAMS}`);

    // Show status breakdown
    const statusCounts = {};
    connected.forEach(r => {
      const status = r.value.status;
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    });
    console.log(`\nHTTP Status Codes:`);
    Object.entries(statusCounts).forEach(([status, count]) => {
      const note = status === '409' ? ' (Conflict - replaced by newer stream)' : '';
      console.log(`- ${status}: ${count} streams${note}`);
    });

    if (connected.length > 5) {
      console.log('\n✅ SUCCESS: Server handled more than 5 concurrent streams!');
      console.log('The socket limit fix is working correctly.');
      console.log(`\nNote: Before the fix, only 5 streams could connect simultaneously.`);
      console.log(`Now all ${connected.length} streams connected successfully.`);
    } else if (connected.length === 0) {
      console.log('\n❌ FAILURE: No streams connected successfully.');
      console.log('Check server logs and authentication token.');
    } else {
      console.log('\n⚠️  PARTIAL SUCCESS: Some streams connected, but fewer than expected.');
      console.log('Review the errors above for details.');
    }

    if (failed.length > 0) {
      console.log('\nFailed streams (never connected):');
      failed.forEach(r => {
        console.log(`- Stream ${r.reason.streamId}: ${r.reason.error}`);
      });
    }

  } catch (error) {
    console.error('Test error:', error);
  }
}

// Main
const token = process.argv[2];

if (!token) {
  console.error('Usage: node test_concurrent_streams.js <JWT_TOKEN>');
  console.error('\nGet your JWT token by logging in and checking localStorage.token in browser console.');
  process.exit(1);
}

runTest(token).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

