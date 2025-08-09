/**
 * Utility functions for calculating current futures contract symbols
 */

const FUTURES_MONTHS = [
  { code: 'H', month: 2, name: 'March' },
  { code: 'M', month: 5, name: 'June' },
  { code: 'U', month: 8, name: 'September' },
  { code: 'Z', month: 11, name: 'December' }
];

/**
 * Get the next contract month for a given date
 * @param {Date} date - The reference date
 * @returns {Object} - { monthCode, year, monthName }
 */
function getNextContractMonth(date = new Date()) {
  const currentMonth = date.getMonth();
  const currentYear = date.getFullYear();
  
  // Find the next contract month
  let contract = FUTURES_MONTHS.find(m => m.month > currentMonth);
  
  if (!contract) {
    // If no contract found, use next year's first month
    contract = FUTURES_MONTHS[0];
    return {
      monthCode: contract.code,
      year: currentYear + 1,
      monthName: contract.name
    };
  }
  
  return {
    monthCode: contract.code,
    year: currentYear,
    monthName: contract.name
  };
}

/**
 * Generate current contract symbol for a futures product
 * @param {string} product - The futures product (e.g., 'MNQ', 'ES', 'NQ')
 * @param {Date} date - The reference date
 * @returns {string} - The contract symbol (e.g., 'MNQZ24')
 */
function getCurrentContractSymbol(product, date = new Date()) {
  const { monthCode, year } = getNextContractMonth(date);
  const shortYear = year % 100;
  return `${product}${monthCode}${shortYear.toString().padStart(2, '0')}`;
}

/**
 * Get a list of common futures products with their current contracts
 * @param {Date} date - The reference date
 * @returns {Array} - Array of { symbol, name, currentContract }
 */
function getCommonFuturesContracts(date = new Date()) {
  const futures = [
    // Equity index futures (E-mini & Micro E-mini)
    { symbol: 'MES', name: 'Micro E-mini S&P 500' },
    { symbol: 'MNQ', name: 'Micro E-mini Nasdaq-100' },
    { symbol: 'ES',  name: 'E-mini S&P 500' },
    { symbol: 'NQ',  name: 'E-mini Nasdaq-100' },
    { symbol: 'YM',  name: 'E-mini Dow Jones' },
    { symbol: 'MYM', name: 'Micro E-mini Dow Jones' },
    { symbol: 'RTY', name: 'E-mini Russell 2000' },
    { symbol: 'M2K', name: 'Micro E-mini Russell 2000' },

    // Energies
    { symbol: 'CL',  name: 'Crude Oil' },
    { symbol: 'MCL', name: 'Micro WTI Crude Oil' },

    // Metals
    { symbol: 'GC',  name: 'Gold' },
    { symbol: 'MGC', name: 'Micro Gold' },
    { symbol: 'SI',  name: 'Silver' },
    { symbol: 'SIL', name: 'Micro Silver' },
  ];
  
  return futures.map(future => ({
    ...future,
    currentContract: getCurrentContractSymbol(future.symbol, date)
  }));
}

/**
 * Get all available contract symbols for a product (current + next few)
 * @param {string} product - The futures product
 * @param {number} count - Number of contracts to generate
 * @param {Date} date - The reference date
 * @returns {Array} - Array of contract symbols
 */
function getContractSeries(product, count = 4, date = new Date()) {
  const contracts = [];
  let currentDate = new Date(date);
  
  for (let i = 0; i < count; i++) {
    contracts.push(getCurrentContractSymbol(product, currentDate));
    
    // Move to next contract month
    const { monthCode, year } = getNextContractMonth(currentDate);
    const nextMonthIndex = FUTURES_MONTHS.find(m => m.code === monthCode).month;
    currentDate = new Date(year, nextMonthIndex, 1);
  }
  
  return contracts;
}

module.exports = {
  getCurrentContractSymbol,
  getCommonFuturesContracts,
  getContractSeries,
  getNextContractMonth,
  FUTURES_MONTHS
}; 