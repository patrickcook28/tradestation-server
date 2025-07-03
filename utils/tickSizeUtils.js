/**
 * Utility functions for handling tick sizes and price rounding for different futures contracts
 */

// Function to get the appropriate tick size for a futures contract
const getTickSize = (ticker) => {
  if (!ticker) return 0.01; // Default to 2 decimals for non-futures
  
  const baseTicker = ticker.replace(/[A-Z]\d{2}$/, ''); // Remove month/year suffix
  
  switch (baseTicker) {
    case 'MNQ':
    case 'NQ':
      return 0.25; // Quarter points
    case 'MES':
    case 'ES':
      return 0.25; // Quarter points
    case 'MYM':
    case 'YM':
      return 1; // Whole numbers
    case 'M2K':
    case 'RTY':
      return 0.1; // Tenths
    case 'CL': // Crude Oil
      return 0.01; // Pennies
    case 'GC': // Gold
      return 0.1; // Tenths
    default:
      return 0.01; // Default to 2 decimals for stocks/ETFs
  }
};

// Function to round to the appropriate tick size
const roundToTickSize = (price, ticker) => {
  const tickSize = getTickSize(ticker);
  return Math.round(price / tickSize) * tickSize;
};

// New function to specifically round to two decimal places
const roundToTwoDecimals = (num) => {
  if (typeof num !== 'number' || isNaN(num)) return 0;
  return parseFloat(num.toFixed(2));
};

// Function to round all std dev levels for a ticker to its appropriate tick size
const roundStdDevLevels = (levels, ticker) => {
  if (!levels) return levels;
  
  const rounded = {
    ...levels,
    mean_price: roundToTickSize(levels.mean_price, ticker),
    std_dev: roundToTickSize(levels.std_dev, ticker),
    std_dev_1_upper: roundToTickSize(levels.std_dev_1_upper, ticker),
    std_dev_1_lower: roundToTickSize(levels.std_dev_1_lower, ticker),
    std_dev_1_5_upper: roundToTickSize(levels.std_dev_1_5_upper, ticker),
    std_dev_1_5_lower: roundToTickSize(levels.std_dev_1_5_lower, ticker),
    std_dev_2_upper: roundToTickSize(levels.std_dev_2_upper, ticker),
    std_dev_2_lower: roundToTickSize(levels.std_dev_2_lower, ticker),
  };
  
  if (levels.reference_price) {
    rounded.reference_price = roundToTickSize(levels.reference_price, ticker);
  }
  
  return rounded;
};

module.exports = {
  getTickSize,
  roundToTickSize,
  roundToTwoDecimals,
  roundStdDevLevels
}; 