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
    // Handle both header token (normal requests) and auth_token in payload (beacon requests)
    let token = req.headers.authorization?.replace('Bearer ', '');
    if (!token && req.body.auth_token) {
      token = req.body.auth_token; // Handle sendBeacon requests that can't send headers
    }
    
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
    const finalUserId = userId || data?.user_id || data?.parameters?.user_id || null;

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
      ip_address: req.ip || req.connection.remoteAddress
    };

    // Log the event type being stored for debugging (disabled for production)
    // console.log('Storing analytics event:', { 
    //   event_type: analyticsRecord.event_type, 
    //   user_id: analyticsRecord.user_id,
    //   session_id: analyticsRecord.session_id 
    // });

    // Store in database
    // For page_visit events, use UPSERT to update existing records instead of creating duplicates
    // This consolidates page visits into a single record that gets updated with time_spent and scroll_percent
    if (event_type === 'page_visit') {
      const pagePath = data?.page_path || data?.parameters?.page_path;
      if (!pagePath) {
        return res.status(400).json({ error: 'page_path is required for page_visit events' });
      }

      // Use UPSERT (ON CONFLICT) to update existing page_visit record or create new one
      // Accumulate time_spent across multiple visits (SUM), keep max scroll_percent
      // Logic: 
      //   - time_spent = accumulated total across all visits
      //   - current_visit_time = time for the current visit
      //   - When time resets to 0, add current_visit_time to accumulated total
      const upsertQuery = `
        INSERT INTO analytics_events 
        (event_type, user_id, session_id, event_data, user_agent, referrer, screen_resolution, viewport_size, ip_address, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        ON CONFLICT (session_id, (event_data->>'page_path')) 
        WHERE event_type = 'page_visit'
        DO UPDATE SET
          event_data = (
            analytics_events.event_data || $4::jsonb
          ) || jsonb_build_object(
            'scroll_percent', GREATEST(
              COALESCE((analytics_events.event_data->>'scroll_percent')::int, 0),
              COALESCE(($4::jsonb->>'scroll_percent')::int, 0)
            ),
            'time_spent',
            CASE 
              -- New visit detected: incoming time_spent (0) < current_visit_time (e.g., 30)
              -- Add the previous visit's time to accumulated total, start new visit
              WHEN COALESCE(($4::jsonb->>'time_spent')::int, 0) < COALESCE((analytics_events.event_data->>'current_visit_time')::int, 0)
              THEN to_jsonb(
                COALESCE((analytics_events.event_data->>'time_spent')::int, 0) + 
                COALESCE((analytics_events.event_data->>'current_visit_time')::int, 0)
              )
              -- Same visit: time_spent is increasing (0→5→10→15)
              -- Update accumulated total with new current visit time
              ELSE to_jsonb(
                COALESCE((analytics_events.event_data->>'time_spent')::int, 0) - 
                COALESCE((analytics_events.event_data->>'current_visit_time')::int, 0) + 
                COALESCE(($4::jsonb->>'time_spent')::int, 0)
              )
            END,
            'current_visit_time', COALESCE(($4::jsonb->>'time_spent')::int, 0)
          ),
          user_id = COALESCE(EXCLUDED.user_id, analytics_events.user_id),
          updated_at = COALESCE(analytics_events.updated_at, NOW(), NOW())
        RETURNING id;
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
        analyticsRecord.ip_address
      ];

      await db.query(upsertQuery, values);
    } else {
      // For other event types, use regular INSERT
      const query = `
        INSERT INTO analytics_events 
        (event_type, user_id, session_id, event_data, user_agent, referrer, screen_resolution, viewport_size, ip_address, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
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
        analyticsRecord.ip_address
      ];

      await db.query(query, values);
    }

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

    const { 
      limit = 100, 
      offset = 0, 
      event_type, 
      user_id, 
      user_type,
      period, // Optional: '1d', '7d', '30d', '90d'
      source // Optional: UTM source or custom source
    } = req.query;
    
    // Calculate date range if period is provided
    let startDate = null;
    if (period) {
      const now = new Date();
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
        case '90d':
          startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
          break;
      }
    }
    
    // Exclude test accounts if requested
    const excludeTestAccounts = req.query.exclude_test_accounts === 'true';
    
    // Build query with optional filters
    let whereClause = 'WHERE 1=1';
    const queryParams = [];
    let paramCount = 0;

    // Apply date range filter if period is provided
    if (startDate) {
      paramCount++;
      whereClause += ` AND ae.created_at >= $${paramCount}`;
      queryParams.push(startDate);
    }

    // Exclude test accounts
    if (excludeTestAccounts) {
      const testAccounts = ['patrickcook28@icloud.com', 'pcookcollege@gmail.com', 'avery.ward.123@gmail.com', 'jacobdpark75@gmail.com'];
      whereClause += ` AND (ae.user_id IS NULL OR u.email NOT IN (${testAccounts.map(account => `'${account}'`).join(',')}))`;
    }

    if (event_type) {
      paramCount++;
      whereClause += ` AND ae.event_type = $${paramCount}`;
      queryParams.push(event_type);
    }

    if (user_id) {
      paramCount++;
      whereClause += ` AND ae.user_id = $${paramCount}`;
      queryParams.push(user_id);
    }

    // Filter by user type: 'logged_in' or 'anonymous'
    if (user_type === 'logged_in') {
      whereClause += ` AND ae.user_id IS NOT NULL`;
    } else if (user_type === 'anonymous') {
      whereClause += ` AND ae.user_id IS NULL`;
    }
    
    // Filter by source (UTM source or custom source)
    if (source) {
      paramCount++;
      whereClause += ` AND (
        COALESCE(
          ae.event_data->'parameters'->'registration_source'->>'utm_source',
          ae.event_data->'parameters'->'source'->>'utm_source',
          ae.event_data->'registration_source'->>'utm_source',
          ae.event_data->'source'->>'utm_source',
          ae.event_data->'utm_params'->>'utm_source',
          ae.event_data->'parameters'->'registration_source'->>'source',
          ae.event_data->'parameters'->'source'->>'source',
          ae.event_data->'registration_source'->>'source',
          ae.event_data->'source'->>'source'
        ) = $${paramCount}
      )`;
      queryParams.push(source);
    }

    // Get session activities with user info and UTM source
    // Check registration_source and source fields in both top-level and parameters nested structure
    // Priority: parameters.registration_source > parameters.source > top-level registration_source > top-level source > utm_params
    // Consolidate page_view and page_time into a single display format
    const activitiesQuery = `
      SELECT 
        ae.id,
        ae.event_type,
        CASE 
          WHEN ae.event_type = 'page_visit' THEN 
            'Page: ' || COALESCE(
              ae.event_data->>'page_name',
              ae.event_data->'parameters'->>'page_name',
              COALESCE(
                ae.event_data->>'page_path',
                ae.event_data->'parameters'->>'page_path',
                'Unknown'
              )
            ) || 
            CASE 
              WHEN (COALESCE(ae.event_data->>'time_spent', ae.event_data->'parameters'->>'time_spent', '0'))::int > 0 
              THEN ' Duration: ' || COALESCE(
                ae.event_data->>'time_spent',
                ae.event_data->'parameters'->>'time_spent',
                '0'
              ) || 's'
              ELSE ''
            END ||
            CASE 
              WHEN (COALESCE(ae.event_data->>'scroll_percent', ae.event_data->'parameters'->>'scroll_percent', '0'))::int > 0 
              THEN ' Scroll: ' || COALESCE(
                ae.event_data->>'scroll_percent',
                ae.event_data->'parameters'->>'scroll_percent',
                '0'
              ) || '%'
              ELSE ''
            END
          WHEN ae.event_type = 'page_view' THEN 
            'Page: ' || COALESCE(
              ae.event_data->>'page_name',
              ae.event_data->'parameters'->>'page_name',
              'Unknown'
            )
          ELSE ae.event_type
        END as display_name,
        ae.user_id,
        ae.user_agent,
        ae.ip_address,
        to_char(ae.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at,
        u.email,
        COALESCE(
          ae.event_data->'parameters'->'registration_source'->>'utm_source',
          ae.event_data->'parameters'->'source'->>'utm_source',
          ae.event_data->'registration_source'->>'utm_source',
          ae.event_data->'source'->>'utm_source',
          ae.event_data->'utm_params'->>'utm_source'
        ) as utm_source,
        COALESCE(
          ae.event_data->'parameters'->'registration_source'->>'utm_medium',
          ae.event_data->'parameters'->'source'->>'utm_medium',
          ae.event_data->'registration_source'->>'utm_medium',
          ae.event_data->'source'->>'utm_medium',
          ae.event_data->'utm_params'->>'utm_medium'
        ) as utm_medium,
        COALESCE(
          ae.event_data->'parameters'->'registration_source'->>'utm_campaign',
          ae.event_data->'parameters'->'source'->>'utm_campaign',
          ae.event_data->'registration_source'->>'utm_campaign',
          ae.event_data->'source'->>'utm_campaign',
          ae.event_data->'utm_params'->>'utm_campaign'
        ) as utm_campaign,
        COALESCE(
          ae.event_data->'parameters'->'registration_source'->>'source',
          ae.event_data->'parameters'->'source'->>'source',
          ae.event_data->'registration_source'->>'source',
          ae.event_data->'source'->>'source'
        ) as custom_source
      FROM analytics_events ae
      LEFT JOIN users u ON ae.user_id = u.id
      ${whereClause}
      -- Filter out old event types that are now consolidated into page_visit
      AND ae.event_type NOT IN ('page_time', 'session_duration', 'scroll_depth')
      -- Only show page_visit events that have been updated (have time_spent > 0)
      -- This filters out initial page loads that haven't been updated yet
      AND (
        ae.event_type != 'page_visit' 
        OR COALESCE(ae.event_data->>'time_spent', ae.event_data->'parameters'->>'time_spent', '0')::int > 0
      )
      ORDER BY ae.created_at DESC
      LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
    `;
    
    queryParams.push(parseInt(limit), parseInt(offset));
    const activitiesResult = await db.query(activitiesQuery, queryParams);

    // Get total count for pagination (use same filters but without limit/offset)
    const countQuery = `
      SELECT COUNT(*) as total
      FROM analytics_events ae
      LEFT JOIN users u ON ae.user_id = u.id
      ${whereClause}
    `;
    // Remove limit and offset from params for count query
    const countQueryParams = queryParams.slice(0, -2);
    const countResult = await db.query(countQuery, countQueryParams);

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

