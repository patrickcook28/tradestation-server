-- Trade Alert System Database Schema

-- Trade Alerts table
CREATE TABLE IF NOT EXISTS trade_alerts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    ticker VARCHAR(10) NOT NULL,
    alert_type VARCHAR(20) NOT NULL CHECK (alert_type IN ('above', 'below')),
    price_level DECIMAL(10, 2) NOT NULL,
    std_dev_level VARCHAR(30), -- For std dev alerts: std_dev_1_upper, std_dev_1_lower, etc.
    timeframe VARCHAR(20), -- For std dev alerts: 5min, 15min, 30min, 1hour, 4hour, daily
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Standard Deviation Levels table
CREATE TABLE IF NOT EXISTS std_dev_levels (
    id SERIAL PRIMARY KEY,
    ticker VARCHAR(10) NOT NULL,
    timeframe VARCHAR(20) NOT NULL DEFAULT '1hour',
    reference_price DECIMAL(10, 2),
    mean_price DECIMAL(10, 2),
    std_dev DECIMAL(10, 2),
    std_dev_1_upper DECIMAL(10, 2),
    std_dev_1_lower DECIMAL(10, 2),
    std_dev_1_5_upper DECIMAL(10, 2),
    std_dev_1_5_lower DECIMAL(10, 2),
    std_dev_2_upper DECIMAL(10, 2),
    std_dev_2_lower DECIMAL(10, 2),
    bars_count INTEGER,
    last_calculated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(ticker, timeframe)
);

-- Alert Logs table
CREATE TABLE IF NOT EXISTS alert_logs (
    id SERIAL PRIMARY KEY,
    alert_id INTEGER REFERENCES trade_alerts(id) ON DELETE CASCADE,
    ticker VARCHAR(10) NOT NULL,
    trigger_price DECIMAL(10, 2) NOT NULL,
    alert_type VARCHAR(20) NOT NULL,
    triggered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    email_sent BOOLEAN DEFAULT false,
    email_sent_at TIMESTAMP,
    sms_sent BOOLEAN DEFAULT false,
    sms_sent_at TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_trade_alerts_user_id ON trade_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_trade_alerts_ticker ON trade_alerts(ticker);
CREATE INDEX IF NOT EXISTS idx_std_dev_levels_ticker_timeframe ON std_dev_levels(ticker, timeframe);
CREATE INDEX IF NOT EXISTS idx_alert_logs_alert_id ON alert_logs(alert_id);
CREATE INDEX IF NOT EXISTS idx_alert_logs_ticker ON alert_logs(ticker); 