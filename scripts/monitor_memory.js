#!/usr/bin/env node

/**
 * Memory Monitoring Script
 * 
 * Monitors server memory usage and stream health over time.
 * Use this to verify that the memory leak fixes are working.
 * 
 * Usage:
 *   node scripts/monitor_memory.js [interval_seconds]
 * 
 * Example:
 *   node scripts/monitor_memory.js 10   # Check every 10 seconds
 */

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3001';
const INTERVAL_SECONDS = parseInt(process.argv[2]) || 30;

// Helper to format bytes
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Helper to format duration
function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hours}h ${minutes}m ${secs}s`;
}

let previousSample = null;
let startTime = Date.now();

async function checkMemory() {
  try {
    const response = await fetch(`${SERVER_URL}/debug/memory`);
    if (!response.ok) {
      console.error(`❌ Server responded with ${response.status}`);
      return;
    }
    
    const data = await response.json();
    const uptime = data.uptime || 0;
    const current = data.current || {};
    const growthRate = data.growthRate || null;
    const mapSizes = data.mapSizes || {};
    
    // Parse MB values
    const heapUsed = parseFloat(current.heapUsed?.replace(' MB', '') || 0);
    const heapTotal = parseFloat(current.heapTotal?.replace(' MB', '') || 0);
    const rss = parseFloat(current.rss?.replace(' MB', '') || 0);
    
    // Calculate growth since last check
    let growth = '';
    if (previousSample) {
      const heapGrowth = heapUsed - previousSample.heapUsed;
      const rssGrowth = rss - previousSample.rss;
      const timeElapsed = (Date.now() - previousSample.time) / 1000 / 60; // minutes
      
      const heapGrowthPerMin = heapGrowth / timeElapsed;
      const rssGrowthPerMin = rssGrowth / timeElapsed;
      
      const heapColor = heapGrowthPerMin > 1 ? '🔴' : (heapGrowthPerMin > 0.1 ? '🟡' : '🟢');
      const rssColor = rssGrowthPerMin > 1 ? '🔴' : (rssGrowthPerMin > 0.1 ? '🟡' : '🟢');
      
      growth = `  ${heapColor} Heap: ${heapGrowthPerMin > 0 ? '+' : ''}${heapGrowthPerMin.toFixed(3)} MB/min, ${rssColor} RSS: ${rssGrowthPerMin > 0 ? '+' : ''}${rssGrowthPerMin.toFixed(3)} MB/min`;
    }
    
    // Store current sample
    previousSample = { heapUsed, heapTotal, rss, time: Date.now() };
    
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📊 Memory Report - ${new Date().toLocaleTimeString()}`);
    console.log(`⏱️  Server Uptime: ${formatDuration(uptime)}`);
    console.log(`⏱️  Monitor Running: ${formatDuration((Date.now() - startTime) / 1000)}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    // Memory usage
    console.log('💾 Memory Usage:');
    console.log(`  Heap Used:  ${current.heapUsed?.padEnd(12)} (${heapUsed.toFixed(1)} MB)`);
    console.log(`  Heap Total: ${current.heapTotal?.padEnd(12)} (${heapTotal.toFixed(1)} MB)`);
    console.log(`  RSS:        ${current.rss?.padEnd(12)} (${rss.toFixed(1)} MB)`);
    console.log(`  External:   ${current.external || 'N/A'}`);
    
    if (growth) {
      console.log('');
      console.log('📈 Growth Rate (since last check):');
      console.log(growth);
    }
    
    if (growthRate) {
      console.log('');
      console.log('📊 Overall Growth Rate:');
      console.log(`  ${growthRate.mbPerMinute > 1 ? '🔴' : (growthRate.mbPerMinute > 0.1 ? '🟡' : '🟢')} ${growthRate.mbPerMinute > 0 ? '+' : ''}${growthRate.mbPerMinute.toFixed(3)} MB/min`);
      console.log(`  Projected per hour: ${growthRate.mbPerHour > 0 ? '+' : ''}${growthRate.mbPerHour.toFixed(1)} MB/hour`);
      console.log(`  Time window: ${growthRate.timeWindowMinutes.toFixed(1)} minutes`);
    }
    
    // Stream managers
    console.log('');
    console.log('🌊 Stream Managers:');
    const streamManagers = mapSizes.streamManagers || {};
    for (const [name, stats] of Object.entries(streamManagers)) {
      const total = (stats.connections || 0) + (stats.pendingOpens || 0) + (stats.pendingCleanups || 0);
      const status = total > 0 ? '🟢' : '⚪';
      console.log(`  ${status} ${name.padEnd(10)}: ${stats.connections || 0} active, ${stats.pendingOpens || 0} opening, ${stats.pendingCleanups || 0} cleaning`);
      if (stats.userToLastKey > 0) {
        console.log(`    ${''.padEnd(10)}  ${stats.userToLastKey} tracked users`);
      }
    }
    
    // Background streams
    if (mapSizes.backgroundStreams > 0) {
      console.log('');
      console.log('🔄 Background Streams:');
      console.log(`  ${mapSizes.backgroundStreams} active background stream(s)`);
    }
    
    // Alert engine
    if (mapSizes.alertEngine) {
      const ae = mapSizes.alertEngine;
      const totalAlerts = ae.byId || 0;
      if (totalAlerts > 0) {
        console.log('');
        console.log('🔔 Alert Engine:');
        console.log(`  ${totalAlerts} alert(s) tracked`);
        console.log(`  ${ae.bySymbol || 0} symbol(s) monitored`);
        console.log(`  ${ae.byUser || 0} user(s) with alerts`);
      }
    }
    
    // Memory health assessment
    console.log('');
    console.log('🏥 Health Assessment:');
    
    const warnings = [];
    
    // Check for memory leak indicators
    if (growthRate && growthRate.mbPerHour > 10) {
      warnings.push(`⚠️  High memory growth rate: ${growthRate.mbPerHour.toFixed(1)} MB/hour`);
    }
    
    if (heapUsed > 800) {
      warnings.push(`⚠️  Heap usage approaching 1GB limit: ${heapUsed.toFixed(0)} MB`);
    }
    
    if (rss > 900) {
      warnings.push(`⚠️  RSS approaching 1GB limit: ${rss.toFixed(0)} MB`);
    }
    
    // Check for stale connections
    const totalConnections = Object.values(streamManagers).reduce((sum, s) => sum + (s.connections || 0), 0);
    if (totalConnections > 20) {
      warnings.push(`⚠️  High number of active stream connections: ${totalConnections}`);
    }
    
    if (warnings.length > 0) {
      warnings.forEach(w => console.log(`  ${w}`));
    } else {
      console.log('  ✅ All systems healthy');
    }
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
  }
}

console.log(`🚀 Starting memory monitor (checking every ${INTERVAL_SECONDS}s)`);
console.log(`📡 Server: ${SERVER_URL}`);
console.log(`Press Ctrl+C to stop`);

// Initial check
checkMemory();

// Periodic checks
const interval = setInterval(checkMemory, INTERVAL_SECONDS * 1000);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n👋 Stopping memory monitor...');
  clearInterval(interval);
  process.exit(0);
});




