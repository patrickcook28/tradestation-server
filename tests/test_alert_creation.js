const { getCurrentContractSymbol } = require('../utils/contractSymbols');

// Test the contract symbol calculation
console.log('Testing contract symbol calculation:');
console.log('Current MNQ contract:', getCurrentContractSymbol('MNQ'));
console.log('Current ES contract:', getCurrentContractSymbol('ES'));
console.log('Current NQ contract:', getCurrentContractSymbol('NQ'));

// Test the alert creation logic (simulated)
console.log('\nTesting alert creation logic:');

const testAlertData = {
  ticker: getCurrentContractSymbol('MNQ'),
  alert_type: 'above',
  price_level: '16500.50',
  std_dev_level: '',
  timeframe: ''
};

console.log('Price-based alert data:', testAlertData);

const testStdDevAlertData = {
  ticker: getCurrentContractSymbol('MNQ'),
  alert_type: 'above',
  price_level: '',
  std_dev_level: '1.5',
  timeframe: '15min'
};

console.log('Std Dev alert data:', testStdDevAlertData);

// Simulate the backend processing
console.log('\nSimulating backend processing:');

if (testStdDevAlertData.std_dev_level && testStdDevAlertData.timeframe) {
  console.log('✅ Std dev alert detected');
  console.log('Converting std dev level:', testStdDevAlertData.std_dev_level);
  
  const stdDevMap = {
    '1.0': 'std_dev_1',
    '1.5': 'std_dev_1_5', 
    '2.0': 'std_dev_2',
    '2.5': 'std_dev_2_5',
    '3.0': 'std_dev_3'
  };
  
  const backendStdDevLevel = stdDevMap[testStdDevAlertData.std_dev_level];
  console.log('Backend std dev level:', backendStdDevLevel);
  
  const upperKey = `${backendStdDevLevel}_upper`;
  const lowerKey = `${backendStdDevLevel}_lower`;
  
  console.log('Upper key:', upperKey);
  console.log('Lower key:', lowerKey);
  
  if (testStdDevAlertData.alert_type === 'above') {
    console.log('Alert type is "above", will use upper level');
  } else {
    console.log('Alert type is "below", will use lower level');
  }
} else {
  console.log('✅ Price-based alert detected');
}

console.log('\nTest completed successfully!'); 