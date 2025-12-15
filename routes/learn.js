const logger = require('../config/logging');

// Learn content structure
const learnContent = {
  quickStart: {
    id: 'quick-start',
    title: 'Quick Start',
    type: 'section',
    subsections: [
      {
        id: 'connecting-broker',
        title: 'Connecting Your Broker',
        content: 'Connect your TradeStation account to get started. Navigate to Settings and click "Connect TradeStation Account". You\'ll be redirected to TradeStation\'s secure authorization page. After authorizing, you\'ll be redirected back to PrecisionTrader with your account connected.',
        keywords: ['broker', 'connect', 'tradestation', 'account', 'authorization', 'settings']
      },
      {
        id: 'selecting-account',
        title: 'Selecting Your Account',
        content: 'Once connected, you can choose between your live trading account and SIM (paper trading) account. Use the account selector in the top navigation or settings. SIM accounts are great for practicing without risking real capital. Live accounts execute real trades with real money.',
        keywords: ['account', 'select', 'live', 'sim', 'paper trading', 'practice']
      },
      {
        id: 'first-bracket-trade',
        title: 'Placing Your First Trade with Bracket Orders',
        content: 'Select a ticker from your watchlist or search for one. Set your entry price, stop loss, and take profit levels. PrecisionTrader will automatically calculate your position size based on your risk settings. Click "Place Bracket Order" to execute. You can drag the stop loss and take profit lines on the chart to adjust them before placing.',
        keywords: ['bracket order', 'first trade', 'entry', 'stop loss', 'take profit', 'position size', 'risk', 'drag', 'chart']
      }
    ]
  },
  tradingFundamentals: {
    id: 'trading-fundamentals',
    title: 'Trading Fundamentals',
    type: 'section',
    subsections: [
      {
        id: 'finding-edge',
        title: 'Finding Your Edge',
        content: 'Your edge is what gives you a statistical advantage in the markets. It could be a specific pattern, a time of day, a particular setup, or a combination of factors. The key is identifying something that works consistently over time. However, having an edge alone isn\'t enough—you need discipline to execute it consistently and protect it through proper risk management.',
        keywords: ['edge', 'advantage', 'pattern', 'setup', 'statistical', 'discipline']
      },
      {
        id: 'trading-discipline',
        title: 'Trading Discipline',
        content: 'Discipline is often what separates consistent traders from those who struggle. It means following your trading plan even when emotions are running high. Common discipline pitfalls include revenge trading after a loss, overtrading, and deviating from your plan. Build consistent habits by creating a routine, setting clear rules, and using tools like loss limits to enforce discipline automatically.',
        keywords: ['discipline', 'plan', 'emotions', 'revenge trading', 'overtrading', 'habits', 'routine', 'rules']
      },
      {
        id: 'risk-management-fundamentals',
        title: 'Risk Management Fundamentals',
        content: 'Stop losses are essential—they limit your downside on every trade. Position sizing determines how much you risk per trade, typically 1-2% of your account. Risk-reward ratios help ensure your winners are larger than your losers. Daily and per-trade loss limits prevent catastrophic drawdowns. Never risk more than you can afford to lose.',
        keywords: ['stop loss', 'position sizing', 'risk', 'risk-reward', 'daily loss', 'trade loss', 'drawdown']
      },
      {
        id: 'take-profit-strategy',
        title: 'Take Profit Strategy',
        content: 'Knowing when to take profits is crucial. Some traders scale out (take partial profits at multiple levels), while others take everything at once. Your profit targets should be based on your edge and risk-reward ratio. Avoid greed-driven decisions by setting profit targets before entering the trade. Multiple take profit brackets allow you to lock in profits at different levels.',
        keywords: ['take profit', 'profit target', 'scaling out', 'risk-reward', 'greed', 'multiple targets', 'brackets']
      },
      {
        id: 'trading-structure',
        title: 'Trading Structure & Routine',
        content: 'A structured approach to trading often improves consistency. Pre-market preparation includes reviewing your watchlist, checking market conditions, and reviewing your trading plan. During the session, follow your entry and exit rules strictly. Post-market review involves journaling your trades, analyzing what worked and what didn\'t, and planning for the next session.',
        keywords: ['structure', 'routine', 'pre-market', 'preparation', 'watchlist', 'post-market', 'review', 'plan']
      },
      {
        id: 'trade-journaling',
        title: 'Trade Journaling',
        content: 'Journaling helps you learn from every trade. Record your entry, exit, reasoning, emotions, and outcome. Over time, patterns may emerge—you may notice which setups you use most often, when you trade most actively, and what mistakes you repeat. PrecisionTrader\'s built-in journal allows you to record your trades, making it easy to review and analyze your trading activity.',
        keywords: ['journal', 'journaling', 'record', 'analyze', 'performance', 'patterns', 'built-in', 'automatic']
      }
    ]
  },
  softwareGuides: {
    id: 'software-guides',
    title: 'Software Guides',
    type: 'section',
    subsections: [
      {
        id: 'getting-started',
        title: 'Getting Started',
        content: 'After connecting your TradeStation account, familiarize yourself with the interface. The main trading page includes the chart, order panel, positions, and watchlists. On mobile, the interface is optimized for touch with intuitive gestures and a clean, uncluttered design. Use the bottom navigation to switch between Trade, Watchlists, Portfolio, and Settings.',
        keywords: ['interface', 'navigation', 'mobile', 'touch', 'chart', 'order panel', 'positions', 'watchlists'],
        featured: false
      },
      {
        id: 'risk-management-tools',
        title: 'Risk Management Tools',
        content: 'Set daily loss limits to automatically stop trading if you exceed your daily risk threshold. Position loss limits protect you from individual trades going too far against you. These limits can be locked for a period to prevent emotional changes. Navigate to Settings > Risk Management to configure these tools. Position loss alerts notify you when a position moves against you significantly.',
        keywords: ['risk management', 'daily loss', 'position loss', 'limits', 'alerts', 'settings', 'lock'],
        featured: true
      },
      {
        id: 'auto-position-sizing',
        title: 'Auto Position Sizing',
        content: 'PrecisionTrader automatically calculates your position size based on your stop loss placement and risk settings. Set your risk per trade (dollar amount or percentage) in Settings. When you place a bracket order, the system calculates how many shares or contracts you should trade to risk exactly that amount. This eliminates guesswork and ensures consistent risk across all trades.',
        keywords: ['position sizing', 'auto', 'automatic', 'calculate', 'stop loss', 'risk per trade', 'shares', 'contracts'],
        featured: true
      },
      {
        id: 'entering-trades',
        title: 'Entering Trades',
        content: 'Select a ticker from your watchlist or use the search function. Choose your order type (market, limit, etc.) and set your entry price if using a limit order. The order panel shows your position size, risk amount, and potential profit. Click "Place Order" to execute. For bracket orders, set your stop loss and take profit levels before placing.',
        keywords: ['enter trade', 'ticker', 'watchlist', 'search', 'order type', 'market', 'limit', 'entry', 'place order'],
        featured: false
      },
      {
        id: 'bracket-orders',
        title: 'Bracket Orders',
        content: 'Bracket orders combine your entry, stop loss, and take profit in one order. Create them by setting your entry price, then dragging the stop loss and take profit lines on the chart. You can set multiple take profit levels for scaling out. Custom brackets allow you to set different quantities at each profit level. After placing, you can modify active brackets by dragging the lines on the chart.',
        keywords: ['bracket order', 'entry', 'stop loss', 'take profit', 'drag', 'multiple', 'scaling out', 'custom', 'modify'],
        featured: true
      },
      {
        id: 'liquidity-indicator',
        title: 'Liquidity Indicator',
        content: 'The liquidity overlay visualizes key price levels based on Level 2 market data. Areas of high liquidity appear as colored zones on the chart, helping you identify support and resistance levels. Use this information to plan entries and exits. The indicator updates in real-time as market conditions change. Requires TradeStation data feed subscription.',
        keywords: ['liquidity', 'level 2', 'overlay', 'support', 'resistance', 'entries', 'exits', 'real-time'],
        featured: true
      },
      {
        id: 'position-management',
        title: 'Position Management',
        content: 'View all open positions in the Positions tab. Each position shows your entry price, current P&L, stop loss, and take profit levels. Click on a position to modify its stop loss or take profit by dragging the lines on the chart. Close positions manually or let your stops and targets execute automatically. Scale in or out by placing additional orders.',
        keywords: ['positions', 'open', 'P&L', 'modify', 'close', 'scale', 'stop', 'target'],
        featured: false
      },
      {
        id: 'chart-indicators',
        title: 'Chart & Indicators',
        content: 'Add indicators by clicking the indicators button on the chart. Select from a list of available indicators including moving averages, RSI, MACD, and more. Customize indicator settings by clicking on them after adding. Remove indicators by clicking the X icon. Use chart tools to zoom, pan, and draw trend lines.',
        keywords: ['chart', 'indicators', 'moving average', 'RSI', 'MACD', 'customize', 'remove', 'tools'],
        featured: false
      },
      {
        id: 'watchlists',
        title: 'Watchlists',
        content: 'Create watchlists to organize tickers you\'re monitoring. Add tickers by searching and clicking "Add to Watchlist". Create multiple watchlists for different strategies or timeframes. Remove tickers by clicking the X icon. Watchlists sync across devices so you can access them from desktop or mobile.',
        keywords: ['watchlist', 'create', 'add', 'remove', 'organize', 'tickers', 'sync'],
        featured: false
      },
      {
        id: 'built-in-journal',
        title: 'Built-In Trade Journal',
        content: 'PrecisionTrader automatically records every trade you make. View your trade history in the Trade Journal section. Each entry includes entry/exit prices, P&L, time in trade, and more. Export your journal data for external analysis. Use the journal to identify patterns, review your trading activity, and track your progress over time.',
        keywords: ['journal', 'trade journal', 'history', 'record', 'export', 'analyze', 'performance', 'patterns'],
        featured: true
      }
    ]
  }
};

const getLearnContent = async (req, res) => {
  try {
    res.json({ success: true, content: learnContent });
  } catch (error) {
    logger.error('Error fetching learn content:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch learn content' 
    });
  }
};

const learnRoutes = {
  getLearnContent
};

module.exports = learnRoutes;

