const jwt = require("jsonwebtoken")
const fetch = require('node-fetch');
const pool = require("../db");
const {json} = require("express");
const { getCommonFuturesContracts, getContractSeries } = require('../utils/contractSymbols');

const handleOAuthCallback = async (req, res) => {
  const code = req.query.code;
  const token = req.query.state;

  if (!code) {
    return res.status(400).json({ error: 'No authorization code received' });
  }

  if (!token) {
    return res.status(400).json({ error: 'No state token received' });
  }

  // Verify JWT token
  try {
    const user = jwt.verify(token, process.env.JWT_SECRET);
    req.user = user;
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }

  // Use the authorization code to request an access token
  const token_url = 'https://signin.tradestation.com/oauth/token';
  const data = {
    'grant_type': 'authorization_code',
    'client_id': process.env.TRADESTATION_CLIENT_ID,
    'client_secret': process.env.TRADESTATION_CLIENT_SECRET,
    'code': code,
    'redirect_uri': process.env.TRADESTATION_REDIRECT_URI
  };

  try {
    const response = await fetch(token_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });

    if (response.ok) {
      const json_response = await response.json();
      
      const access_token = json_response['access_token'];
      const refresh_token = json_response['refresh_token'];
      const expires_at = new Date(Date.now() + 1200 * 1000).toISOString();

      if (!access_token || !refresh_token) {
        return res.status(500).json({ error: 'Invalid response from TradeStation' });
      }

      // Save credentials to database
      try {
        const result = await pool.query('SELECT * FROM api_credentials WHERE user_id = $1', [req.user.id]);
        
        if (result.rows.length > 0) {
          await pool.query(
            'UPDATE api_credentials SET access_token = $1, refresh_token = $2, expires_at = $3 WHERE user_id = $4',
            [access_token, refresh_token, expires_at, req.user.id]
          );
        } else {
          await pool.query(
            'INSERT INTO api_credentials (user_id, access_token, refresh_token, expires_at) VALUES ($1, $2, $3, $4)',
            [req.user.id, access_token, refresh_token, expires_at]
          );
        }

        const redirectUrl = `${process.env.FRONTEND_URL}/connected?access_token=${access_token}&refresh_token=${refresh_token}`;
        res.redirect(redirectUrl);
      } catch (dbError) {
        res.status(500).json({ error: 'Failed to save credentials' });
      }
    } else {
      const errorResponse = await response.json();
      res.status(response.status).json({ 
        error: errorResponse, 
        message: 'could not get access token',
        status: response.status
      });
    }
  } catch (error) {
    res.status(500).json({ 
      error: error.message, 
      message: 'could not get access token' 
    });
  }
}

const refreshAccessToken = async (req, res) => {
  pool.query('SELECT * FROM api_credentials WHERE user_id = $1', [req.user.id], async (error, result) => {
    if(error){
      return res.status(400).json({ error: 'DB Connection Failed' })
    } else if( result.rows.length > 0 ) {
      const oauthCredentials = result.rows[0]
      // Use the refresh token to request a new access token
      const token_url = 'https://signin.tradestation.com/oauth/token';
      const data = {
        'grant_type': 'refresh_token',
        'client_id': process.env.TRADESTATION_CLIENT_ID,
        'client_secret': process.env.TRADESTATION_CLIENT_SECRET,
        'refresh_token': oauthCredentials.refresh_token
      };

      try {
        const response = await fetch(token_url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(data)
        });

        if (response.ok) {
          const json_response = await response.json();
          const access_token = json_response['access_token'];
          const expires_at = new Date(Date.now() + 1200 * 1000).toISOString();

          // Update the access token and expiration time in the database
          oauthCredentials.access_token = access_token;
          oauthCredentials.expires_at = expires_at;

          // SAVE TO DB
          const query = 'UPDATE api_credentials SET access_token = $1, expires_at = $2 WHERE user_id = $3';
          const values = [access_token, expires_at, req.user.id];
          await pool.query(query, values);

          res.json(oauthCredentials);
        } else {
          res.status(400).json({ 'error': 'Attempt to refresh token failed due to Tradestation response' });
        }
      } catch (error) {
        console.error(error);
        res.status(400).json({ 'error': 'could not refresh token' });
      }
    } else {
      return res.status(400).json({ error: 'User not found' })
    }
  })
}

