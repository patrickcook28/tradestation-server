const express = require('express');
const router = express.Router();
const db = require('../db');

/**
 * Analytics tracking endpoint
 * Handles page views, custom events, and user interactions
 */
router.post('/track', async (req, res) => {
  try {
    const { event_type, data, user_agent, referrer, screen_resolution, viewport_size } = req.body;
    
    // Validate event_type is provided
    if (!event_type) {
      console.error('Analytics tracking error: event_type is missing', req.body);
      return res.status(400).json({ error: 'event_type is required' });
    }
    
    // Extract user info from token if available
    const token = req.headers.authorization?.replace('Bearer ', '');
    let userId = null;
    
    if (token) {
      try {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        userId = decoded.id;
      } catch (error) {
        // Token invalid, continue as anonymous
      }
    }
    
    // Debug logging disabled for production
    // console.log('Analytics tracking request:', { 
    //   event_type, 
    //   session_id: data?.session_id || data?.parameters?.session_id, 
    //   has_data: !!data,
    //   user_id_from_token: userId,
    //   user_id_from_data: data?.parameters?.user_id
    // });

    // Use user ID from token (most reliable), fallback to data payload
    const finalUserId = userId || data?.parameters?.user_id || null;

    // Prepare analytics record
    // Pass data object directly - PostgreSQL JSONB will handle conversion automatically
    const analyticsRecord = {
      event_type: event_type, // Ensure it's explicitly set and validated
      user_id: finalUserId,
      session_id: data?.session_id || data?.parameters?.session_id || 'unknown_session',
      event_data: data, // Pass object directly - PostgreSQL JSONB handles conversion
      user_agent,
      referrer,
      screen_resolution,
      viewport_size,
      ip_address: req.ip || req.connection.remoteAddress,
      created_at: new Date().toISOString()
    };

    // Log the event type being stored for debugging (disabled for production)
    // console.log('Storing analytics event:', { 
    //   event_type: analyticsRecord.event_type, 
    //   user_id: analyticsRecord.user_id,
    //   session_id: analyticsRecord.session_id 
    // });

    // Store in database
    const query = `
      INSERT INTO analytics_events 
      (event_type, user_id, session_id, event_data, user_agent, referrer, screen_resolution, viewport_size, ip_address, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `;
    
    const values = [
      analyticsRecord.event_type,
      analyticsRecord.user_id,
      analyticsRecord.session_id,
      analyticsRecord.event_data,
      analyticsRecord.user_agent,
      analyticsRecord.referrer,
      analyticsRecord.screen_resolution,
      analyticsRecord.viewport_size,
      analyticsRecord.ip_address,
      analyticsRecord.created_at
    ];

    await db.query(query, values);

    res.json({ success: true });
  } catch (error) {
    console.error('Analytics tracking error:', error);
    res.status(500).json({ error: 'Failed to track analytics event' });
  }
});

/**
 * Get analytics dashboard data
 */
router.get('/dashboard', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Check if user is admin/superuser
    const userQuery = 'SELECT superuser FROM users WHERE id = $1';
    const userResult = await db.query(userQuery, [decoded.id]);
    
    if (!userResult.rows[0]?.superuser) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { period = '7d', event_type } = req.query;
    
    // Calculate date range
    const now = new Date();
    let startDate;
    switch (period) {
      case '1d':
        startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case '7d':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }

    // Get page views
    const pageViewsQuery = `
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as page_views,
        COUNT(DISTINCT session_id) as unique_sessions,
        COUNT(DISTINCT user_id) as unique_users
      FROM analytics_events 
      WHERE event_type = 'page_view' 
        AND created_at >= $1
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `;
    
    const pageViewsResult = await db.query(pageViewsQuery, [startDate]);

    // Get top pages
    const topPagesQuery = `
      SELECT 
        (event_data::json->>'page_path') as page_path,
        COUNT(*) as views
      FROM analytics_events 
      WHERE event_type = 'page_view' 
        AND created_at >= $1
      GROUP BY (event_data::json->>'page_path')
      ORDER BY views DESC
      LIMIT 10
    `;
    
    const topPagesResult = await db.query(topPagesQuery, [startDate]);

    // Get user engagement events
    const engagementQuery = `
      SELECT 
        event_type,
        COUNT(*) as count
      FROM analytics_events 
      WHERE event_type IN ('trial_started', 'subscription_upgraded', 'order_placed', 'journal_entry_created')
        AND created_at >= $1
      GROUP BY event_type
      ORDER BY count DESC
    `;
    
    const engagementResult = await db.query(engagementQuery, [startDate]);

    // Get user journey data
    const journeyQuery = `
      SELECT 
        (event_data::json->>'journey_step') as journey_step,
        COUNT(*) as count
      FROM analytics_events 
      WHERE event_type = 'user_journey' 
        AND created_at >= $1
      GROUP BY (event_data::json->>'journey_step')
      ORDER BY count DESC
    `;
    
    const journeyResult = await db.query(journeyQuery, [startDate]);

    // Get conversion funnel
    const funnelQuery = `
      SELECT 
        CASE 
          WHEN event_type = 'trial_started' THEN 'Trial Started'
          WHEN event_type = 'subscription_upgraded' THEN 'Subscription Upgraded'
          WHEN event_type = 'order_placed' THEN 'First Trade'
          WHEN event_type = 'journal_entry_created' THEN 'First Journal Entry'
        END as funnel_step,
        COUNT(DISTINCT user_id) as unique_users
      FROM analytics_events 
      WHERE event_type IN ('trial_started', 'subscription_upgraded', 'order_placed', 'journal_entry_created')
        AND created_at >= $1
        AND user_id IS NOT NULL
      GROUP BY event_type
      ORDER BY 
        CASE event_type
          WHEN 'trial_started' THEN 1
          WHEN 'order_placed' THEN 2
          WHEN 'journal_entry_created' THEN 3
          WHEN 'subscription_upgraded' THEN 4
        END
    `;
    
    const funnelResult = await db.query(funnelQuery, [startDate]);

    res.json({
      period,
      dateRange: {
        start: startDate.toISOString(),
        end: now.toISOString()
      },
      pageViews: pageViewsResult.rows,
      topPages: topPagesResult.rows,
      engagement: engagementResult.rows,
      userJourney: journeyResult.rows,
      conversionFunnel: funnelResult.rows
    });

  } catch (error) {
    console.error('Analytics dashboard error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics data' });
  }
});

