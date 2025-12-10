const pool = require('../db');
const backgroundStreamManager = require('../utils/backgroundStreamManager');
const alertEngine = require('../workers/alertEngine');
const { createTransport } = require('../config/email');
const v8 = require('v8');
const fs = require('fs');
const path = require('path');

// Project root directory for heap snapshots
const projectRoot = path.join(__dirname, '..');

// Lightweight memory tracking (no overhead)
const memorySnapshots = [];
const MAX_SNAPSHOTS = 1000; // Keep last 1000 samples

// Take a snapshot every 30 seconds
setInterval(() => {
  const mem = process.memoryUsage();
  memorySnapshots.push({
    timestamp: Date.now(),
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    rss: mem.rss
  });
  
  // Keep only last MAX_SNAPSHOTS
  if (memorySnapshots.length > MAX_SNAPSHOTS) {
    memorySnapshots.shift();
  }
}, 30000);

/**
 * Deep parse a heap snapshot with detailed object analysis
 */
function deepParseHeapSnapshot(filepath) {
  const data = fs.readFileSync(filepath, 'utf8');
  const heap = JSON.parse(data);
  
  if (!heap.nodes || !heap.snapshot) return null;
  
  const nodeFields = heap.snapshot.meta.node_fields;
  const nodeTypes = heap.snapshot.meta.node_types[0];
  const edgeFields = heap.snapshot.meta.edge_fields;
  const edgeTypes = heap.snapshot.meta.edge_types[0];
  
  const typeIdx = nodeFields.indexOf('type');
  const nameIdx = nodeFields.indexOf('name');
  const idIdx = nodeFields.indexOf('id');
  const sizeIdx = nodeFields.indexOf('self_size');
  const edgeCountIdx = nodeFields.indexOf('edge_count');
  const fieldCount = nodeFields.length;
  
  const edgeTypeIdx = edgeFields.indexOf('type');
  const edgeNameIdx = edgeFields.indexOf('name_or_index');
  const edgeToNodeIdx = edgeFields.indexOf('to_node');
  const edgeFieldCount = edgeFields.length;
  
  // Build node index
  const nodes = [];
  const nodeById = new Map();
  
  for (let i = 0; i < heap.nodes.length; i += fieldCount) {
    const node = {
      index: i,
      type: nodeTypes[heap.nodes[i + typeIdx]],
      name: heap.strings[heap.nodes[i + nameIdx]] || '',
      id: heap.nodes[i + idIdx],
      selfSize: heap.nodes[i + sizeIdx],
      edgeCount: heap.nodes[i + edgeCountIdx],
      edges: []
    };
    nodes.push(node);
    nodeById.set(node.index, node);
  }
  
  // Build edges
  let edgeIndex = 0;
  for (const node of nodes) {
    for (let i = 0; i < node.edgeCount; i++) {
      const baseIdx = heap.edges[edgeIndex * edgeFieldCount];
      const edge = {
        type: edgeTypes[heap.edges[edgeIndex * edgeFieldCount + edgeTypeIdx]],
        nameOrIndex: heap.edges[edgeIndex * edgeFieldCount + edgeNameIdx],
        toNode: heap.edges[edgeIndex * edgeFieldCount + edgeToNodeIdx]
      };
      
      // Resolve edge name
      if (edge.type === 'property' || edge.type === 'internal') {
        edge.name = heap.strings[edge.nameOrIndex] || edge.nameOrIndex;
      } else {
        edge.name = edge.nameOrIndex;
      }
      
      node.edges.push(edge);
      edgeIndex++;
    }
  }
  
  return { nodes, nodeById, strings: heap.strings };
}

/**
 * Find large Maps, Sets, Arrays and their contents
 */
function analyzeLargeCollections(parsedHeap) {
  const collections = [];
  
  for (const node of parsedHeap.nodes) {
    // Look for Maps, Sets, Arrays with significant size or edge count
    if ((node.type === 'object' && (node.name === 'Map' || node.name === 'Set')) ||
        node.type === 'array') {
      
      if (node.selfSize > 100000 || node.edgeCount > 100) {
        // Try to find what this collection contains
        const samples = [];
        for (let i = 0; i < Math.min(node.edges.length, 20); i++) {
          const edge = node.edges[i];
          const targetNode = parsedHeap.nodeById.get(edge.toNode);
          if (targetNode) {
            samples.push({
              edgeName: edge.name,
              targetType: targetNode.type,
              targetName: targetNode.name,
              targetSize: targetNode.selfSize
            });
          }
        }
        
        collections.push({
          type: node.type,
          name: node.name,
          selfSize: node.selfSize,
          edgeCount: node.edgeCount,
          samples
        });
      }
    }
  }
  
  return collections.sort((a, b) => b.selfSize - a.selfSize);
}

