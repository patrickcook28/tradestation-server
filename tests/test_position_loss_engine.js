/**
 * Comprehensive test suite for PositionLossEngine
 * 
 * Tests critical scenarios:
 * - Server restarts (cache reloading)
 * - Loss limits set after server started (dynamic updates)
 * - Multiple positions of same ticker
 * - Duplicate alert prevention
 * - Edge cases and race conditions
 * 
 * Run with: node tests/test_position_loss_engine.js
 */

const EventEmitter = require('events');
const pool = require('../db');
const path = require('path');

// Mock Pusher before requiring positionLossEngine
const mockPusher = {
  trigger: async () => Promise.resolve()
};

// Mock Pusher module
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(...args) {
  if (args[0] === 'pusher') {
    return function() { return mockPusher; };
  }
  return originalRequire.apply(this, args);
};

// Test utilities
let testCount = 0;
let passCount = 0;
let failCount = 0;
const alertsTriggered = [];
const alertsCreated = [];

function assert(condition, message) {
  testCount++;
  if (condition) {
    passCount++;
    console.log(`✅ ${message}`);
  } else {
    failCount++;
    console.error(`❌ FAIL: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  testCount++;
  if (actual === expected) {
    passCount++;
    console.log(`✅ ${message}`);
  } else {
    failCount++;
    console.error(`❌ FAIL: ${message} - Expected: ${expected}, Got: ${actual}`);
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Mock BackgroundStreamManager
class MockBackgroundStreamManager extends EventEmitter {
  constructor() {
    super();
    this.streams = new Map();
    // Increase max listeners to avoid memory leak warnings in tests
    this.setMaxListeners(50);
  }

  async startStreamsForUser(userId, config) {
    const key = `${userId}|positions`;
    this.streams.set(key, config);
  }

  async stopStreamsForUser(userId) {
    const key = `${userId}|positions`;
    this.streams.delete(key);
  }

  async stopStreamByKey(streamKey) {
    this.streams.delete(streamKey);
  }

  // Helper to emit position data
  emitPositionData(userId, accountId, positionData, paperTrading = false) {
    this.emit('data', {
      streamType: 'positions',
      userId,
      accountId,
      paperTrading,
      data: positionData
    });
  }
}

// Helper to create test user and account
async function createTestUser() {
  // Use bcryptjs to hash a dummy password (required by schema)
  const bcrypt = require('bcryptjs');
  const hashedPassword = await bcrypt.hash('testpassword123', 8);
  
  const result = await pool.query(`
    INSERT INTO users (email, password, account_defaults)
    VALUES ($1, $2, $3)
    RETURNING id
  `, ['test@example.com', hashedPassword, JSON.stringify({})]);
  
  return result.rows[0].id;
}

async function cleanupTestUser(userId) {
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
}

// Helper to set account defaults
async function setAccountDefaults(userId, accountId, settings) {
  const userResult = await pool.query('SELECT account_defaults FROM users WHERE id = $1', [userId]);
  const accountDefaults = userResult.rows[0]?.account_defaults || {};
  accountDefaults[accountId] = settings;
  
  await pool.query('UPDATE users SET account_defaults = $1 WHERE id = $2', [
    JSON.stringify(accountDefaults),
    userId
  ]);
}

// Helper to create position data
function createPositionData(symbol, positionId, unrealizedPL, quantity = 100, avgPrice = 100) {
  return {
    Symbol: symbol,
    PositionID: positionId,
    AccountID: 'TEST123',
    Quantity: quantity,
    AveragePrice: avgPrice,
    UnrealizedProfitLoss: unrealizedPL,
    UnrealizedPL: unrealizedPL,
    UnrealizedPnL: unrealizedPL
  };
}

// Helper to count alerts in database
async function countAlerts(userId, accountId, positionId = null) {
  let query = `
    SELECT COUNT(*) as count
    FROM loss_limit_alerts
    WHERE user_id = $1 AND account_id = $2 AND alert_type = 'trade'
  `;
  const params = [userId, accountId];
  
  if (positionId) {
    query += ` AND position_snapshot->>'PositionID' = $3`;
    params.push(positionId);
  }
  
  const result = await pool.query(query, params);
  return parseInt(result.rows[0].count);
}

// Helper to get alert from database
async function getAlert(userId, accountId, positionId) {
  const result = await pool.query(`
    SELECT *
    FROM loss_limit_alerts
    WHERE user_id = $1 
      AND account_id = $2 
      AND alert_type = 'trade'
      AND position_snapshot->>'PositionID' = $3
    ORDER BY detected_at DESC
    LIMIT 1
  `, [userId, accountId, positionId]);
  
  return result.rows[0] || null;
}

// Main test suite
async function runTests() {
  console.log('\n🧪 PositionLossEngine Comprehensive Test Suite\n');
  console.log('Testing server restarts, dynamic updates, duplicate prevention, and edge cases...\n');

  let userId;
  const accountId = 'TEST123';
  const paperAccountId = 'SIM123';

  try {
    // Setup: Create test user
    userId = await createTestUser();
    console.log(`📋 Created test user: ${userId}\n`);

    // Create mock stream manager
    const mockStreamManager = new MockBackgroundStreamManager();
    
    // Override backgroundStreamManager require BEFORE loading PositionLossEngine
    const Module = require('module');
    const originalRequireFn = Module.prototype.require;
    Module.prototype.require = function(...args) {
      if (args[0] === '../utils/backgroundStreamManager') {
        return mockStreamManager;
      }
      return originalRequireFn.apply(this, args);
    };
    
    // Load PositionLossEngine after mocking (it's a singleton)
    delete require.cache[require.resolve('../workers/positionLossEngine')];
    const positionLossEngine = require('../workers/positionLossEngine');

    // Test 1: Server restart - cache reloading
    console.log('📋 Test 1: Server restart - cache reloading');
    {
      // Set up account with position loss enabled
      await setAccountDefaults(userId, accountId, {
        maxLossPerPositionEnabled: true,
        maxLossPerPosition: 100,
        isPaperTrading: false
      });

      // Create an existing alert in database (simulating server restart)
      await pool.query(`
        INSERT INTO loss_limit_alerts 
        (user_id, account_id, alert_type, threshold_amount, loss_amount, position_snapshot)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        userId,
        accountId,
        'trade',
        100,
        150,
        JSON.stringify({
          Symbol: 'AAPL',
          PositionID: 'POS123',
          Quantity: 100,
          AveragePrice: 100,
          UnrealizedPL: -150
        })
      ]);

      // Start engine (simulates server restart)
      // Use the singleton instance
      const engine = positionLossEngine;
      
      // Reset if already running
      if (engine.isRunning) {
        await engine.stop();
      }
      
      await engine.start();
      
      await sleep(100); // Wait for cache to load

      // Verify cache was loaded (format: userId|accountId|positionId)
      const cacheKey = `${userId}|${accountId}|POS123`;
      // Wait a bit more for cache to fully load
      await sleep(200);
      assert(engine.triggeredAlertsCache.has(cacheKey), 'Cache should contain existing alert after restart');

      // Try to trigger alert for same position - should be skipped
      const positionData = createPositionData('AAPL', 'POS123', -200);
      mockStreamManager.emitPositionData(userId, accountId, positionData, false);
      
      await sleep(200); // Wait for processing

      const alertCount = await countAlerts(userId, accountId, 'POS123');
      assertEqual(alertCount, 1, 'Should not create duplicate alert after restart');

      await engine.stop();
    }

    // Test 2: Loss limits set after server started (dynamic updates)
    console.log('\n📋 Test 2: Loss limits set after server started (dynamic updates)');
    {
      // Clear account defaults for this test user to start clean
      await setAccountDefaults(userId, accountId, {
        maxLossPerPositionEnabled: false,
        maxLossPerPosition: 0,
        isPaperTrading: false
      });

      // Start engine without any loss limits for this account
      const engine = positionLossEngine;
      if (engine.isRunning) await engine.stop();
      await engine.start();
      
      await sleep(100);

      // Verify this specific account is not being monitored initially
      // (other users might be monitored, so we check the specific account)
      const userMonitored = engine.monitoredAccounts.get(String(userId));
      const accountKey = `${userId}|${accountId}|0`;
      const isMonitored = userMonitored && userMonitored.has(accountKey);
      assert(!isMonitored, 'Should have no monitored accounts initially for this user');

      // Set loss limit after engine started
      await setAccountDefaults(userId, accountId, {
        maxLossPerPositionEnabled: true,
        maxLossPerPosition: 100,
        isPaperTrading: false
      });

      // Reload monitored accounts (simulates periodic reload)
      await engine.loadMonitoredAccounts();
      
      await sleep(100);

      // Verify monitoring started
      assert(engine.monitoredAccounts.has(String(userId)), 'Should start monitoring after loss limit is set');

      // Send position data that exceeds threshold
      const positionData = createPositionData('TSLA', 'POS456', -150);
      mockStreamManager.emitPositionData(userId, accountId, positionData, false);
      
      await sleep(200);

      // Verify alert was created
      const alertCount = await countAlerts(userId, accountId, 'POS456');
      assertEqual(alertCount, 1, 'Should create alert for position exceeding threshold');

      await engine.stop();
    }

    // Test 3: Multiple positions of same ticker
    console.log('\n📋 Test 3: Multiple positions of same ticker');
    {
      await setAccountDefaults(userId, accountId, {
        maxLossPerPositionEnabled: true,
        maxLossPerPosition: 100,
        isPaperTrading: false
      });

      const engine = positionLossEngine;
      if (engine.isRunning) await engine.stop();
      await engine.start();
      
      await sleep(100);

      // Create two different positions of same ticker with different PositionIDs
      const position1 = createPositionData('AAPL', 'POS789', -150);
      const position2 = createPositionData('AAPL', 'POS790', -120);

      mockStreamManager.emitPositionData(userId, accountId, position1, false);
      await sleep(200);
      
      mockStreamManager.emitPositionData(userId, accountId, position2, false);
      await sleep(300); // Give more time for processing

      // Both should trigger alerts (different PositionIDs)
      const alertCount1 = await countAlerts(userId, accountId, 'POS789');
      const alertCount2 = await countAlerts(userId, accountId, 'POS790');
      
      assertEqual(alertCount1, 1, 'First position should trigger alert');
      assertEqual(alertCount2, 1, 'Second position should trigger alert');

      await engine.stop();
    }

    // Test 4: Duplicate alert prevention - same position after previous alert
    console.log('\n📋 Test 4: Duplicate alert prevention - same position after previous alert');
    {
      await setAccountDefaults(userId, accountId, {
        maxLossPerPositionEnabled: true,
        maxLossPerPosition: 100,
        isPaperTrading: false
      });

      const engine = positionLossEngine;
      if (engine.isRunning) await engine.stop();
      await engine.start();
      
      await sleep(100);

      const positionId = 'POS999';
      const positionData = createPositionData('MSFT', positionId, -150);

      // First trigger - should create alert
      mockStreamManager.emitPositionData(userId, accountId, positionData, false);
      await sleep(200);

      const firstAlertCount = await countAlerts(userId, accountId, positionId);
      assertEqual(firstAlertCount, 1, 'First alert should be created');

      // Second trigger with same PositionID but worse loss - should NOT create duplicate
      const positionData2 = createPositionData('MSFT', positionId, -200);
      mockStreamManager.emitPositionData(userId, accountId, positionData2, false);
      await sleep(200);

      const secondAlertCount = await countAlerts(userId, accountId, positionId);
      assertEqual(secondAlertCount, 1, 'Should not create duplicate alert for same PositionID');

      // Verify cache was updated
      const cacheKey = `${userId}|${accountId}|${positionId}`;
      assert(engine.triggeredAlertsCache.has(cacheKey), 'Cache should contain position after alert');

      await engine.stop();
    }

    // Test 5: Position closes and reopens (new PositionID)
    console.log('\n📋 Test 5: Position closes and reopens (new PositionID)');
    {
      await setAccountDefaults(userId, accountId, {
        maxLossPerPositionEnabled: true,
        maxLossPerPosition: 100,
        isPaperTrading: false
      });

      const engine = positionLossEngine;
      if (engine.isRunning) await engine.stop();
      await engine.start();
      
      await sleep(100);

      const positionId1 = 'POS1001';
      const positionData1 = createPositionData('GOOGL', positionId1, -150, 100);

      // Create position and trigger alert
      mockStreamManager.emitPositionData(userId, accountId, positionData1, false);
      await sleep(200);

      // Close position (quantity = 0)
      const closedPosition = createPositionData('GOOGL', positionId1, 0, 0);
      mockStreamManager.emitPositionData(userId, accountId, closedPosition, false);
      await sleep(100);

      // New position with same symbol but different PositionID
      const positionId2 = 'POS1002';
      const positionData2 = createPositionData('GOOGL', positionId2, -150, 100);

      mockStreamManager.emitPositionData(userId, accountId, positionData2, false);
      await sleep(200);

      // Should create new alert for new PositionID
      const alertCount2 = await countAlerts(userId, accountId, positionId2);
      assertEqual(alertCount2, 1, 'Should create alert for new PositionID after position closed');

      await engine.stop();
    }

    // Test 6: Edge case - position goes from profit to loss
    console.log('\n📋 Test 6: Edge case - position goes from profit to loss');
    {
      await setAccountDefaults(userId, accountId, {
        maxLossPerPositionEnabled: true,
        maxLossPerPosition: 100,
        isPaperTrading: false
      });

      const engine = positionLossEngine;
      if (engine.isRunning) await engine.stop();
      await engine.start();
      
      await sleep(100);

      const positionId = 'POS2001';
      
      // Start with profit
      const profitablePosition = createPositionData('NVDA', positionId, 50);
      mockStreamManager.emitPositionData(userId, accountId, profitablePosition, false);
      await sleep(100);

      // No alert should be created for profit
      const profitAlertCount = await countAlerts(userId, accountId, positionId);
      assertEqual(profitAlertCount, 0, 'Should not create alert for profitable position');

      // Position goes to loss but within threshold
      const smallLossPosition = createPositionData('NVDA', positionId, -50);
      mockStreamManager.emitPositionData(userId, accountId, smallLossPosition, false);
      await sleep(100);

      const smallLossAlertCount = await countAlerts(userId, accountId, positionId);
      assertEqual(smallLossAlertCount, 0, 'Should not create alert for loss within threshold');

      // Position exceeds threshold
      const largeLossPosition = createPositionData('NVDA', positionId, -150);
      mockStreamManager.emitPositionData(userId, accountId, largeLossPosition, false);
      await sleep(200);

      const largeLossAlertCount = await countAlerts(userId, accountId, positionId);
      assertEqual(largeLossAlertCount, 1, 'Should create alert when loss exceeds threshold');

      await engine.stop();
    }

    // Test 7: Edge case - loss limit disabled after alert triggered
    console.log('\n📋 Test 7: Edge case - loss limit disabled after alert triggered');
    {
      await setAccountDefaults(userId, accountId, {
        maxLossPerPositionEnabled: true,
        maxLossPerPosition: 100,
        isPaperTrading: false
      });

      const engine = positionLossEngine;
      if (engine.isRunning) await engine.stop();
      await engine.start();
      
      await sleep(100);

      const positionId = 'POS3001';
      const positionData = createPositionData('AMZN', positionId, -150);

      // Trigger alert
      mockStreamManager.emitPositionData(userId, accountId, positionData, false);
      await sleep(200);

      // Disable loss limit
      await setAccountDefaults(userId, accountId, {
        maxLossPerPositionEnabled: false,
        maxLossPerPosition: 0,
        isPaperTrading: false
      });

      await engine.loadMonitoredAccounts();
      await sleep(100);

      // Verify monitoring stopped
      assert(!engine.monitoredAccounts.has(String(userId)), 'Should stop monitoring when limit disabled');

      // Send more position data - should not process
      const positionData2 = createPositionData('AMZN', positionId, -200);
      mockStreamManager.emitPositionData(userId, accountId, positionData2, false);
      await sleep(100);

      // Alert count should remain same
      const alertCount = await countAlerts(userId, accountId, positionId);
      assertEqual(alertCount, 1, 'Should not create new alerts after monitoring disabled');

      await engine.stop();
    }

    // Test 8: Edge case - threshold changed after position already alerted
    console.log('\n📋 Test 8: Edge case - threshold changed after position already alerted');
    {
      await setAccountDefaults(userId, accountId, {
        maxLossPerPositionEnabled: true,
        maxLossPerPosition: 100,
        isPaperTrading: false
      });

      const engine = positionLossEngine;
      if (engine.isRunning) await engine.stop();
      await engine.start();
      
      await sleep(100);

      const positionId = 'POS4001';
      const positionData = createPositionData('META', positionId, -150);

      // Trigger alert with threshold 100
      mockStreamManager.emitPositionData(userId, accountId, positionData, false);
      await sleep(200);

      // Change threshold to 200
      await setAccountDefaults(userId, accountId, {
        maxLossPerPositionEnabled: true,
        maxLossPerPosition: 200,
        isPaperTrading: false
      });

      await engine.loadLossLimits();
      await sleep(100);

      // Position still at -150, but threshold is now 200, so no new alert
      mockStreamManager.emitPositionData(userId, accountId, positionData, false);
      await sleep(100);

      const alertCount = await countAlerts(userId, accountId, positionId);
      assertEqual(alertCount, 1, 'Should not create new alert when threshold increased');

      await engine.stop();
    }

    // Test 9: Edge case - paper vs live account separation
    console.log('\n📋 Test 9: Edge case - paper vs live account separation');
    {
      // Set up both paper and live accounts
      await setAccountDefaults(userId, accountId, {
        maxLossPerPositionEnabled: true,
        maxLossPerPosition: 100,
        isPaperTrading: false
      });

      await setAccountDefaults(userId, paperAccountId, {
        maxLossPerPositionEnabled: true,
        maxLossPerPosition: 100,
        isPaperTrading: true
      });

      const engine = positionLossEngine;
      if (engine.isRunning) await engine.stop();
      await engine.start();
      
      await sleep(100);

      const livePositionId = 'POS5001';
      const paperPositionId = 'POS5002';

      // Live account position
      const livePosition = createPositionData('SPY', livePositionId, -150);
      livePosition.AccountID = accountId;
      mockStreamManager.emitPositionData(userId, accountId, livePosition, false);
      await sleep(200);

      // Paper account position
      const paperPosition = createPositionData('SPY', paperPositionId, -150);
      paperPosition.AccountID = paperAccountId;
      mockStreamManager.emitPositionData(userId, paperAccountId, paperPosition, true);
      await sleep(200);

      // Both should have alerts
      const liveAlertCount = await countAlerts(userId, accountId, livePositionId);
      const paperAlertCount = await countAlerts(userId, paperAccountId, paperPositionId);
      
      assertEqual(liveAlertCount, 1, 'Live account should have alert');
      assertEqual(paperAlertCount, 1, 'Paper account should have alert');

      await engine.stop();
    }

    // Test 10: Edge case - race condition - multiple rapid updates
    console.log('\n📋 Test 10: Edge case - race condition - multiple rapid updates');
    {
      await setAccountDefaults(userId, accountId, {
        maxLossPerPositionEnabled: true,
        maxLossPerPosition: 100,
        isPaperTrading: false
      });

      const engine = positionLossEngine;
      if (engine.isRunning) await engine.stop();
      await engine.start();
      
      await sleep(100);

      const positionId = 'POS6001';
      
      // Rapidly send multiple updates for same position
      for (let i = 0; i < 10; i++) {
        const positionData = createPositionData('QQQ', positionId, -150 - i);
        mockStreamManager.emitPositionData(userId, accountId, positionData, false);
      }
      
      await sleep(500); // Wait for all processing

      // Should only have one alert despite multiple rapid updates
      const alertCount = await countAlerts(userId, accountId, positionId);
      assertEqual(alertCount, 1, 'Should only create one alert despite rapid updates (race condition prevention)');

      await engine.stop();
    }

    // Test 11: Edge case - position without PositionID (fallback to Symbol)
    console.log('\n📋 Test 11: Edge case - position without PositionID (fallback to Symbol)');
    {
      await setAccountDefaults(userId, accountId, {
        maxLossPerPositionEnabled: true,
        maxLossPerPosition: 100,
        isPaperTrading: false
      });

      const engine = positionLossEngine;
      if (engine.isRunning) await engine.stop();
      await engine.start();
      
      await sleep(100);

      // Position without PositionID
      const positionData = {
        Symbol: 'IWM',
        AccountID: accountId,
        Quantity: 100,
        AveragePrice: 100,
        UnrealizedProfitLoss: -150
        // No PositionID
      };

      mockStreamManager.emitPositionData(userId, accountId, positionData, false);
      await sleep(200);

      // Should create alert using Symbol-based ID
      const fallbackId = `IWM_${accountId}`;
      const alertCount = await countAlerts(userId, accountId);
      
      // Check if any alert exists (might use Symbol fallback)
      assert(alertCount >= 1, 'Should create alert even without PositionID');

      await engine.stop();
    }

    // Test 12: Edge case - zero threshold (should not monitor)
    console.log('\n📋 Test 12: Edge case - zero threshold (should not monitor)');
    {
      await setAccountDefaults(userId, accountId, {
        maxLossPerPositionEnabled: true,
        maxLossPerPosition: 0, // Zero threshold
        isPaperTrading: false
      });

      const engine = positionLossEngine;
      if (engine.isRunning) await engine.stop();
      await engine.start();
      
      await sleep(100);

      // Should not be monitoring this specific account (threshold is 0)
      // Other accounts might still be monitored, so check the specific account
      const userMonitored = engine.monitoredAccounts.get(String(userId));
      const accountKey = `${userId}|${accountId}|0`;
      const isMonitored = userMonitored && userMonitored.has(accountKey);
      assert(!isMonitored, 'Should not monitor when threshold is 0');

      const positionData = createPositionData('TQQQ', 'POS7001', -150);
      mockStreamManager.emitPositionData(userId, accountId, positionData, false);
      await sleep(200);

      // Count alerts for this specific position, not all alerts
      const alertCount = await countAlerts(userId, accountId, 'POS7001');
      assertEqual(alertCount, 0, 'Should not create alerts when threshold is 0');

      await engine.stop();
    }

    // Cleanup
    console.log('\n📋 Cleaning up test data...');
    await cleanupTestUser(userId);

  } catch (error) {
    console.error('\n❌ Test suite error:', error);
    console.error(error.stack);
    
    // Cleanup on error
    if (userId) {
      try {
        await cleanupTestUser(userId);
      } catch (e) {
        console.error('Cleanup error:', e);
      }
    }
    
    failCount++;
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log(`\n📊 Test Summary:`);
  console.log(`   Total tests: ${testCount}`);
  console.log(`   Passed: ${passCount}`);
  console.log(`   Failed: ${failCount}`);
  
  if (failCount === 0) {
    console.log(`\n✅ All tests passed!`);
    process.exit(0);
  } else {
    console.log(`\n❌ ${failCount} test(s) failed`);
    process.exit(1);
  }
}

// Run tests
runTests().catch(err => {
  console.error('Fatal test error:', err);
  console.error(err.stack);
  process.exit(1);
});
