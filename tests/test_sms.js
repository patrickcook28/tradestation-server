const twilio = require('twilio');
const config = require('../config/twilio');
const AlertChecker = require('../workers/alertChecker');
const checker = new AlertChecker();

const mockAlert = {
  id: 999,
  ticker: 'MNQM24',
  alert_type: 'above',
  price_level: 5000.00
};
const mockTriggerPrice = 5001.50;
const mockLogEntry = {
  id: 999,
  triggered_at: new Date().toISOString()
};

console.log('Testing SMS notification...');
checker.sendSmsNotification(mockAlert, mockTriggerPrice, mockLogEntry); 