/**
 * Compare two heap snapshots and find what's growing
 */
function diffHeapSnapshots(stats1, stats2) {
  const growth = [];
  
  // Find nodes that grew
  for (const [key, data2] of Object.entries(stats2.nodes)) {
    const data1 = stats1.nodes[key] || { count: 0, totalSize: 0 };
    
    const countGrowth = data2.count - data1.count;
    const sizeGrowth = data2.totalSize - data1.totalSize;
    
    if (countGrowth > 0 || sizeGrowth > 0) {
      growth.push({
        type: data2.type,
        name: data2.name,
        countBefore: data1.count,
        countAfter: data2.count,
        countGrowth,
        sizeBefore: data1.totalSize,
        sizeAfter: data2.totalSize,
        sizeGrowth,
        sizeGrowthMB: (sizeGrowth / 1024 / 1024).toFixed(2)
      });
    }
  }
  
  // Sort by size growth (biggest leaks first)
  growth.sort((a, b) => b.sizeGrowth - a.sizeGrowth);
  
  return growth;
}

/**
 * Health check endpoint for Railway/container orchestration
 * GET /health
 */
const health = async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: Date.now(),
    db: 'unknown',
    email: 'unknown'
  };
  
  // Check database
  try {
    await pool.query('SELECT 1');
    health.db = 'connected';
  } catch (err) {
    console.error('[Health] Database check failed:', err.message);
    health.db = 'disconnected';
    health.dbError = err.message;
    health.status = 'unhealthy';
  }
  
  // Check Resend API connectivity
  // try {
  //   const transporter = createTransport();
  //   await transporter.verify();
  //   health.email = 'connected';
  // } catch (err) {
  //   console.error('[Health] Email check failed:', err.message);
  //   health.email = 'disconnected';
  //   health.emailError = err.message;
  //   // Don't mark unhealthy for email - it's not critical for app function
  // }
  
  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
};

/**
 * HTML status page with DB status and users
 * GET /status
 */
const status = async (req, res) => {
  let dbStatus = 'Unknown';
  let users = [];
  try {
    await pool.query('SELECT 1');
    dbStatus = 'Connected';
    const result = await pool.query('SELECT id, email FROM users ORDER BY id');
    users = result.rows;
  } catch (err) {
    dbStatus = 'Error: ' + err.message;
  }
  res.render('status', { dbStatus, users });
};

/**
 * Consolidated debug endpoint - all diagnostics in one place
 * GET /debug
 */
const debug = async (req, res) => {
  try {
    const barsManager = require('../utils/barsStreamManager');
    const quotesManager = require('../utils/quoteStreamManager');
    const ordersManager = require('../utils/ordersStreamManager');
    const positionsManager = require('../utils/positionsStreamManager');
    const { getRequestStats } = require('../utils/requestMonitor');
    
    const debugInfo = {
      timestamp: new Date().toISOString(),
      server: getRequestStats ? getRequestStats() : {},
      streams: {
        bars: barsManager.getDebugInfo ? barsManager.getDebugInfo() : [],
        quotes: quotesManager.getDebugInfo ? quotesManager.getDebugInfo() : [],
        orders: ordersManager.getDebugInfo ? ordersManager.getDebugInfo() : [],
        positions: positionsManager.getDebugInfo ? positionsManager.getDebugInfo() : []
      },
      backgroundStreams: backgroundStreamManager.getStatus(),
      alertEngine: alertEngine.getStats()
    };
    
    res.json(debugInfo);
  } catch (error) {
    console.error('Error getting debug info:', error);
    res.status(500).json({ error: 'Failed to get debug info', message: error.message });
  }
};

/**
 * Memory usage and leak detection
 * GET /debug/memory
 */
