-- Trade Alert System Database Schema

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(100) NOT NULL,
    password VARCHAR(100) NOT NULL
);

-- API Credentials table
CREATE TABLE IF NOT EXISTS api_credentials (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    access_token VARCHAR(1500) NOT NULL,
    refresh_token VARCHAR(100) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Trade Alerts table
CREATE TABLE IF NOT EXISTS trade_alerts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    ticker VARCHAR(10) NOT NULL,
    alert_type VARCHAR(20) NOT NULL CHECK (alert_type IN ('above', 'below')),
    price_level NUMERIC(10, 2) NOT NULL,
    std_dev_level VARCHAR(30), -- For std dev alerts: std_dev_1_upper, std_dev_1_lower, etc.
    timeframe VARCHAR(20), -- For std dev alerts: 5min, 15min, 30min, 1hour, 4hour, daily
    description TEXT,
    indicator_type VARCHAR(20),
    indicator_period INTEGER,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Standard Deviation Levels table
CREATE TABLE IF NOT EXISTS std_dev_levels (
    id SERIAL PRIMARY KEY,
    ticker VARCHAR(10) NOT NULL,
    timeframe VARCHAR(20) NOT NULL DEFAULT '1hour',
    reference_price NUMERIC(10, 2),
    mean_price NUMERIC(10, 2),
    std_dev NUMERIC(10, 2),
    std_dev_1_upper NUMERIC(10, 2),
    std_dev_1_lower NUMERIC(10, 2),
    std_dev_1_5_upper NUMERIC(10, 2),
    std_dev_1_5_lower NUMERIC(10, 2),
    std_dev_2_upper NUMERIC(10, 2),
    std_dev_2_lower NUMERIC(10, 2),
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
    trigger_price NUMERIC(10, 2) NOT NULL,
    alert_type VARCHAR(20) NOT NULL,
    triggered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    email_sent BOOLEAN DEFAULT false,
    email_sent_at TIMESTAMP,
    sms_sent BOOLEAN DEFAULT false,
    sms_sent_at TIMESTAMP
);

-- Trade Journal table
CREATE TABLE IF NOT EXISTS trade_journal (
    id SERIAL PRIMARY KEY,
    trade_setup VARCHAR(100),
    trade_mistakes VARCHAR(100),
    trade_results VARCHAR(100),
    trade_rating VARCHAR(10),
    trade_r DOUBLE PRECISION,
    notes TEXT,
    image_path VARCHAR(100)
);

-- Legacy tables (keeping for compatibility)
CREATE TABLE IF NOT EXISTS alert_log (
    id SERIAL PRIMARY KEY,
    alert_id INTEGER NOT NULL,
    ticker VARCHAR(20) NOT NULL,
    alert_type VARCHAR(50) NOT NULL,
    trigger_price DOUBLE PRECISION NOT NULL,
    std_dev_level DOUBLE PRECISION NOT NULL,
    direction VARCHAR(10) NOT NULL,
    message TEXT NOT NULL,
    email_sent BOOLEAN NOT NULL,
    created_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS trade_alert (
    id SERIAL PRIMARY KEY,
    ticker VARCHAR(20) NOT NULL,
    alert_type VARCHAR(50) NOT NULL,
    timeframe VARCHAR(20) NOT NULL,
    direction VARCHAR(10) NOT NULL,
    is_active BOOLEAN NOT NULL,
    last_triggered TIMESTAMP,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS "order" (
    id SERIAL PRIMARY KEY,
    order_data JSON NOT NULL,
    order_id VARCHAR(256) NOT NULL,
    parent_order_id INTEGER
);

CREATE TABLE IF NOT EXISTS o_auth_credential (
    id SERIAL PRIMARY KEY,
    access_token VARCHAR(1500) NOT NULL,
    refresh_token VARCHAR(256) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_trade_alerts_user_id ON trade_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_trade_alerts_ticker ON trade_alerts(ticker);
CREATE INDEX IF NOT EXISTS idx_std_dev_levels_ticker_timeframe ON std_dev_levels(ticker, timeframe);
CREATE INDEX IF NOT EXISTS idx_alert_logs_alert_id ON alert_logs(alert_id);
CREATE INDEX IF NOT EXISTS idx_alert_logs_ticker ON alert_logs(ticker); 