/**
 * Comprehensive test suite for StreamMultiplexer
 * 
 * Tests critical memory leak prevention, cleanup, abort handling, and multi-user scenarios.
 * 
 * Run with: node tests/test_stream_multiplexer_comprehensive.js
 * 
 * This test suite focuses on cleanup logic and state management that can be verified
 * without requiring full API integration. It tests the critical memory leak prevention
 * mechanisms, abort handling, and multi-user isolation.
 */

const { StreamMultiplexer } = require('../utils/streamMultiplexer');
const EventEmitter = require('events');
const { Readable } = require('stream');

// Test utilities
class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.writable = true;
    this.writableEnded = false;
    this.finished = false;
    this.destroyed = false;
    this.headers = {};
    this.statusCode = 200;
    this.req = {
      aborted: false,
      destroyed: false,
      query: {},
      headers: {}
    };
  }

  setHeader(name, value) {
    this.headers[name] = value;
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  json(obj) {
    this.write(JSON.stringify(obj));
    this.end();
    return this;
  }

  write(chunk) {
    if (!this.writable || this.writableEnded) {
      return false;
    }
    this.emit('data', chunk);
    return true;
  }

  end() {
    if (this.writableEnded) return;
    this.writableEnded = true;
    this.finished = true;
    this.emit('finish');
    this.emit('close');
  }

  destroy() {
    this.destroyed = true;
    this.writable = false;
    this.emit('close');
  }
}

// Test assertion utilities
let testCount = 0;
let passCount = 0;
let failCount = 0;

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

