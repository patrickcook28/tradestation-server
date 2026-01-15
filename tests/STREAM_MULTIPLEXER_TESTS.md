# Stream Multiplexer Comprehensive Test Suite

## Overview

This test suite (`test_stream_multiplexer_comprehensive.js`) provides **robust testing** for the StreamMultiplexer's critical cleanup and memory leak prevention mechanisms. It focuses on ensuring that:

- ✅ All streams are properly aborted and cleaned up
- ✅ Socket connections are closed
- ✅ Readers are properly closed
- ✅ Memory leaks are prevented through reference nullification
- ✅ Multiple users are properly isolated
- ✅ Fast refreshes don't accumulate resources
- ✅ Stream recycling works without memory accumulation

## What Gets Tested

### 1. Memory Leak Prevention
- **AbortController nullification**: Verifies abort controllers are aborted and nullified
- **Stream reference cleanup**: Ensures readable, webStream, and upstream references are nullified
- **Timer cleanup**: Verifies activity check intervals and initial data timeouts are cleared
- **Complete reference nullification**: All 8 cleanup steps from `_destroyConnection` are verified

### 2. Abort & Cleanup
- **Abort controller lifecycle**: Proper abort signal handling
- **Stream reader closure**: Readable streams are destroyed with listeners removed
- **Web stream cancellation**: Web streams are cancelled if not locked
- **Subscriber cleanup**: All subscribers are properly closed

### 3. Multi-User Scenarios
- **User isolation**: Separate upstreams per user with different keys
- **User tracking cleanup**: User maps are cleaned up when no connections remain
- **Concurrent users**: Multiple users can have active streams simultaneously

### 4. Fast Refresh / Rapid Reconnection
- **Rapid switching**: Handles rapid account switches without resource accumulation
- **Throttling**: Verifies rapid switch throttling logic
- **Cleanup after rapid switches**: All resources cleaned up after rapid reconnections

### 5. Stream Management
- **Stream recycle**: Same key can be reused after cleanup without leaks
- **Zombie detection**: 0-subscriber streams are detected and cleaned up
- **Stale connection cleanup**: Dead subscribers are removed
- **Periodic cleanup**: Automatic cleanup of stale connections

### 6. Rate Limiting & Protection
- **MAX_PENDING_OPENS**: Rate limiting prevents too many concurrent opens
- **Stale pending open cleanup**: Stuck pending opens are removed after threshold
- **Concurrent cleanup prevention**: Race condition protection via pendingCleanups map

## Running the Tests

### Quick Run
```bash
cd tradestation-server
node tests/test_stream_multiplexer_comprehensive.js
```

### Via npm script
```bash
npm run test:streams
```

### Via Husky (automatic on git push)
The tests run automatically before any `git push` via the husky pre-push hook.

To skip tests (emergency only):
```bash
git push --no-verify
```

## Test Coverage

The suite includes **15 comprehensive tests** covering:

1. ✅ Basic state initialization and structure
2. ✅ Multiple subscribers to same upstream
3. ✅ Abort controller lifecycle and cleanup
4. ✅ Timer cleanup (critical for memory leaks)
5. ✅ Multiple users with different stream keys
6. ✅ Fast refresh / rapid reconnection handling
7. ✅ Stream recycle - same key reused after cleanup
8. ✅ Memory leak prevention - complete reference nullification
9. ✅ Rate limiting (MAX_PENDING_OPENS)
10. ✅ Stale pending open cleanup
11. ✅ Exclusive subscriber switching (account change)
12. ✅ Periodic cleanup and zombie stream detection
13. ✅ Stream reader closure and cleanup
14. ✅ Fast refresh stress test (10 rapid switches)
15. ✅ Concurrent cleanup prevention (race condition protection)

## Expected Output

When all tests pass:
```
🧪 StreamMultiplexer Comprehensive Test Suite

Testing memory leak prevention, cleanup, abort handling, and multi-user scenarios...

📋 Test 1: Basic state initialization and structure
✅ keyToConnection should be a Map
✅ pendingOpens should be a Map
...

============================================================

📊 Test Summary:
   Total tests: 45+
   Passed: 45+
   Failed: 0

✅ All tests passed!
```

## Integration with Husky

Tests run automatically on `git push` via `.husky/pre-push` hook. This ensures:

- No memory leaks are pushed to production
- Cleanup logic is verified before deployment
- Stream management code is validated

## Notes

- These tests focus on **cleanup logic** and can run without full API integration
- For full integration tests with real TradeStation API calls, use `test_stream_multiplexer.js`
- The tests verify the critical cleanup steps from `_destroyConnection` method
- All tests are designed to catch memory leaks and resource accumulation issues
