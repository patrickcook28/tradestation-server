// Twilio Configuration
module.exports = {
  // Account SID should start with "AC" (not "SK")
  accountSid: process.env.TWILIO_ACCOUNT_SID,
  authToken: process.env.TWILIO_AUTH_TOKEN,
  
  // Phone Numbers
  fromNumber: process.env.TWILIO_FROM_NUMBER, 
  toNumber: process.env.TWILIO_TO_NUMBER,
  
  // SMS Settings
  messageTemplate: (alert, triggerPrice, triggeredAt) => {
    const time = new Date(triggeredAt).toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit', 
      hour12: true 
    });
    
    const timeframe = alert.timeframe || '1hour';
    const direction = alert.alert_type === 'above' ? 'crossed above' : 'crossed below';
    
    // Determine if this is a std dev level or price level alert
    let levelDisplay;
    if (alert.std_dev_level) {
      // Format std dev level like "+1.5 Std Dev level"
      const stdDevMatch = alert.std_dev_level.match(/std_dev_(\d+(?:_\d+)?)_(upper|lower)/);
      if (stdDevMatch) {
        const level = stdDevMatch[1].replace('_', '.');
        const sign = stdDevMatch[2] === 'upper' ? '+' : '-';
        levelDisplay = `(${sign}${level} Std Dev level)`;
      } else {
        levelDisplay = `(${alert.std_dev_level})`;
      }
    } else {
      levelDisplay = '(price level)';
    }
    
    // Use the actual price level that was crossed
    const crossedLevel = alert.price_level;
    
    return `🚨 PRICE ALERT 🚨
    ${alert.ticker} current: ${triggerPrice} ${direction} ${crossedLevel} ${levelDisplay}
    Time: ${time} [${timeframe} timeframe]`;
  }
}; 