/**
 * Get time-series analytics data for charts
 * Returns hourly aggregations of events over time
 */
router.get('/time-series', async (req, res) => {
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

    const { 
      period = '7d', 
      event_type, 
      source, // UTM source or custom source
      granularity = 'hour' // 'hour' or 'day'
    } = req.query;
    
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
      case '90d':
        startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }

    // Build WHERE clause - use table alias 'ae' consistently
    let whereClause = 'WHERE ae.created_at >= $1';
    const queryParams = [startDate];
    let paramCount = 1;

    // Exclude test accounts if requested
    const excludeTestAccounts = req.query.exclude_test_accounts === 'true';
    if (excludeTestAccounts) {
      whereClause += ` AND (ae.user_id IS NULL OR u.email NOT IN ('patrickcook28@icloud.com', 'pcookcollege@gmail.com'))`;
    }

    if (event_type) {
      paramCount++;
      whereClause += ` AND ae.event_type = $${paramCount}`;
      queryParams.push(event_type);
    }

    // Filter by source (UTM source or custom source)
    if (source) {
      paramCount++;
      whereClause += ` AND (
        COALESCE(
          ae.event_data->'parameters'->'registration_source'->>'utm_source',
          ae.event_data->'parameters'->'source'->>'utm_source',
          ae.event_data->'registration_source'->>'utm_source',
          ae.event_data->'source'->>'utm_source',
          ae.event_data->'utm_params'->>'utm_source',
          ae.event_data->'parameters'->'registration_source'->>'source',
          ae.event_data->'parameters'->'source'->>'source',
          ae.event_data->'registration_source'->>'source',
          ae.event_data->'source'->>'source'
        ) = $${paramCount}
      )`;
      queryParams.push(source);
    }

    // Determine time grouping based on granularity
    // Use table alias 'ae' consistently
    let timeGroupExpr;
    let timeFormat;
    if (granularity === 'day') {
      timeGroupExpr = "DATE_TRUNC('day', ae.created_at)";
      timeFormat = "TO_CHAR(DATE_TRUNC('day', ae.created_at), 'YYYY-MM-DD')";
    } else {
      // Default to hour
      timeGroupExpr = "DATE_TRUNC('hour', ae.created_at)";
      timeFormat = "TO_CHAR(DATE_TRUNC('hour', ae.created_at), 'YYYY-MM-DD HH24:MI:SS')";
    }

    // Get time-series data grouped by event type
    // Need to join with users table to filter by email
    const timeSeriesQuery = `
      SELECT 
        ${timeGroupExpr} as time_bucket,
        ae.event_type,
        COUNT(*) as count,
        COUNT(DISTINCT ae.session_id) as unique_sessions,
        COUNT(DISTINCT ae.user_id) as unique_users
      FROM analytics_events ae
      LEFT JOIN users u ON ae.user_id = u.id
      ${whereClause}
      GROUP BY ${timeGroupExpr}, ae.event_type
      ORDER BY time_bucket ASC, ae.event_type ASC
    `;
    
    const timeSeriesResult = await db.query(timeSeriesQuery, queryParams);

    // Generate all time buckets in the range
    // Use UTC consistently to match PostgreSQL DATE_TRUNC results
    const allTimeBuckets = [];
    const bucketSize = granularity === 'day' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000; // 1 day or 1 hour in milliseconds
    let currentTime = new Date(startDate);
    
    // Round to start of hour/day in UTC to match PostgreSQL DATE_TRUNC
    if (granularity === 'day') {
      // Set to start of day in UTC
      currentTime = new Date(Date.UTC(
        currentTime.getUTCFullYear(),
        currentTime.getUTCMonth(),
        currentTime.getUTCDate(),
        0, 0, 0, 0
      ));
    } else {
      // Set to start of hour in UTC
      currentTime = new Date(Date.UTC(
        currentTime.getUTCFullYear(),
        currentTime.getUTCMonth(),
        currentTime.getUTCDate(),
        currentTime.getUTCHours(),
        0, 0, 0
      ));
    }
    
    // Normalize endTime to match granularity (start of current hour/day in UTC)
    let endTime = new Date(now);
    if (granularity === 'day') {
      endTime = new Date(Date.UTC(
        endTime.getUTCFullYear(),
        endTime.getUTCMonth(),
        endTime.getUTCDate(),
        0, 0, 0, 0
      ));
    } else {
      endTime = new Date(Date.UTC(
        endTime.getUTCFullYear(),
        endTime.getUTCMonth(),
        endTime.getUTCDate(),
        endTime.getUTCHours(),
        0, 0, 0
      ));
    }
    
    while (currentTime <= endTime) {
      allTimeBuckets.push(new Date(currentTime));
      currentTime = new Date(currentTime.getTime() + bucketSize);
    }

    // Create a map of existing data: time_bucket -> event_type -> data
    // Normalize database timestamps to UTC start of day/hour for matching
    const dataMap = new Map();
    timeSeriesResult.rows.forEach(row => {
      const dbTime = new Date(row.time_bucket);
      // Normalize to UTC start of day/hour to match our bucket generation
      let normalizedTime;
      if (granularity === 'day') {
        normalizedTime = new Date(Date.UTC(
          dbTime.getUTCFullYear(),
          dbTime.getUTCMonth(),
          dbTime.getUTCDate(),
          0, 0, 0, 0
        ));
      } else {
        normalizedTime = new Date(Date.UTC(
          dbTime.getUTCFullYear(),
          dbTime.getUTCMonth(),
          dbTime.getUTCDate(),
          dbTime.getUTCHours(),
          0, 0, 0
        ));
      }
      const bucketTime = normalizedTime.getTime();
      if (!dataMap.has(bucketTime)) {
        dataMap.set(bucketTime, new Map());
      }
      dataMap.get(bucketTime).set(row.event_type, {
        count: parseInt(row.count),
        unique_sessions: parseInt(row.unique_sessions),
        unique_users: parseInt(row.unique_users),
      });
    });

    // Get all unique event types from the data
    const eventTypes = new Set();
    timeSeriesResult.rows.forEach(row => {
      eventTypes.add(row.event_type);
    });

    // Transform to chart-friendly format, filling in missing time buckets with 0
    const seriesMap = {};
    eventTypes.forEach(eventType => {
      seriesMap[eventType] = [];
      
      allTimeBuckets.forEach(bucket => {
        const bucketTime = bucket.getTime();
        const bucketData = dataMap.get(bucketTime);
        const eventData = bucketData?.get(eventType);
        
        // Convert timestamp to Unix seconds
        const timestamp = bucketTime / 1000;
        
        seriesMap[eventType].push({
          time: timestamp,
          value: eventData ? eventData.count : 0,
          unique_sessions: eventData ? eventData.unique_sessions : 0,
          unique_users: eventData ? eventData.unique_users : 0,
        });
      });
    });

    // Get unique sources for filtering - respect all filters
    // Build sources query params to match main query filters
    const sourcesQueryParams = [startDate];
    let sourcesParamCount = 1;
    let sourcesWhereClause = 'WHERE ae.created_at >= $1';
    
    // Apply same filters as main query
    const sourcesJoin = excludeTestAccounts ? 'LEFT JOIN users u ON ae.user_id = u.id' : '';
    
    if (excludeTestAccounts) {
      const testAccounts = ['patrickcook28@icloud.com', 'pcookcollege@gmail.com', 'avery.ward.123@gmail.com', 'jacobdpark75@gmail.com'];
      sourcesWhereClause += ` AND (ae.user_id IS NULL OR u.email NOT IN (${testAccounts.map(account => `'${account}'`).join(',')}))`;
    }
    
    if (event_type) {
      sourcesParamCount++;
      sourcesWhereClause += ` AND ae.event_type = $${sourcesParamCount}`;
      sourcesQueryParams.push(event_type);
    }
    
    if (source) {
      sourcesParamCount++;
      sourcesWhereClause += ` AND (
        COALESCE(
          ae.event_data->'parameters'->'registration_source'->>'utm_source',
          ae.event_data->'parameters'->'source'->>'utm_source',
          ae.event_data->'registration_source'->>'utm_source',
          ae.event_data->'source'->>'utm_source',
          ae.event_data->'utm_params'->>'utm_source',
          ae.event_data->'parameters'->'registration_source'->>'source',
          ae.event_data->'parameters'->'source'->>'source',
          ae.event_data->'registration_source'->>'source',
          ae.event_data->'source'->>'source'
        ) = $${sourcesParamCount}
      )`;
      sourcesQueryParams.push(source);
    }
    
    const sourcesQuery = `
      SELECT DISTINCT
        COALESCE(
          ae.event_data->'parameters'->'registration_source'->>'utm_source',
          ae.event_data->'parameters'->'source'->>'utm_source',
          ae.event_data->'registration_source'->>'utm_source',
          ae.event_data->'source'->>'utm_source',
          ae.event_data->'utm_params'->>'utm_source',
          ae.event_data->'parameters'->'registration_source'->>'source',
          ae.event_data->'parameters'->'source'->>'source',
          ae.event_data->'registration_source'->>'source',
          ae.event_data->'source'->>'source'
        ) as source
      FROM analytics_events ae
      ${sourcesJoin}
      ${sourcesWhereClause}
        AND (
          ae.event_data->'parameters'->'registration_source'->>'utm_source' IS NOT NULL OR
          ae.event_data->'parameters'->'source'->>'utm_source' IS NOT NULL OR
          ae.event_data->'registration_source'->>'utm_source' IS NOT NULL OR
          ae.event_data->'source'->>'utm_source' IS NOT NULL OR
          ae.event_data->'utm_params'->>'utm_source' IS NOT NULL OR
          ae.event_data->'parameters'->'registration_source'->>'source' IS NOT NULL OR
          ae.event_data->'parameters'->'source'->>'source' IS NOT NULL OR
          ae.event_data->'registration_source'->>'source' IS NOT NULL OR
          ae.event_data->'source'->>'source' IS NOT NULL
        )
      ORDER BY source
    `;
    
    const sourcesResult = await db.query(sourcesQuery, sourcesQueryParams);

    res.json({
      period,
      granularity,
      dateRange: {
        start: startDate.toISOString(),
        end: now.toISOString()
      },
      series: seriesMap,
      availableSources: sourcesResult.rows.map(r => r.source).filter(Boolean),
    });

  } catch (error) {
    console.error('Time-series analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch time-series analytics' });
  }
});