// Get stored API credentials for the authenticated user
const getStoredCredentials = async (req, res) => {
  try {
    pool.query('SELECT access_token, refresh_token, expires_at FROM api_credentials WHERE user_id = $1', [req.user.id], async (error, result) => {
      if(error){
        return res.status(400).json({ error: 'DB Connection Failed' })
      } else if( result.rows.length > 0 ) {
        const credentials = result.rows[0];
        
        res.json({
          access_token: credentials.access_token,
          refresh_token: credentials.refresh_token,
          expires_at: credentials.expires_at
        });
      } else {
        res.status(404).json({ error: 'No credentials found' });
      }
    });
  } catch (error) {
    console.error('Error getting stored credentials:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to retrieve stored credentials' 
    });
  }
};

// Get ticker options for the UI
const getTickerOptions = async (req, res) => {
  try {
    const { search = '' } = req.query;
    
    // Get common futures with current contracts
    const futuresContracts = getCommonFuturesContracts();
    
    // Add some common stock symbols
    const commonStocks = [
      { symbol: 'AAPL', name: 'Apple Inc.' },
      { symbol: 'MSFT', name: 'Microsoft Corporation' },
      { symbol: 'GOOGL', name: 'Alphabet Inc.' },
      { symbol: 'AMZN', name: 'Amazon.com Inc.' },
      { symbol: 'TSLA', name: 'Tesla Inc.' },
      { symbol: 'NVDA', name: 'NVIDIA Corporation' },
      { symbol: 'META', name: 'Meta Platforms Inc.' },
      { symbol: 'SPY', name: 'SPDR S&P 500 ETF' },
      { symbol: 'QQQ', name: 'Invesco QQQ Trust' },
      { symbol: 'IWM', name: 'iShares Russell 2000 ETF' }
    ];
    
    // Combine all suggestions
    const allSuggestions = [
      ...futuresContracts.map(f => ({
        value: f.currentContract,
        label: `${f.currentContract} - ${f.name}`,
        type: 'futures'
      })),
      ...commonStocks.map(s => ({
        value: s.symbol,
        label: `${s.symbol} - ${s.name}`,
        type: 'stock'
      }))
    ];
    
    // Filter by search term if provided
    let filteredSuggestions = allSuggestions;
    if (search) {
      const searchLower = search.toLowerCase();
      filteredSuggestions = allSuggestions.filter(suggestion => 
        suggestion.value.toLowerCase().includes(searchLower) ||
        suggestion.label.toLowerCase().includes(searchLower)
      );
    }
    
    // Limit results
    filteredSuggestions = filteredSuggestions.slice(0, 20);
    
    res.json({
      success: true,
      suggestions: filteredSuggestions
    });
    
  } catch (error) {
    console.error('Error getting ticker options:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get ticker options'
    });
  }
};

// Get available contracts for a ticker (e.g., MNQZ24, MNQH25, etc.)
const getTickerContracts = async (req, res) => {
  try {
    const { ticker } = req.params;
    const { count = 4 } = req.query;
    
    // Extract the base product (e.g., 'MNQ' from 'MNQZ24')
    const baseProduct = ticker.replace(/[A-Z]\d{2}$/, '').toUpperCase();
    
    const contracts = getContractSeries(baseProduct, parseInt(count));
    
    res.json({
      success: true,
      contracts: contracts.map(contract => ({
        value: contract,
        label: contract
      }))
    });
    
  } catch (error) {
    console.error('Error getting ticker contracts:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get ticker contracts'
    });
  }
};

// Reusable function to refresh access token for a user
const refreshAccessTokenForUser = async (userId) => {
  // Get credentials from DB
  const result = await pool.query('SELECT * FROM api_credentials WHERE user_id = $1', [userId]);
  if (result.rows.length === 0) {
    throw new Error('User not found');
  }
  const oauthCredentials = result.rows[0];
  const token_url = 'https://signin.tradestation.com/oauth/token';
  const data = {
    'grant_type': 'refresh_token',
    'client_id': process.env.TRADESTATION_CLIENT_ID,
    'client_secret': process.env.TRADESTATION_CLIENT_SECRET,
    'refresh_token': oauthCredentials.refresh_token
  };
  const response = await fetch(token_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!response.ok) {
    throw new Error('Attempt to refresh token failed due to Tradestation response');
  }
  const json_response = await response.json();
  const access_token = json_response['access_token'];
  const expires_at = new Date(Date.now() + 1200 * 1000).toISOString();
  // Update the access token and expiration time in the database
  await pool.query('UPDATE api_credentials SET access_token = $1, expires_at = $2 WHERE user_id = $3', [access_token, expires_at, userId]);
  return { access_token, expires_at };
};

module.exports = {
  handleOAuthCallback,
  refreshAccessToken,
  getStoredCredentials,
  getTickerOptions,
  getTickerContracts,
  refreshAccessTokenForUser,
}