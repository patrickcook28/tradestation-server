const pool = require('../db');
const RealtimeAlertChecker = require('../workers/realtimeAlertChecker');

async function testTimeframeAlerts() {
  console.log('🧪 Testing Timeframe-Based Alert System\n');
  
  try {
    // 1. Create test alerts for different timeframes
    console.log('1. Creating test alerts...');
    
    const testAlerts = [
      {
        ticker: 'MNQ',
        alert_type: 'above',
        price_level: 12345.0,
        timeframe: '5min',
        description: 'Test 5min alert'
      },
      {
        ticker: 'MNQ', 
        alert_type: 'above',
        price_level: 12346.0,
        timeframe: '15min',
        description: 'Test 15min alert'
      },
      {
        ticker: 'MNQ',
        alert_type: 'below', 
        price_level: 12344.0,
        timeframe: '1hour',
        description: 'Test 1hour alert'
      }
    ];
    
    for (const alertData of testAlerts) {
      const insertQuery = `
        INSERT INTO trade_alerts (ticker, alert_type, price_level, timeframe, description, is_active, user_id)
        VALUES ($1, $2, $3, $4, $5, true, 1)
        RETURNING *
      `;
      
      const result = await pool.query(insertQuery, [
        alertData.ticker,
        alertData.alert_type,
        alertData.price_level,
        alertData.timeframe,
        alertData.description
      ]);
      
      console.log(`   Created ${alertData.timeframe} alert: ${alertData.alert_type} ${alertData.price_level}`);
    }
    
    // 2. Test the timeframe calculation logic
    console.log('\n2. Testing timeframe calculations...');
    
    const alertChecker = new RealtimeAlertChecker();
    
    const timeframes = ['5min', '15min', '30min', '1hour', '4hour', 'daily'];
    const now = new Date();
    
    for (const timeframe of timeframes) {
      const candleTime = alertChecker.getCurrentCandleTime(timeframe);
      const candleDate = new Date(candleTime);
      
      console.log(`   ${timeframe}: ${candleDate.toLocaleString()} (${candleTime})`);
    }
    
    // 3. Test alert state management
    console.log('\n3. Testing alert state management...');
    
    // Load alerts
    await alertChecker.loadAlerts();
    
    // Check initial states
    console.log('   Initial alert states:');
    for (const [alertId, state] of alertChecker.alertStates) {
      console.log(`   Alert ${alertId}: triggered=${state.triggered}, lastCandleTime=${state.lastCandleTime}`);
    }
    
    // 4. Test reset logic
    console.log('\n4. Testing reset logic...');
    
    // Simulate checking if alerts should reset
    for (const [alertId, state] of alertChecker.alertStates) {
      const alerts = Array.from(alertChecker.alertCache.values()).flat();
      const alert = alerts.find(a => a.id === alertId);
      
      if (alert) {
        const shouldReset = alertChecker.shouldResetAlert(alert, state);
        console.log(`   Alert ${alertId} (${alert.timeframe}): shouldReset=${shouldReset}`);
      }
    }
    
    // 5. Test with mock price data
    console.log('\n5. Testing with mock price data...');
    
    const mockPriceData = {
      high: 12347.0,  // Above both alert levels
      low: 12343.0,   // Below the "below" alert level
      close: 12345.5,
      lastPrice: 12345.5
    };
    
    console.log(`   Mock price data: high=${mockPriceData.high}, low=${mockPriceData.low}`);
    
    // Test each alert
    for (const [alertId, state] of alertChecker.alertStates) {
      const alerts = Array.from(alertChecker.alertCache.values()).flat();
      const alert = alerts.find(a => a.id === alertId);
      
      if (alert) {
        console.log(`   Testing alert ${alertId} (${alert.alert_type} ${alert.price_level} ${alert.timeframe}):`);
        
        // Simulate the check logic
        let shouldTrigger = false;
        if (alert.alert_type === 'above' && mockPriceData.high >= alert.price_level) {
          shouldTrigger = !state.triggered;
        } else if (alert.alert_type === 'below' && mockPriceData.low <= alert.price_level) {
          shouldTrigger = !state.triggered;
        }
        
        console.log(`     Should trigger: ${shouldTrigger} (triggered=${state.triggered})`);
      }
    }
    
    // 6. Start the realtime checker for live testing
    console.log('\n6. Starting realtime checker for live testing...');
    console.log('   (Press Ctrl+C to stop)');
    
    await alertChecker.start();
    
    // Let it run for a bit to see the behavior
    setTimeout(async () => {
      console.log('\n   Stopping realtime checker...');
      await alertChecker.stop();
      
      // Clean up test alerts
      console.log('\n7. Cleaning up test alerts...');
      const deleteQuery = "DELETE FROM trade_alerts WHERE description LIKE 'Test %'";
      await pool.query(deleteQuery);
      console.log('   Test alerts cleaned up');
      
      process.exit(0);
    }, 30000); // Run for 30 seconds
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

// Helper function to show current market data
async function showCurrentMarketData() {
  try {
    console.log('\n📊 Current Market Data:');
    
    // Get API credentials for test user (user_id 1)
    const credentialsQuery = 'SELECT * FROM api_credentials WHERE user_id = $1 LIMIT 1';
    const credentialsResult = await pool.query(credentialsQuery, [1]); // Using user_id 1 for testing
    
    if (credentialsResult.rows.length === 0) {
      console.log('   No API credentials found for test user (user_id 1)');
      return;
    }
    
    const credentials = credentialsResult.rows[0];
    const fetch = require('node-fetch');
    
    // Fetch MNQ quote
    const quoteUrl = 'https://api.tradestation.com/v3/marketdata/quotes/MNQ';
    const response = await fetch(quoteUrl, {
      headers: {
        'Authorization': `Bearer ${credentials.access_token}`
      }
    });
    
    if (response.ok) {
      const data = await response.json();
      const quote = data.Quotes?.[0];
      
      if (quote) {
        console.log(`   MNQ: High=${quote.High}, Low=${quote.Low}, Last=${quote.LastPrice}`);
      } else {
        console.log('   No quote data available');
      }
    } else {
      console.log(`   API error: ${response.status}`);
    }
    
  } catch (error) {
    console.error('   Error fetching market data:', error.message);
  }
}

// Run the test
if (require.main === module) {
  testTimeframeAlerts();
  
  // Also show current market data
  setTimeout(showCurrentMarketData, 2000);
} 