/**
 * Get available filter values (event types and sources)
 * Respects optional filters to show only relevant values
 */
router.get('/filters', async (req, res) => {
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

    const { 
      period = '7d',
      event_type, // Optional: if provided, only show sources for this event type
      source // Optional: if provided, only show event types for this source
    } = req.query;
    
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
      case '90d':
        startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }

    // Build WHERE clause for filtering
    let whereClause = 'WHERE ae.created_at >= $1';
    const queryParams = [startDate];
    let paramCount = 1;

    // Exclude test accounts if requested
    const excludeTestAccounts = req.query.exclude_test_accounts === 'true';
    if (excludeTestAccounts) {
      whereClause += ` AND (ae.user_id IS NULL OR u.email NOT IN ('patrickcook28@icloud.com', 'pcookcollege@gmail.com'))`;
    }

    // If event_type filter is provided, only show sources that have this event type
    if (event_type) {
      paramCount++;
      whereClause += ` AND ae.event_type = $${paramCount}`;
      queryParams.push(event_type);
    }

    // If source filter is provided, only show event types that have this source
    if (source) {
      paramCount++;
      whereClause += ` AND (
        COALESCE(
          ae.event_data->'parameters'->'registration_source'->>'utm_source',
          ae.event_data->'parameters'->'source'->>'utm_source',
          ae.event_data->'registration_source'->>'utm_source',
          ae.event_data->'source'->>'utm_source',
          ae.event_data->'utm_params'->>'utm_source',
          ae.event_data->'parameters'->'registration_source'->>'source',
          ae.event_data->'parameters'->'source'->>'source',
          ae.event_data->'registration_source'->>'source',
          ae.event_data->'source'->>'source'
        ) = $${paramCount}
      )`;
      queryParams.push(source);
    }

    // Get unique event types with counts (respecting source filter if provided)
    // Add JOIN if we need to exclude test accounts
    const eventTypesJoin = excludeTestAccounts ? 'LEFT JOIN users u ON ae.user_id = u.id' : '';
    const eventTypesQuery = `
      SELECT 
        ae.event_type,
        COUNT(*) as count
      FROM analytics_events ae
      ${eventTypesJoin}
      ${whereClause}
      GROUP BY ae.event_type
      ORDER BY count DESC, ae.event_type ASC
    `;
    const eventTypesResult = await db.query(eventTypesQuery, queryParams);

    // Get unique sources with counts (respecting event_type filter if provided)
    // Reset whereClause for sources query (remove event_type filter, keep source filter if it exists)
    let sourcesWhereClause = 'WHERE ae.created_at >= $1';
    const sourcesQueryParams = [startDate];
    let sourcesParamCount = 1;

    // Add exclude test accounts if needed
    if (excludeTestAccounts) {
      sourcesWhereClause += ` AND (ae.user_id IS NULL OR u.email NOT IN ('patrickcook28@icloud.com', 'pcookcollege@gmail.com'))`;
    }

    if (event_type) {
      sourcesParamCount++;
      sourcesWhereClause += ` AND ae.event_type = $${sourcesParamCount}`;
      sourcesQueryParams.push(event_type);
    }

    // Add JOIN if we need to exclude test accounts
    const sourcesJoin = excludeTestAccounts ? 'LEFT JOIN users u ON ae.user_id = u.id' : '';
    const sourcesQuery = `
      SELECT 
        COALESCE(
          ae.event_data->'parameters'->'registration_source'->>'utm_source',
          ae.event_data->'parameters'->'source'->>'utm_source',
          ae.event_data->'registration_source'->>'utm_source',
          ae.event_data->'source'->>'utm_source',
          ae.event_data->'utm_params'->>'utm_source',
          ae.event_data->'parameters'->'registration_source'->>'source',
          ae.event_data->'parameters'->'source'->>'source',
          ae.event_data->'registration_source'->>'source',
          ae.event_data->'source'->>'source'
        ) as source,
        COUNT(*) as count
      FROM analytics_events ae
      ${sourcesJoin}
      ${sourcesWhereClause}
        AND (
          ae.event_data->'parameters'->'registration_source'->>'utm_source' IS NOT NULL OR
          ae.event_data->'parameters'->'source'->>'utm_source' IS NOT NULL OR
          ae.event_data->'registration_source'->>'utm_source' IS NOT NULL OR
          ae.event_data->'source'->>'utm_source' IS NOT NULL OR
          ae.event_data->'utm_params'->>'utm_source' IS NOT NULL OR
          ae.event_data->'parameters'->'registration_source'->>'source' IS NOT NULL OR
          ae.event_data->'parameters'->'source'->>'source' IS NOT NULL OR
          ae.event_data->'registration_source'->>'source' IS NOT NULL OR
          ae.event_data->'source'->>'source' IS NOT NULL
        )
      GROUP BY source
      ORDER BY count DESC, source ASC
    `;
    const sourcesResult = await db.query(sourcesQuery, sourcesQueryParams);

    res.json({
      period,
      filters: {
        event_type: event_type || null,
        source: source || null,
      },
      eventTypes: eventTypesResult.rows.map(row => ({
        event_type: row.event_type,
        count: parseInt(row.count)
      })),
      sources: sourcesResult.rows
        .filter(row => {
          // Filter out null, undefined, and empty string values
          const source = row.source;
          return source && typeof source === 'string' && source.trim() !== '';
        })
        .map(row => ({
          source: row.source.trim(),
          count: parseInt(row.count)
        }))
    });

  } catch (error) {
    console.error('Analytics filters error:', error);
    res.status(500).json({ error: 'Failed to fetch filter values' });
  }
});

