# Stream Connection Cleanup Fixes

## Problem
When refreshing browser pages or opening multiple tabs, subscriber counts were increasing indefinitely instead of properly cleaning up disconnected connections. The backend wasn't detecting when clients disconnected via browser refresh/close.

## Root Causes Identified

1. **Response events not firing reliably**: When `fetch()` is aborted on the client side, the server's `response` object doesn't always emit `'close'` events immediately or reliably
2. **Race conditions**: New connections established before old ones were cleaned up
3. **Stale connections**: Some connections were marked as ended but never removed from the subscribers set

## Fixes Implemented

### Backend (`streamMultiplexer.js`)

#### 1. Request-Level Event Listeners (CRITICAL FIX)
```javascript
// Listen to REQUEST events instead of just response events
res.req.on('close', () => { ... });
res.req.on('aborted', () => { ... });
```
**Why this matters**: When a browser refresh happens or fetch is aborted, the **request** object fires `'close'` and `'aborted'` events more reliably than the response object.

#### 2. Connection Tracking & Diagnostics
- Added `connectionId` to each subscriber (includes userId, key, streamEpoch, timestamp)
- Added `duration` tracking to see how long connections are active
- Enhanced logging to show connection lifecycle

#### 3. Defensive Checks
- Check if response object is already subscribed (prevent duplicates)
- Check if connection is already closed/aborted at subscription time
- Stale connection detection with periodic cleanup (every 60 seconds)

#### 4. Better Cleanup Detection
The cleanup handler now checks multiple conditions:
```javascript
if (!res.writableEnded && !res.finished) {
  onClose('req-close');
}
```

#### 5. Debug Methods
- `getDebugInfo()`: Shows all active streams, subscribers, connection durations, and active status
- `cleanupStaleConnections()`: Manually removes any dead connections still in the subscribers set

### Frontend (`stream.js`)

#### 1. Error Handling in Cleanup
```javascript
try {
  streamRef.current.abort();
} catch (e) {
  console.warn(`Error during cleanup abort:`, e.message);
}
```

#### 2. Cleanup Tracking
Added `cleanedUp` flag to prevent double-cleanup and better logging

### Debug Endpoints

#### `GET /debug/streams`
Returns detailed information about all active streams.

#### `POST /debug/streams/cleanup`
Manually triggers stale connection cleanup.

## Testing Instructions

### 1. Monitor Logs
Look for the enhanced logging with `req-close` or `req-aborted` events firing on browser refresh

### 2. Use Debug Endpoints
- GET `/debug/streams` - Check current subscribers
- POST `/debug/streams/cleanup` - Manually cleanup stale connections

### 3. Test Scenarios
- Single tab refresh: Counts should go down then back up
- Multiple tabs: Counts should reflect actual number of open connections
- Rapid refreshes: Counts should stabilize, not keep growing

## Summary

The critical fix was **listening to request-level events** (`req.on('close')` and `req.on('aborted')`) instead of relying solely on response events. This ensures the backend detects client disconnections immediately when browser is refreshed, fetch is aborted, tab is closed, or page navigates away.

