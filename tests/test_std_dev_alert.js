const pool = require('../db');
const fetch = require('node-fetch');

async function testStdDevAlert() {
  try {
    console.log('Testing Standard Deviation Alert Creation...');
    
    // Example: Create an alert when MNQM24 crosses above 1.5 standard deviation
    const alertData = {
      ticker: 'MNQM24',
      alert_type: 'above',
      std_dev_level: 'std_dev_1_5_upper', // 1.5 standard deviation upper band
      timeframe: '1hour'
    };
    
    console.log('Creating alert with data:', alertData);
    
    const response = await fetch('http://localhost:3001/std_dev_alerts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer YOUR_JWT_TOKEN' // You'll need to replace this with a valid token
      },
      body: JSON.stringify(alertData)
    });
    
    const result = await response.json();
    
    if (response.ok) {
      console.log('✅ Standard Deviation Alert created successfully!');
      console.log('Alert details:', result);
    } else {
      console.log('❌ Failed to create alert:', result);
    }
    
  } catch (error) {
    console.error('Error testing std dev alert:', error);
  }
}

// Available std_dev_level options:
// - std_dev_1_upper: 1 standard deviation upper band
// - std_dev_1_lower: 1 standard deviation lower band  
// - std_dev_1_5_upper: 1.5 standard deviation upper band
// - std_dev_1_5_lower: 1.5 standard deviation lower band
// - std_dev_2_upper: 2 standard deviation upper band
// - std_dev_2_lower: 2 standard deviation lower band

// Available timeframes:
// - 5min, 15min, 30min, 1hour, 4hour, daily

console.log('Standard Deviation Alert Test Script');
console.log('====================================');
console.log('Available std_dev_level options:');
console.log('- std_dev_1_upper: 1 standard deviation upper band');
console.log('- std_dev_1_lower: 1 standard deviation lower band');
console.log('- std_dev_1_5_upper: 1.5 standard deviation upper band');
console.log('- std_dev_1_5_lower: 1.5 standard deviation lower band');
console.log('- std_dev_2_upper: 2 standard deviation upper band');
console.log('- std_dev_2_lower: 2 standard deviation lower band');
console.log('');
console.log('Available timeframes: 5min, 15min, 30min, 1hour, 4hour, daily');
console.log('');

testStdDevAlert(); 