/**
 * Get analytics summary metrics
 */
router.get('/summary', async (req, res) => {
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

    const { period = '7d' } = req.query;
    
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

    // Get total page views
    const pageViewsQuery = `
      SELECT COUNT(*) as count
      FROM analytics_events
      WHERE event_type = 'page_view' AND created_at >= $1
    `;
    const pageViewsResult = await db.query(pageViewsQuery, [startDate]);

    // Get logged-in unique users (users with user_id)
    const loggedInUsersQuery = `
      SELECT COUNT(DISTINCT user_id) as count
      FROM analytics_events
      WHERE user_id IS NOT NULL AND created_at >= $1
    `;
    const loggedInUsersResult = await db.query(loggedInUsersQuery, [startDate]);

    // Get anonymous unique sessions (sessions without user_id)
    const anonymousSessionsQuery = `
      SELECT COUNT(DISTINCT session_id) as count
      FROM analytics_events
      WHERE user_id IS NULL AND created_at >= $1
    `;
    const anonymousSessionsResult = await db.query(anonymousSessionsQuery, [startDate]);

    // Get total unique sessions (all sessions, both logged-in and anonymous)
    const totalSessionsQuery = `
      SELECT COUNT(DISTINCT session_id) as count
      FROM analytics_events
      WHERE created_at >= $1
    `;
    const totalSessionsResult = await db.query(totalSessionsQuery, [startDate]);

    // Get logged-in user sessions (sessions that belong to logged-in users)
    const loggedInSessionsQuery = `
      SELECT COUNT(DISTINCT session_id) as count
      FROM analytics_events
      WHERE user_id IS NOT NULL AND created_at >= $1
    `;
    const loggedInSessionsResult = await db.query(loggedInSessionsQuery, [startDate]);

    // Get early access users count
    const earlyAccessQuery = `
      SELECT COUNT(*) as count
      FROM users
      WHERE early_access = TRUE OR beta_user = TRUE
    `;
    const earlyAccessResult = await db.query(earlyAccessQuery);

    // Get trial started count
    const trialStartedQuery = `
      SELECT COUNT(DISTINCT user_id) as count
      FROM analytics_events
      WHERE event_type = 'trial_started' AND created_at >= $1
    `;
    const trialStartedResult = await db.query(trialStartedQuery, [startDate]);

    // Get order placed count
    const orderPlacedQuery = `
      SELECT COUNT(*) as count
      FROM analytics_events
      WHERE event_type = 'order_placed' AND created_at >= $1
    `;
    const orderPlacedResult = await db.query(orderPlacedQuery, [startDate]);

    res.json({
      period,
      metrics: {
        pageViews: parseInt(pageViewsResult.rows[0]?.count || 0),
        loggedInUsers: parseInt(loggedInUsersResult.rows[0]?.count || 0),
        anonymousSessions: parseInt(anonymousSessionsResult.rows[0]?.count || 0),
        totalSessions: parseInt(totalSessionsResult.rows[0]?.count || 0),
        loggedInSessions: parseInt(loggedInSessionsResult.rows[0]?.count || 0),
        earlyAccessUsers: parseInt(earlyAccessResult.rows[0]?.count || 0),
        trialsStarted: parseInt(trialStartedResult.rows[0]?.count || 0),
        ordersPlaced: parseInt(orderPlacedResult.rows[0]?.count || 0),
      }
    });

  } catch (error) {
    console.error('Analytics summary error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics summary' });
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