const memory = async (req, res) => {
  try {
    const mem = process.memoryUsage();
    const barsManager = require('../utils/barsStreamManager');
    const quotesManager = require('../utils/quoteStreamManager');
    const ordersManager = require('../utils/ordersStreamManager');
    const positionsManager = require('../utils/positionsStreamManager');
    
    // Get map sizes from all managers
    const mapSizes = {
      backgroundStreams: backgroundStreamManager.streams?.size || 0,
      alertEngine: {
        bySymbol: alertEngine.alertsBySymbol?.size || 0,
        byId: alertEngine.alertsById?.size || 0,
        byUser: alertEngine.alertsByUser?.size || 0,
        pendingLogWrites: alertEngine.pendingLogWrites?.length || 0
      },
      streamManagers: {
        bars: {
          connections: barsManager.keyToConnection?.size || 0,
          pendingOpens: barsManager.pendingOpens?.size || 0,
          pendingCleanups: barsManager.pendingCleanups?.size || 0,
          userToLastKey: barsManager.userToLastKey?.size || 0
        },
        quotes: {
          connections: quotesManager.keyToConnection?.size || 0,
          pendingOpens: quotesManager.pendingOpens?.size || 0,
          pendingCleanups: quotesManager.pendingCleanups?.size || 0,
          userToLastKey: quotesManager.userToLastKey?.size || 0
        },
        orders: {
          connections: ordersManager.keyToConnection?.size || 0,
          pendingOpens: ordersManager.pendingOpens?.size || 0,
          pendingCleanups: ordersManager.pendingCleanups?.size || 0,
          userToLastKey: ordersManager.userToLastKey?.size || 0
        },
        positions: {
          connections: positionsManager.keyToConnection?.size || 0,
          pendingOpens: positionsManager.pendingOpens?.size || 0,
          pendingCleanups: positionsManager.pendingCleanups?.size || 0,
          userToLastKey: positionsManager.userToLastKey?.size || 0
        }
      }
    };
    
    // Calculate growth rate from snapshots
    let growthRate = null;
    if (memorySnapshots.length >= 2) {
      const first = memorySnapshots[0];
      const last = memorySnapshots[memorySnapshots.length - 1];
      const timeElapsed = (last.timestamp - first.timestamp) / 1000 / 60; // minutes
      const memoryGrowth = last.heapUsed - first.heapUsed;
      growthRate = {
        mbPerMinute: (memoryGrowth / 1024 / 1024) / timeElapsed,
        mbPerHour: ((memoryGrowth / 1024 / 1024) / timeElapsed) * 60,
        timeWindowMinutes: timeElapsed
      };
    }
    
    res.json({
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      current: {
        rss: `${(mem.rss / 1024 / 1024).toFixed(2)} MB`,
        heapTotal: `${(mem.heapTotal / 1024 / 1024).toFixed(2)} MB`,
        heapUsed: `${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`,
        external: `${(mem.external / 1024 / 1024).toFixed(2)} MB`,
        arrayBuffers: `${(mem.arrayBuffers / 1024 / 1024).toFixed(2)} MB`
      },
      growthRate,
      mapSizes,
      snapshots: {
        count: memorySnapshots.length,
        samples: memorySnapshots.slice(-20).map(s => ({
          time: new Date(s.timestamp).toISOString(),
          heapUsedMB: (s.heapUsed / 1024 / 1024).toFixed(2),
          rssMB: (s.rss / 1024 / 1024).toFixed(2)
        }))
      }
    });
  } catch (error) {
    console.error('Error getting memory info:', error);
    res.status(500).json({ error: 'Failed to get memory info', message: error.message });
  }
};

/**
 * Take a heap snapshot and save to project root
 * POST /debug/heapsnapshot
 * 
 * Saves as heap-{timestamp}.heapsnapshot in project root
 * Rename to heap1.heapsnapshot, heap2.heapsnapshot etc for comparison
 */
const heapsnapshot = async (req, res) => {
  try {
    const timestamp = Date.now();
    const filename = `heap-${timestamp}.heapsnapshot`;
    const filepath = path.join(projectRoot, filename);
    
    console.log(`[Debug] Taking heap snapshot: ${filename}`);
    
    // Write heap snapshot to project root
    v8.writeHeapSnapshot(filepath);
    
    // List existing heap files
    const existingHeapFiles = fs.readdirSync(projectRoot)
      .filter(f => f.match(/^heap.*\.heapsnapshot$/))
      .sort();
    
    res.json({
      success: true,
      message: 'Heap snapshot saved to project root',
      filename,
      savedPath: filepath,
      existingSnapshots: existingHeapFiles,
      note: 'Rename to heap1.heapsnapshot, heap2.heapsnapshot etc, then use GET /debug/heap-compare'
    });
    
  } catch (error) {
    console.error('Error taking heap snapshot:', error);
    res.status(500).json({ error: 'Failed to take heap snapshot', message: error.message });
  }
};


