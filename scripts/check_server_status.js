/**
 * CLI tool to check server status and identify stuck requests
 * 
 * Usage:
 *   node scripts/check_server_status.js [interval_seconds]
 * 
 * Examples:
 *   node scripts/check_server_status.js          # Single check
 *   node scripts/check_server_status.js 5        # Check every 5 seconds
 */

const http = require('http');

const SERVER_HOST = process.env.SERVER_HOST || 'localhost';
const SERVER_PORT = process.env.SERVER_PORT || 3001;

function checkStatus() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: SERVER_HOST,
      port: SERVER_PORT,
      path: '/debug/server-status',
      method: 'GET',
    };

    const req = http.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const status = JSON.parse(data);
          resolve(status);
        } catch (err) {
          reject(new Error(`Failed to parse response: ${err.message}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

function formatBytes(bytes) {
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function formatUptime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hours}h ${minutes}m ${secs}s`;
}

function displayStatus(status) {
  console.clear();
  console.log('='.repeat(80));
  console.log(`SERVER STATUS - ${status.timestamp}`);
  console.log('='.repeat(80));
  
  // Active Streams & Requests
  console.log('\n📊 ACTIVE CONNECTIONS:');
  console.log(`   Active Streams: ${status.activeStreams.total}`);
  console.log(`   Active Requests: ${status.activeRequests.total}`);
  
  // HTTP Agent (Socket Limit)
  if (status.httpAgent && !status.httpAgent.error) {
    console.log('\n🔌 HTTP AGENT (SOCKET LIMIT):');
    const maxSockets = status.httpAgent.maxSockets === Infinity ? 'Unlimited ✓' : 
                       status.httpAgent.maxSockets === null ? 'null' : 
                       status.httpAgent.maxSockets;
    console.log(`   Max Sockets: ${maxSockets}`);
    console.log(`   Fix Verified: ${status.httpAgent.isUnlimited ? '✅ YES (>5 sockets active)' : '❌ NO (might still have limit)'}`);
    console.log(`   Active Sockets: ${status.httpAgent.totalActiveSockets}`);
    console.log(`   Free Sockets: ${status.httpAgent.totalFreeSockets}`);
    console.log(`   Pending Requests: ${status.httpAgent.totalPendingRequests}`);
    
    if (status.httpAgent.totalPendingRequests > 0) {
      console.log(`   🔴 SOCKET BOTTLENECK: ${status.httpAgent.totalPendingRequests} requests waiting for socket!`);
      Object.entries(status.httpAgent.requests).forEach(([host, count]) => {
        console.log(`      ${host}: ${count} pending`);
      });
    }
    
    if (status.httpAgent.sockets && Object.keys(status.httpAgent.sockets).length > 0) {
      console.log(`   Sockets by host:`);
      Object.entries(status.httpAgent.sockets).forEach(([host, count]) => {
        const indicator = count > 5 ? '✅' : '  ';
        console.log(`      ${indicator} ${host}: ${count} active`);
      });
    }
  }
  
  // Database
  if (status.database && !status.database.error) {
    console.log('\n💾 DATABASE POOL:');
    const poolUsage = ((status.database.totalConnections / status.database.maxConnections) * 100).toFixed(1);
    console.log(`   Used: ${status.database.totalConnections}/${status.database.maxConnections} (${poolUsage}%)`);
    console.log(`   Idle: ${status.database.idleConnections}`);
    console.log(`   Waiting: ${status.database.waitingRequests}`);
    
    if (status.database.waitingRequests > 0) {
      console.log(`   ⚠️  WARNING: ${status.database.waitingRequests} requests waiting for DB connection!`);
    }
  }
  
  // Process
  console.log('\n⚙️  PROCESS:');
  console.log(`   Uptime: ${formatUptime(status.process.uptime)}`);
  console.log(`   Memory: ${formatBytes(status.process.memory.heapUsed)} / ${formatBytes(status.process.memory.heapTotal)}`);
  console.log(`   RSS: ${formatBytes(status.process.memory.rss)}`);
  
  // Active Streams Details
  if (status.activeStreams && status.activeStreams.streams.length > 0) {
    console.log('\n🌊 ACTIVE STREAMS:');
    status.activeStreams.streams.slice(0, 10).forEach((stream) => {
      const urlShort = stream.url.length > 70 ? stream.url.substring(0, 67) + '...' : stream.url;
      console.log(`   [${stream.id}] ${stream.method} ${urlShort}`);
    });
    if (status.activeStreams.total > 10) {
      console.log(`   ... and ${status.activeStreams.total - 10} more streams`);
    }
  }
  
  // Active Request Details (non-streaming)
  if (status.activeRequests && status.activeRequests.requests.length > 0) {
    console.log('\n🔍 ACTIVE REQUESTS (non-streaming):');
    status.activeRequests.requests.forEach((req) => {
      const duration = (req.duration / 1000).toFixed(2);
      console.log(`   [${req.id}] ${duration}s - ${req.method} ${req.url}`);
    });
  }
  
  // Warnings
  const warnings = [];
  if (status.httpAgent && status.httpAgent.totalPendingRequests > 0) {
    warnings.push(`🔴 ${status.httpAgent.totalPendingRequests} requests waiting for HTTP socket (SOCKET LIMIT ISSUE!)`);
  }
  if (status.activeStreams && status.activeStreams.total > 20) {
    warnings.push(`⚠️  High stream count: ${status.activeStreams.total} concurrent streams (possible leak?)`);
  }
  if (status.database && status.database.waitingRequests > 0) {
    warnings.push(`${status.database.waitingRequests} requests waiting for DB connection`);
  }
  if (status.database && status.database.totalConnections >= status.database.maxConnections * 0.9) {
    warnings.push('Database pool near capacity');
  }
  
  if (warnings.length > 0) {
    console.log('\n⚠️  WARNINGS:');
    warnings.forEach(w => console.log(`   - ${w}`));
  } else if (status.activeStreams && status.activeStreams.total === 0 && status.activeRequests && status.activeRequests.total === 0) {
    console.log('\n✅ Server is idle - no active connections');
  } else {
    console.log('\n✅ Server is healthy');
  }
  
  console.log('\n' + '='.repeat(80));
}

async function main() {
  const intervalSeconds = parseInt(process.argv[2]);
  const continuous = !isNaN(intervalSeconds) && intervalSeconds > 0;
  
  if (continuous) {
    console.log(`Monitoring server every ${intervalSeconds} seconds...`);
    console.log('Press Ctrl+C to stop\n');
    
    // Initial check
    try {
      const status = await checkStatus();
      displayStatus(status);
    } catch (err) {
      console.error(`Error: ${err.message}`);
    }
    
    // Repeat
    setInterval(async () => {
      try {
        const status = await checkStatus();
        displayStatus(status);
      } catch (err) {
        console.error(`Error: ${err.message}`);
      }
    }, intervalSeconds * 1000);
  } else {
    // Single check
    try {
      const status = await checkStatus();
      displayStatus(status);
      process.exit(0);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  }
}

main();

