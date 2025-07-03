#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

console.log('🧪 Trade Alert System Test Runner\n');

// Get all test files
const testFiles = fs.readdirSync(__dirname)
  .filter(file => file.startsWith('test_') && file.endsWith('.js'))
  .filter(file => file !== 'run_tests.js');

console.log('Available tests:');
testFiles.forEach((file, index) => {
  console.log(`  ${index + 1}. ${file}`);
});

console.log('\nTo run a specific test:');
console.log('  node tests/test_timeframe_alerts.js');
console.log('  node tests/test_std_dev_alert.js');
console.log('  node tests/test_sms.js');

console.log('\nTo run all tests:');
console.log('  npm test');

console.log('\n📋 Test Descriptions:');
console.log('  • test_timeframe_alerts.js - Tests the new timeframe-based alert reset logic');
console.log('  • test_std_dev_alert.js - Tests creating and managing std dev alerts');
console.log('  • test_sms.js - Tests SMS notification functionality');

console.log('\n💡 Tips:');
console.log('  • Make sure your database is running');
console.log('  • Ensure you have valid TradeStation API credentials');
console.log('  • Check that Twilio is configured for SMS tests');
console.log('  • Some tests create temporary data that gets cleaned up automatically'); 