/**
 * Compare all heap snapshots in project root
 * GET /debug/heap-compare
 * 
 * Finds all heap*.heapsnapshot files, compares oldest to newest
 */
const compareHeapSnapshots = async (req, res) => {
  try {
    // Find all heap snapshot files in project root
    const files = fs.readdirSync(projectRoot)
      .filter(f => f.match(/^heap.*\.heapsnapshot$/))
      .map(f => ({
        name: f,
        path: path.join(projectRoot, f),
        time: fs.statSync(path.join(projectRoot, f)).mtime.getTime()
      }))
      .sort((a, b) => a.time - b.time); // Oldest first
    
    if (files.length < 2) {
      return res.json({
        error: 'Need at least 2 snapshots to compare',
        found: files.map(f => f.name),
        note: 'Take snapshots with: POST /debug/heapsnapshot'
      });
    }
    
    const baseline = files[0];
    const current = files[files.length - 1];
    
    console.log(`[Debug] Comparing heap snapshots: ${baseline.name} → ${current.name}`);
    
    const parsed1 = deepParseHeapSnapshot(baseline.path);
    const parsed2 = deepParseHeapSnapshot(current.path);
    
    if (!parsed1 || !parsed2) {
      return res.status(500).json({ error: 'Failed to parse snapshots' });
    }
    
    const collections1 = analyzeLargeCollections(parsed1);
    const collections2 = analyzeLargeCollections(parsed2);
    
    // Find collections that grew
    const growth = [];
    for (const c2 of collections2) {
      const c1 = collections1.find(c => c.name === c2.name && c.type === c2.type);
      if (c1) {
        const countGrowth = c2.edgeCount - c1.edgeCount;
        const sizeGrowth = c2.selfSize - c1.selfSize;
        if (countGrowth > 10 || sizeGrowth > 100000) { // Only show significant growth
          growth.push({
            type: c2.type,
            name: c2.name,
            countBefore: c1.edgeCount,
            countAfter: c2.edgeCount,
            countGrowth,
            sizeGrowthMB: (sizeGrowth / 1024 / 1024).toFixed(2),
            beforeSamples: c1.samples.slice(0, 10),
            afterSamples: c2.samples.slice(0, 10)
          });
        }
      } else if (c2.edgeCount > 100) {
        // New large collection
        growth.push({
          type: c2.type,
          name: c2.name,
          countBefore: 0,
          countAfter: c2.edgeCount,
          countGrowth: c2.edgeCount,
          sizeGrowthMB: (c2.selfSize / 1024 / 1024).toFixed(2),
          beforeSamples: [],
          afterSamples: c2.samples.slice(0, 10),
          isNew: true
        });
      }
    }
    
    growth.sort((a, b) => parseFloat(b.sizeGrowthMB) - parseFloat(a.sizeGrowthMB));
    
    const timeDiffMin = ((current.time - baseline.time) / 1000 / 60).toFixed(1);
    
    res.json({
      comparison: {
        baseline: baseline.name,
        current: current.name,
        timeElapsedMinutes: timeDiffMin,
        allSnapshots: files.map(f => f.name)
      },
      leaks: growth.slice(0, 30).map(g => ({
        ...g,
        analysis: `${g.type} "${g.name}" grew by ${g.countGrowth} items (+${g.sizeGrowthMB}MB)`
      })),
      summary: `Found ${growth.length} growing collections`
    });
    
  } catch (error) {
    console.error('Error comparing heap snapshots:', error);
    res.status(500).json({ error: 'Failed to compare snapshots', message: error.message, stack: error.stack });
  }
};

/**
 * Get detailed object counts from heap
 * GET /debug/heap-stats
 * 
 * Shows counts of different object types to identify what's accumulating
 */