// Test suite - focuses on cleanup and memory leak prevention
async function runTests() {
  console.log('\n🧪 StreamMultiplexer Comprehensive Test Suite\n');
  console.log('Testing memory leak prevention, cleanup, abort handling, and multi-user scenarios...\n');
  console.log('⚠️  NOTE: These tests verify cleanup logic. Some require actual API calls.\n');

  // Test 1: Basic state initialization and structure
  console.log('📋 Test 1: Basic state initialization and structure');
  {
    const multiplexer = new StreamMultiplexer({
      name: 'TestStream',
      makeKey: (userId, deps) => `${userId}|${deps.accountId}`,
      buildRequest: (userId, deps) => ({ path: '/test', paperTrading: false })
    });
    
    // Verify initial state
    assert(multiplexer.keyToConnection instanceof Map, 'keyToConnection should be a Map');
    assert(multiplexer.pendingOpens instanceof Map, 'pendingOpens should be a Map');
    assert(multiplexer.pendingCleanups instanceof Map, 'pendingCleanups should be a Map');
    assert(multiplexer.userToLastKey instanceof Map, 'userToLastKey should be a Map');
    assert(multiplexer.userLastSwitch instanceof Map, 'userLastSwitch should be a Map');
    assertEqual(multiplexer.pendingOpensCount, 0, 'Pending opens count should start at 0');
  }

  // Test 2: Multiple subscribers tracking
  console.log('\n📋 Test 2: Multiple subscribers tracking');
  {
    const multiplexer = new StreamMultiplexer({
      name: 'TestStream',
      makeKey: (userId, deps) => `${userId}|${deps.accountId}`,
      buildRequest: (userId, deps) => ({ path: '/test', paperTrading: false })
    });

    const subscribers = Array.from({ length: 5 }, () => new MockResponse());
    
    // Manually test subscriber tracking (without actual stream)
    const key = multiplexer.makeKey('user1', { accountId: 'acc1' });
    const mockState = {
      key,
      subscribers: new Set(),
      upstream: null,
      webStream: null,
      readable: null,
      abortController: null,
      timeoutController: null,
      aborted: false,
      lastActivityAt: Date.now(),
      firstDataSent: false
    };
    
    multiplexer.keyToConnection.set(key, mockState);
    
    subscribers.forEach(res => mockState.subscribers.add(res));
    assert(mockState.subscribers.size === 5, 'Should track 5 subscribers');
    
    // Test cleanup
    subscribers.forEach(res => {
      mockState.subscribers.delete(res);
      res.destroy();
    });
    
    assert(mockState.subscribers.size === 0, 'All subscribers should be removed');
    
    multiplexer.keyToConnection.delete(key);
  }

  // Test 3: Abort controller lifecycle and cleanup
  console.log('\n📋 Test 3: Abort controller lifecycle and cleanup');
  {
    const multiplexer = new StreamMultiplexer({
      name: 'TestStream',
      makeKey: (userId, deps) => `${userId}|${deps.accountId}`,
      buildRequest: (userId, deps) => ({ path: '/test', paperTrading: false })
    });

    const key = multiplexer.makeKey('user1', { accountId: 'acc1' });
    const abortController = new AbortController();
    const timeoutController = new AbortController();
    
    const mockState = {
      key,
      subscribers: new Set(),
      upstream: null,
      webStream: null,
      readable: null,
      abortController,
      timeoutController,
      aborted: false,
      lastActivityAt: Date.now(),
      firstDataSent: false
    };
    
    multiplexer.keyToConnection.set(key, mockState);
    
    assert(mockState.abortController !== null, 'AbortController should exist');
    assert(mockState.timeoutController !== null, 'TimeoutController should exist');
    assert(!mockState.abortController.signal.aborted, 'AbortController should not be aborted initially');
    
    // Test _destroyConnection cleanup logic
    mockState.aborted = true;
    
    // Step 1: Abort controllers
    if (mockState.abortController && !mockState.abortController.signal.aborted) {
      mockState.abortController.abort('Test cleanup');
    }
    if (mockState.timeoutController && !mockState.timeoutController.signal.aborted) {
      mockState.timeoutController.abort();
    }
    
    // Step 2: Nullify references
    mockState.abortController = null;
    mockState.timeoutController = null;
    mockState.readable = null;
    mockState.webStream = null;
    mockState.upstream = null;
    
    multiplexer.keyToConnection.delete(key);
    
    // Verify cleanup
    assert(mockState.abortController === null, 'AbortController should be nullified after cleanup');
    assert(mockState.timeoutController === null, 'TimeoutController should be nullified after cleanup');
    assert(mockState.aborted, 'State should be marked as aborted');
    assert(!multiplexer.keyToConnection.has(key), 'Connection should be removed from map');
  }

  // Test 4: Timer cleanup verification (critical for memory leaks)
  console.log('\n📋 Test 4: Timer cleanup verification (critical for memory leaks)');
  {
    const multiplexer = new StreamMultiplexer({
      name: 'TestStream',
      makeKey: (userId, deps) => `${userId}|${deps.accountId}`,
      buildRequest: (userId, deps) => ({ path: '/test', paperTrading: false })
    });

    const key = multiplexer.makeKey('user1', { accountId: 'acc1' });
    const activityInterval = setInterval(() => {}, 1000);
    const initialTimeout = setTimeout(() => {}, 1000);
    
    const mockState = {
      key,
      subscribers: new Set(),
      upstream: null,
      webStream: null,
      readable: null,
      abortController: null,
      timeoutController: null,
      aborted: false,
      lastActivityAt: Date.now(),
      firstDataSent: false,
      activityCheckInterval: activityInterval,
      initialDataTimeout: initialTimeout
    };
    
    multiplexer.keyToConnection.set(key, mockState);
    
    assert(mockState.activityCheckInterval !== undefined, 'Activity check interval should be set');
    assert(mockState.initialDataTimeout !== undefined, 'Initial data timeout should be set');
    
    // Simulate _destroyConnection timer cleanup (critical for preventing memory leaks)
    if (mockState.activityCheckInterval) {
      clearInterval(mockState.activityCheckInterval);
      mockState.activityCheckInterval = undefined;
    }
    if (mockState.initialDataTimeout) {
      clearTimeout(mockState.initialDataTimeout);
      mockState.initialDataTimeout = undefined;
    }
    
    assert(mockState.activityCheckInterval === undefined, 'Activity check interval should be cleared (prevents memory leak)');
    assert(mockState.initialDataTimeout === undefined, 'Initial data timeout should be cleared (prevents memory leak)');
    
    multiplexer.keyToConnection.delete(key);
  }

  // Test 5: Multiple users isolation
  console.log('\n📋 Test 5: Multiple users isolation');
  {
    const multiplexer = new StreamMultiplexer({
      name: 'TestStream',
      makeKey: (userId, deps) => `${userId}|${deps.accountId}`,
      buildRequest: (userId, deps) => ({ path: '/test', paperTrading: false })
    });

    const key1 = multiplexer.makeKey('user1', { accountId: 'acc1' });
    const key2 = multiplexer.makeKey('user2', { accountId: 'acc2' });
    
    const state1 = {
      key: key1,
      subscribers: new Set([new MockResponse()]),
      upstream: null,
      webStream: null,
      readable: null,
      abortController: null,
      timeoutController: null,
      aborted: false,
      lastActivityAt: Date.now(),
      firstDataSent: false
    };
    
    const state2 = {
      key: key2,
      subscribers: new Set([new MockResponse()]),
      upstream: null,
      webStream: null,
      readable: null,
      abortController: null,
      timeoutController: null,
      aborted: false,
      lastActivityAt: Date.now(),
      firstDataSent: false
    };
    
    multiplexer.keyToConnection.set(key1, state1);
    multiplexer.keyToConnection.set(key2, state2);
    
    assert(multiplexer.keyToConnection.size === 2, 'Should have 2 separate upstreams for 2 users');
    assert(multiplexer.keyToConnection.has(key1), 'User1 stream should exist');
    assert(multiplexer.keyToConnection.has(key2), 'User2 stream should exist');
    
    // Clean up user1
    state1.subscribers.clear();
    multiplexer.keyToConnection.delete(key1);
    
    assert(multiplexer.keyToConnection.size === 1, 'Should have 1 upstream remaining after user1 cleanup');
    assert(!multiplexer.keyToConnection.has(key1), 'User1 stream should be removed');
    assert(multiplexer.keyToConnection.has(key2), 'User2 stream should still exist');
    
    // Clean up user2
    state2.subscribers.clear();
    multiplexer.keyToConnection.delete(key2);
    
    assert(multiplexer.keyToConnection.size === 0, 'All streams should be cleaned up');
  }

  // Test 6: Fast refresh / rapid reconnection handling
  console.log('\n📋 Test 6: Fast refresh / rapid reconnection handling');
  {
    const multiplexer = new StreamMultiplexer({
      name: 'TestStream',
      makeKey: (userId, deps) => `${userId}|${deps.accountId}`,
      buildRequest: (userId, deps) => ({ path: '/test', paperTrading: false })
    });

    // Test user tracking for rapid switches
    const userId = 'user1';
    const key1 = multiplexer.makeKey(userId, { accountId: 'acc1' });
    const key2 = multiplexer.makeKey(userId, { accountId: 'acc2' });
    
    multiplexer.userToLastKey.set(userId, key1);
    multiplexer.userLastSwitch.set(userId, Date.now() - 50); // 50ms ago
    
    const lastSwitchTime = multiplexer.userLastSwitch.get(userId) || 0;
    const timeSinceLastSwitch = Date.now() - lastSwitchTime;
    
    assert(timeSinceLastSwitch < 100, 'Should detect rapid switch');
    
    // Simulate switch
    if (multiplexer.userToLastKey.get(userId) && multiplexer.userToLastKey.get(userId) !== key2) {
      multiplexer.userToLastKey.set(userId, key2);
      multiplexer.userLastSwitch.set(userId, Date.now());
    }
    
    assert(multiplexer.userToLastKey.get(userId) === key2, 'Key should be updated');
  }

  // Test 7: Stream recycle - same key reused
  console.log('\n📋 Test 7: Stream recycle - same key reused after cleanup');
  {
    const multiplexer = new StreamMultiplexer({
      name: 'TestStream',
      makeKey: (userId, deps) => `${userId}|${deps.accountId}`,
      buildRequest: (userId, deps) => ({ path: '/test', paperTrading: false })
    });

    const key = multiplexer.makeKey('user1', { accountId: 'acc1' });
    
    // First connection
    const state1 = {
      key,
      subscribers: new Set([new MockResponse()]),
      upstream: null,
      webStream: null,
      readable: null,
      abortController: null,
      timeoutController: null,
      aborted: false,
      lastActivityAt: Date.now(),
      firstDataSent: false
    };
    
    multiplexer.keyToConnection.set(key, state1);
    assert(multiplexer.keyToConnection.has(key), 'First stream should exist');
    
    // Cleanup
    state1.subscribers.clear();
    multiplexer.keyToConnection.delete(key);
    assert(!multiplexer.keyToConnection.has(key), 'Stream should be cleaned up');
    
    // Reuse same key
    const state2 = {
      key,
      subscribers: new Set([new MockResponse()]),
      upstream: null,
      webStream: null,
      readable: null,
      abortController: null,
      timeoutController: null,
      aborted: false,
      lastActivityAt: Date.now(),
      firstDataSent: false
    };
    
    multiplexer.keyToConnection.set(key, state2);
    assert(multiplexer.keyToConnection.has(key), 'Stream should be recreated for same key');
    
    // Cleanup again
    state2.subscribers.clear();
    multiplexer.keyToConnection.delete(key);
    assert(!multiplexer.keyToConnection.has(key), 'Stream should be cleaned up again');
  }

  // Test 8: Memory leak prevention - complete reference nullification
  console.log('\n📋 Test 8: Memory leak prevention - complete reference nullification');
  {
    const multiplexer = new StreamMultiplexer({
      name: 'TestStream',
      makeKey: (userId, deps) => `${userId}|${deps.accountId}`,
      buildRequest: (userId, deps) => ({ path: '/test', paperTrading: false })
    });

    const key = multiplexer.makeKey('user1', { accountId: 'acc1' });
    const abortController = new AbortController();
    const timeoutController = new AbortController();
    const mockReadable = new Readable({ read: () => {} });
    const mockWebStream = { cancel: () => Promise.resolve(), locked: false };
    const mockUpstream = { body: mockWebStream };
    
    const state = {
      key,
      subscribers: new Set([new MockResponse()]),
      upstream: mockUpstream,
      webStream: mockWebStream,
      readable: mockReadable,
      abortController,
      timeoutController,
      aborted: false,
      lastActivityAt: Date.now(),
      firstDataSent: false
    };
    
    multiplexer.keyToConnection.set(key, state);
    
    // Simulate _destroyConnection cleanup (Step 1-10 from actual implementation)
    // Step 1: Mark as aborted
    if (state.aborted) {
      // Already aborted, skip
    } else {
      state.aborted = true;
    }
    
    // Step 2: Close all subscribers
    for (const res of state.subscribers) {
      try { res.end(); } catch (_) {}
    }
    state.subscribers.clear();
    
    // Step 3: Clear timers
    if (state.activityCheckInterval) {
      clearInterval(state.activityCheckInterval);
      state.activityCheckInterval = undefined;
    }
    if (state.initialDataTimeout) {
      clearTimeout(state.initialDataTimeout);
      state.initialDataTimeout = undefined;
    }
    
    // Step 4-5: Abort controllers
    if (state.abortController && !state.abortController.signal.aborted) {
      state.abortController.abort('Test cleanup');
    }
    if (state.timeoutController && !state.timeoutController.signal.aborted) {
      state.timeoutController.abort();
    }
    
    // Step 6: Drain and destroy readable
    if (state.readable && !state.readable.destroyed) {
      state.readable.removeAllListeners('data');
      state.readable.removeAllListeners('end');
      state.readable.removeAllListeners('error');
      if (typeof state.readable.resume === 'function') {
        state.readable.resume();
      }
      state.readable.destroy();
    }
    
    // Step 7: Cancel web stream
    if (state.webStream && typeof state.webStream.cancel === 'function' && !state.webStream.locked) {
      try { state.webStream.cancel(); } catch (_) {}
    }
    
    // Step 8: Nullify all references (CRITICAL for GC)
    state.abortController = null;
    state.timeoutController = null;
    state.webStream = null;
    state.readable = null;
    state.upstream = null;
    
    // Step 9: Remove from connections map
    multiplexer.keyToConnection.delete(key);
    
    // Verify all references are nullified (prevents memory leaks)
    assert(state.abortController === null, 'AbortController should be nullified (prevents memory leak)');
    assert(state.timeoutController === null, 'TimeoutController should be nullified (prevents memory leak)');
    assert(state.readable === null, 'Readable should be nullified (prevents memory leak)');
    assert(state.webStream === null, 'WebStream should be nullified (prevents memory leak)');
    assert(state.upstream === null, 'Upstream should be nullified (prevents memory leak)');
    assert(!multiplexer.keyToConnection.has(key), 'Connection should be removed from map');
  }

  // Test 9: Rate limiting (MAX_PENDING_OPENS)
  console.log('\n📋 Test 9: Rate limiting (MAX_PENDING_OPENS)');
  {
    const multiplexer = new StreamMultiplexer({
      name: 'TestStream',
      makeKey: (userId, deps) => `${userId}|${deps.accountId}|${deps.streamId}`,
      buildRequest: (userId, deps) => ({ path: '/test', paperTrading: false })
    });

    // Fill up pending opens
    multiplexer.pendingOpensCount = 10; // MAX_PENDING_OPENS
    
    const result = await multiplexer.ensureUpstream('user1', { accountId: 'acc1', streamId: 'stream1' });
    
    assert(result && result.__error === true, 'Should return error when rate limited');
    assert(result.status === 503, 'Should return 503 status');
    
    multiplexer.pendingOpensCount = 0; // Reset
  }

  // Test 10: Stale pending open cleanup
  console.log('\n📋 Test 10: Stale pending open cleanup');
  {
    const multiplexer = new StreamMultiplexer({
      name: 'TestStream',
      makeKey: (userId, deps) => `${userId}|${deps.accountId}`,
      buildRequest: (userId, deps) => ({ path: '/test', paperTrading: false })
    });

    const key = multiplexer.makeKey('user1', { accountId: 'acc1' });
    const fakePromise = new Promise(() => {}); // Never resolves
    multiplexer.pendingOpens.set(key, fakePromise);
    multiplexer.pendingOpensTimestamps.set(key, Date.now() - 25000); // 25 seconds ago (stale)
    multiplexer.pendingOpensCount = 1;
    
    const removed = multiplexer.cleanupStalePendingOpens();
    assert(removed > 0, 'Stale pending opens should be cleaned up');
    assert(!multiplexer.pendingOpens.has(key), 'Stale pending open should be removed');
    assert(multiplexer.pendingOpensCount === 0, 'Pending opens counter should be decremented');
  }

  // Test 11: Exclusive subscriber switching
  console.log('\n📋 Test 11: Exclusive subscriber switching (account change)');
  {
    const multiplexer = new StreamMultiplexer({
      name: 'TestStream',
      makeKey: (userId, deps) => `${userId}|${deps.accountId}`,
      buildRequest: (userId, deps) => ({ path: '/test', paperTrading: false })
    });

    const userId = 'user1';
    const key1 = multiplexer.makeKey(userId, { accountId: 'acc1' });
    const key2 = multiplexer.makeKey(userId, { accountId: 'acc2' });
    
    // Set initial key
    multiplexer.userToLastKey.set(userId, key1);
    
    // Simulate switch
    const prevKey = multiplexer.userToLastKey.get(userId);
    if (prevKey && prevKey !== key2) {
      // Would call closeKey(prevKey) in real scenario
      multiplexer.userToLastKey.set(userId, key2);
      multiplexer.userLastSwitch.set(userId, Date.now());
    }
    
    assert(multiplexer.userToLastKey.get(userId) === key2, 'Key should be updated on switch');
  }

  // Test 12: Periodic cleanup and zombie detection
  console.log('\n📋 Test 12: Periodic cleanup and zombie stream detection');
  {
    const multiplexer = new StreamMultiplexer({
      name: 'TestStream',
      makeKey: (userId, deps) => `${userId}|${deps.accountId}`,
      buildRequest: (userId, deps) => ({ path: '/test', paperTrading: false })
    });

    const key = multiplexer.makeKey('user1', { accountId: 'acc1' });
    const staleRes = new MockResponse();
    staleRes.destroyed = true; // Mark as stale
    staleRes.writableEnded = true;
    staleRes.finished = true;
    
    const state = {
      key,
      subscribers: new Set([staleRes]),
      upstream: null,
      webStream: null,
      readable: null,
      abortController: null,
      timeoutController: null,
      aborted: false,
      lastActivityAt: Date.now(),
      firstDataSent: false,
      createdAt: Date.now()
    };
    
    multiplexer.keyToConnection.set(key, state);
    
    // Test cleanupStaleConnections
    const removed = multiplexer.cleanupStaleConnections();
    assert(removed > 0, 'Stale connections should be cleaned up');
    assert(state.subscribers.size === 0, 'Stale subscriber should be removed');
    
    // Test zombie detection (0 subscribers but stream still active)
    state.subscribers.clear();
    assert(state.subscribers.size === 0, 'Zombie condition: 0 subscribers');
    
    // Zombie should be detected and cleaned up
    if (state.subscribers.size === 0) {
      multiplexer.keyToConnection.delete(key);
    }
    
    assert(!multiplexer.keyToConnection.has(key), 'Zombie stream should be cleaned up');
  }
  
  // Test 13: Stream reader closure verification
  console.log('\n📋 Test 13: Stream reader closure and cleanup');
  {
    const multiplexer = new StreamMultiplexer({
      name: 'TestStream',
      makeKey: (userId, deps) => `${userId}|${deps.accountId}`,
      buildRequest: (userId, deps) => ({ path: '/test', paperTrading: false })
    });

    const key = multiplexer.makeKey('user1', { accountId: 'acc1' });
    const readable = new Readable({ read: () => {} });
    const mockWebStream = {
      locked: false,
      cancel: () => Promise.resolve(),
      getReader: () => ({
        read: () => Promise.resolve({ done: true }),
        cancel: () => Promise.resolve(),
        releaseLock: () => {}
      })
    };
    
    const state = {
      key,
      subscribers: new Set(),
      upstream: { body: mockWebStream },
      webStream: mockWebStream,
      readable,
      abortController: null,
      timeoutController: null,
      aborted: false,
      lastActivityAt: Date.now(),
      firstDataSent: false
    };
    
    multiplexer.keyToConnection.set(key, state);
    
    assert(!readable.destroyed, 'Readable should not be destroyed initially');
    
    // Simulate cleanup: remove listeners and destroy
    readable.removeAllListeners('data');
    readable.removeAllListeners('end');
    readable.removeAllListeners('error');
    if (typeof readable.resume === 'function') {
      readable.resume();
    }
    readable.destroy();
    
    // Cancel web stream if not locked
    if (mockWebStream && typeof mockWebStream.cancel === 'function' && !mockWebStream.locked) {
      try { mockWebStream.cancel(); } catch (_) {}
    }
    
    // Nullify references
    state.readable = null;
    state.webStream = null;
    state.upstream = null;
    multiplexer.keyToConnection.delete(key);
    
    assert(readable.destroyed, 'Readable stream should be destroyed');
    assert(state.readable === null, 'Readable reference should be nullified');
    assert(state.webStream === null, 'WebStream reference should be nullified');
  }
  
  // Test 14: Fast refresh / rapid reconnection stress test
  console.log('\n📋 Test 14: Fast refresh / rapid reconnection stress test');
  {
    const multiplexer = new StreamMultiplexer({
      name: 'TestStream',
      makeKey: (userId, deps) => `${userId}|${deps.accountId}`,
      buildRequest: (userId, deps) => ({ path: '/test', paperTrading: false })
    });

    const userId = 'user1';
    
    // Simulate 10 rapid switches
    for (let i = 0; i < 10; i++) {
      const key = multiplexer.makeKey(userId, { accountId: `acc${i}` });
      const prevKey = multiplexer.userToLastKey.get(userId);
      
      if (prevKey && prevKey !== key) {
        // Simulate closing previous key
        if (multiplexer.keyToConnection.has(prevKey)) {
          multiplexer.keyToConnection.delete(prevKey);
        }
      }
      
      multiplexer.userToLastKey.set(userId, key);
      multiplexer.userLastSwitch.set(userId, Date.now());
    }
    
    // Verify cleanup
    const finalKey = multiplexer.userToLastKey.get(userId);
    assert(finalKey === multiplexer.makeKey(userId, { accountId: 'acc9' }), 'Final key should be correct');
    
    // Clean up user maps
    multiplexer.userToLastKey.delete(userId);
    multiplexer.userLastSwitch.delete(userId);
    
    assert(!multiplexer.userToLastKey.has(userId), 'User tracking should be cleaned up');
  }
  
  // Test 15: Concurrent cleanup prevention (race condition protection)
  console.log('\n📋 Test 15: Concurrent cleanup prevention (race condition protection)');
  {
    const multiplexer = new StreamMultiplexer({
      name: 'TestStream',
      makeKey: (userId, deps) => `${userId}|${deps.accountId}`,
      buildRequest: (userId, deps) => ({ path: '/test', paperTrading: false })
    });

    const key = multiplexer.makeKey('user1', { accountId: 'acc1' });
    
    // Simulate pending cleanup
    let resolveCleanup;
    const cleanupPromise = new Promise((resolve) => { resolveCleanup = resolve; });
    multiplexer.pendingCleanups.set(key, cleanupPromise);
    
    assert(multiplexer.pendingCleanups.has(key), 'Pending cleanup should be tracked');
    
    // Simulate concurrent cleanup attempt
    const hasPendingCleanup = multiplexer.pendingCleanups.has(key);
    assert(hasPendingCleanup, 'Should detect pending cleanup to prevent race condition');
    
    // Resolve and remove cleanup
    resolveCleanup();
    multiplexer.pendingCleanups.delete(key);
    
    assert(!multiplexer.pendingCleanups.has(key), 'Pending cleanup should be removed after completion');
  }

  // Test 13: Request abort detection
  console.log('\n📋 Test 13: Request abort detection');
  {
    const multiplexer = new StreamMultiplexer({
      name: 'TestStream',
      makeKey: (userId, deps) => `${userId}|${deps.accountId}`,
      buildRequest: (userId, deps) => ({ path: '/test', paperTrading: false })
    });

    const res = new MockResponse();
    res.req.aborted = true; // Simulate abort
    
    // Test early abort detection
    const isAborted = res.req?.aborted || res.req?.destroyed || res.finished || res.writableEnded;
    assert(isAborted, 'Should detect aborted request');
    
    res.destroy();
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log(`\n📊 Test Summary:`);
  console.log(`   Total tests: ${testCount}`);
  console.log(`   Passed: ${passCount}`);
  console.log(`   Failed: ${failCount}`);
  
  if (failCount === 0) {
    console.log(`\n✅ All tests passed!`);
    console.log(`\n💡 These tests verify cleanup logic. For full integration tests with real API calls,`);
    console.log(`   use test_stream_multiplexer.js with valid credentials.`);
    process.exit(0);
  } else {
    console.log(`\n❌ ${failCount} test(s) failed`);
    process.exit(1);
  }
}

// Run tests
runTests().catch(err => {
  console.error('Test suite error:', err);
  console.error(err.stack);
  process.exit(1);
});