/**
 * Get real-time analytics
 */
router.get('/realtime', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Check if user is admin/superuser
    const userQuery = 'SELECT superuser FROM users WHERE id = $1';
    const userResult = await db.query(userQuery, [decoded.id]);
    
    if (!userResult.rows[0]?.superuser) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Get active users in last 5 minutes
    const activeUsersQuery = `
      SELECT 
        COUNT(DISTINCT session_id) as active_sessions,
        COUNT(DISTINCT user_id) as active_users
      FROM analytics_events 
      WHERE created_at >= NOW() - INTERVAL '5 minutes'
    `;
    
    const activeUsersResult = await db.query(activeUsersQuery);

    // Get recent events
    const recentEventsQuery = `
      SELECT 
        event_type,
        (event_data::json->>'page_path') as page_path,
        created_at
      FROM analytics_events 
      WHERE created_at >= NOW() - INTERVAL '10 minutes'
      ORDER BY created_at DESC
      LIMIT 20
    `;
    
    const recentEventsResult = await db.query(recentEventsQuery);

    res.json({
      activeUsers: activeUsersResult.rows[0],
      recentEvents: recentEventsResult.rows
    });

  } catch (error) {
    console.error('Real-time analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch real-time analytics' });
  }
});

/**
 * Get session activities for admin area
 */
router.get('/session-activities', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Check if user is admin/superuser
    const userQuery = 'SELECT superuser FROM users WHERE id = $1';
    const userResult = await db.query(userQuery, [decoded.id]);
    
    if (!userResult.rows[0]?.superuser) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { limit = 100, offset = 0, event_type, user_id, user_type } = req.query;
    
    // Build query with optional filters
    let whereClause = 'WHERE 1=1';
    const queryParams = [];
    let paramCount = 0;

    if (event_type) {
      paramCount++;
      whereClause += ` AND event_type = $${paramCount}`;
      queryParams.push(event_type);
    }

    if (user_id) {
      paramCount++;
      whereClause += ` AND user_id = $${paramCount}`;
      queryParams.push(user_id);
    }

    // Filter by user type: 'logged_in' or 'anonymous'
    if (user_type === 'logged_in') {
      whereClause += ` AND user_id IS NOT NULL`;
    } else if (user_type === 'anonymous') {
      whereClause += ` AND user_id IS NULL`;
    }

    // Get session activities with user info and UTM source
    const activitiesQuery = `
      SELECT 
        ae.id,
        ae.event_type,
        ae.user_id,
        ae.session_id,
        ae.event_data,
        ae.user_agent,
        ae.ip_address,
        ae.created_at,
        u.email,
        ae.event_data->'utm_params'->>'utm_source' as utm_source,
        ae.event_data->'utm_params'->>'utm_medium' as utm_medium,
        ae.event_data->'utm_params'->>'utm_campaign' as utm_campaign
      FROM analytics_events ae
      LEFT JOIN users u ON ae.user_id = u.id
      ${whereClause}
      ORDER BY ae.created_at DESC
      LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
    `;
    
    queryParams.push(parseInt(limit), parseInt(offset));
    const activitiesResult = await db.query(activitiesQuery, queryParams);

    // Get total count for pagination
    const countQuery = `
      SELECT COUNT(*) as total
      FROM analytics_events ae
      ${whereClause}
    `;
    const countResult = await db.query(countQuery, queryParams.slice(0, -2));

    // Get event type summary
    const summaryQuery = `
      SELECT 
        event_type,
        COUNT(*) as count,
        COUNT(DISTINCT session_id) as unique_sessions,
        COUNT(DISTINCT user_id) as unique_users
      FROM analytics_events
      WHERE created_at >= NOW() - INTERVAL '24 hours'
      GROUP BY event_type
      ORDER BY count DESC
    `;
    const summaryResult = await db.query(summaryQuery);

    res.json({
      activities: activitiesResult.rows,
      total: parseInt(countResult.rows[0].total),
      summary: summaryResult.rows,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: (parseInt(offset) + parseInt(limit)) < parseInt(countResult.rows[0].total)
      }
    });

  } catch (error) {
    console.error('Session activities error:', error);
    res.status(500).json({ error: 'Failed to fetch session activities' });
  }
});

// DELETE /events/user/:userId - Delete all analytics events for a specific user (superuser only)
router.delete('/events/user/:userId', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Check if user is admin/superuser
    const userQuery = 'SELECT superuser FROM users WHERE id = $1';
    const userResult = await db.query(userQuery, [decoded.id]);
    
    if (!userResult.rows[0]?.superuser) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { userId } = req.params;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Delete all analytics events for the specified user
    const deleteResult = await db.query(
      'DELETE FROM analytics_events WHERE user_id = $1',
      [userId]
    );

    res.json({ 
      success: true, 
      message: `Deleted ${deleteResult.rowCount} analytics events for user ${userId}`,
      deletedCount: deleteResult.rowCount
    });

  } catch (error) {
    console.error('Delete analytics events error:', error);
    res.status(500).json({ error: 'Failed to delete analytics events' });
  }
});

module.exports = router;