const heapStats = async (req, res) => {
  try {
    const heapStats = v8.getHeapStatistics();
    const heapSpaceStats = v8.getHeapSpaceStatistics();
    
    // Get current memory usage
    const mem = process.memoryUsage();
    
    // Try to get object counts (requires --expose-gc flag)
    let objectCounts = null;
    if (global.gc) {
      // Force GC if available
      global.gc();
      
      // Take a quick heap snapshot to count objects
      const snapshot = v8.writeHeapSnapshot();
      try {
        const data = fs.readFileSync(snapshot, 'utf8');
        const heap = JSON.parse(data);
        
        // Count node types
        const typeCounts = {};
        if (heap.nodes) {
          for (let i = 0; i < heap.nodes.length; i += heap.node_fields.length) {
            const typeIndex = heap.nodes[i];
            const typeName = heap.strings[typeIndex] || 'unknown';
            typeCounts[typeName] = (typeCounts[typeName] || 0) + 1;
          }
        }
        
        objectCounts = Object.entries(typeCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 50);
        
        fs.unlinkSync(snapshot);
      } catch (err) {
        console.error('Error parsing heap snapshot:', err.message);
      }
    }
    
    res.json({
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: {
        rss: `${(mem.rss / 1024 / 1024).toFixed(2)} MB`,
        heapTotal: `${(mem.heapTotal / 1024 / 1024).toFixed(2)} MB`,
        heapUsed: `${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`,
        external: `${(mem.external / 1024 / 1024).toFixed(2)} MB`
      },
      heap: {
        totalHeapSize: `${(heapStats.total_heap_size / 1024 / 1024).toFixed(2)} MB`,
        usedHeapSize: `${(heapStats.used_heap_size / 1024 / 1024).toFixed(2)} MB`,
        heapSizeLimit: `${(heapStats.heap_size_limit / 1024 / 1024).toFixed(2)} MB`,
        mallocedMemory: `${(heapStats.malloced_memory / 1024 / 1024).toFixed(2)} MB`
      },
      heapSpaces: heapSpaceStats.map(s => ({
        name: s.space_name,
        size: `${(s.space_size / 1024 / 1024).toFixed(2)} MB`,
        used: `${(s.space_used_size / 1024 / 1024).toFixed(2)} MB`,
        available: `${(s.space_available_size / 1024 / 1024).toFixed(2)} MB`
      })),
      topObjectTypes: objectCounts,
      gcAvailable: !!global.gc,
      note: objectCounts ? null : 'Start server with --expose-gc flag to see object counts'
    });
  } catch (error) {
    console.error('Error getting heap stats:', error);
    res.status(500).json({ error: 'Failed to get heap stats', message: error.message });
  }
};

/**
 * Manual cleanup of stale connections
 * POST /debug/cleanup
 */
const cleanup = async (req, res) => {
  try {
    const barsManager = require('../utils/barsStreamManager');
    const quotesManager = require('../utils/quoteStreamManager');
    const ordersManager = require('../utils/ordersStreamManager');
    const positionsManager = require('../utils/positionsStreamManager');
    const { destroyIdleSockets } = require('../utils/httpAgent');
    
    console.log('[Debug] Starting manual stream cleanup...');
    
    const results = {
      bars: barsManager.cleanupStaleConnections ? barsManager.cleanupStaleConnections() : 0,
      quotes: quotesManager.cleanupStaleConnections ? quotesManager.cleanupStaleConnections() : 0,
      orders: ordersManager.cleanupStaleConnections ? ordersManager.cleanupStaleConnections() : 0,
      positions: positionsManager.cleanupStaleConnections ? positionsManager.cleanupStaleConnections() : 0
    };
    
    const socketsDestroyed = destroyIdleSockets();
    results.idleSocketsDestroyed = socketsDestroyed;
    
    const total = results.bars + results.quotes + results.orders + results.positions;
    
    console.log(`[Debug] Cleanup complete: ${total} stale connections, ${socketsDestroyed} idle sockets`);
    
    res.json({
      message: `Cleaned up ${total} stale connection(s) and ${socketsDestroyed} idle socket(s)`,
      details: results
    });
  } catch (error) {
    console.error('Error cleaning up stale connections:', error);
    res.status(500).json({ error: 'Failed to cleanup stale connections', message: error.message });
  }
};

module.exports = {
  health,
  status,
  debug,
  memory,
  heapsnapshot,
  compareHeapSnapshots,
  heapStats,
  cleanup
};

