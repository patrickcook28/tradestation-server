const express = require('express');
const router = express.Router();
const pool = require('../db');
const logger = require('../config/logging');

// Initialize Stripe - will be set in main app after env is loaded
let stripe;

function initializeStripe(stripeInstance) {
  stripe = stripeInstance;
}

// Auth middleware (same pattern as other routes)
const authenticateToken = (req, res, next) => {
  const jwt = require('jsonwebtoken');
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);
  jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] }, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// Get or create Stripe customer for user
async function getOrCreateCustomer(userId, email) {
  try {
    // Check if user already has a stripe_customer_id
    const userResult = await pool.query(
      'SELECT stripe_customer_id FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows[0]?.stripe_customer_id) {
      return userResult.rows[0].stripe_customer_id;
    }

    // Create new Stripe customer
    const customer = await stripe.customers.create({
      email: email,
      metadata: {
        user_id: userId.toString()
      }
    });

    // Store customer ID in users table
    await pool.query(
      'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
      [customer.id, userId]
    );

    return customer.id;
  } catch (error) {
    logger.error('Error getting or creating Stripe customer:', error);
    throw error;
  }
}

// POST /billing/create_checkout_session
// Creates a Stripe Checkout session for subscription
router.post('/create_checkout_session', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { plan } = req.body; // 'monthly' or 'annual'

    if (!plan || !['monthly', 'annual'].includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan. Must be "monthly" or "annual"' });
    }

    // Get user email
    const userResult = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const email = userResult.rows[0].email;

    // Get or create Stripe customer
    const customerId = await getOrCreateCustomer(userId, email);

    // Get price ID from environment variables
    const priceId = plan === 'monthly' 
      ? process.env.STRIPE_PRICE_ID_MONTHLY 
      : process.env.STRIPE_PRICE_ID_ANNUAL;

    if (!priceId) {
      logger.error(`Missing Stripe price ID for plan: ${plan}`);
      return res.status(500).json({ error: 'Subscription configuration error' });
    }

    // Create Checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      billing_address_collection: 'auto',
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL}/subscription-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/pricing?canceled=true`,
      subscription_data: {
        trial_period_days: 7,
        metadata: {
          user_id: userId.toString()
        }
      },
      metadata: {
        user_id: userId.toString()
      }
    });

    logger.info(`Created checkout session for user ${userId}, plan: ${plan}`);
    res.json({ url: session.url });
  } catch (error) {
    logger.error('Error creating checkout session:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// POST /billing/create_portal_session
// Creates a Stripe Customer Portal session for managing subscription
router.post('/create_portal_session', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get user's stripe_customer_id
    const userResult = await pool.query(
      'SELECT stripe_customer_id FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const customerId = userResult.rows[0].stripe_customer_id;

    if (!customerId) {
      return res.status(400).json({ error: 'No subscription found' });
    }

    // Create portal session
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${process.env.FRONTEND_URL}/settings`,
    });

    logger.info(`Created portal session for user ${userId}`);
    res.json({ url: portalSession.url });
  } catch (error) {
    logger.error('Error creating portal session:', error);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

// GET /billing/subscription
// Get current subscription details for authenticated user
router.get('/subscription', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get active subscription
    const result = await pool.query(
      `SELECT * FROM subscriptions 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT 1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.json({ subscription: null });
    }

    const subscription = result.rows[0];
    res.json({ subscription });
  } catch (error) {
    logger.error('Error fetching subscription:', error);
    res.status(500).json({ error: 'Failed to fetch subscription' });
  }
});

// POST /billing/verify_session
// Verify and sync checkout session (fallback for when webhooks are delayed)
router.post('/verify_session', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { session_id } = req.body;

    if (!session_id) {
      return res.status(400).json({ error: 'Session ID required' });
    }

    logger.info(`Verifying checkout session ${session_id} for user ${userId}`);

    // Retrieve the checkout session from Stripe
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['subscription']
    });

    if (session.payment_status !== 'paid' && session.status !== 'complete') {
      return res.status(400).json({ error: 'Session not completed' });
    }

    // Process the subscription if it exists
    if (session.subscription) {
      const subscription = typeof session.subscription === 'string' 
        ? await stripe.subscriptions.retrieve(session.subscription)
        : session.subscription;
      
      // Process the subscription (same logic as webhook)
      await handleSubscriptionUpdated(subscription);
      
      logger.info(`Manually synced subscription ${subscription.id} for user ${userId}`);
      res.json({ success: true, subscription_id: subscription.id });
    } else {
      res.status(400).json({ error: 'No subscription in session' });
    }
  } catch (error) {
    logger.error('Error verifying session:', error);
    res.status(500).json({ error: 'Failed to verify session' });
  }
});

// POST /billing/webhook
// Handle Stripe webhook events (NOT protected by auth middleware)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    // Verify webhook signature
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    logger.error(`Webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Check for duplicate events (idempotency)
  try {
    const existingEvent = await pool.query(
      'SELECT id FROM webhook_events WHERE stripe_event_id = $1',
      [event.id]
    );

    if (existingEvent.rows.length > 0) {
      logger.info(`Webhook event ${event.id} already processed, skipping`);
      return res.json({ received: true, skipped: true });
    }

    // Store event for idempotency
    await pool.query(
      'INSERT INTO webhook_events (stripe_event_id, event_type, payload) VALUES ($1, $2, $3)',
      [event.id, event.type, JSON.stringify(event)]
    );
  } catch (error) {
    logger.error('Error checking/storing webhook event:', error);
    // Continue processing even if idempotency check fails
  }

  // Handle the event
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(event.data.object);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object);
        break;
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;
      case 'customer.subscription.trial_will_end':
        await handleTrialWillEnd(event.data.object);
        break;
      default:
        logger.info(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    logger.error(`Error handling webhook event ${event.type}:`, error);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

// Webhook handlers

async function handleCheckoutSessionCompleted(session) {
  const userId = parseInt(session.metadata.user_id);
  const customerId = session.customer;
  const subscriptionId = session.subscription;

  logger.info(`Checkout completed for user ${userId}`);

  // Update user's stripe_customer_id if not already set
  await pool.query(
    'UPDATE users SET stripe_customer_id = $1 WHERE id = $2 AND stripe_customer_id IS NULL',
    [customerId, userId]
  );

  // Subscription details will be handled by customer.subscription.created event
}

async function handleSubscriptionUpdated(subscription) {
  const customerId = subscription.customer;
  const subscriptionId = subscription.id;
  const status = subscription.status;
  const userId = parseInt(subscription.metadata.user_id);

  logger.info(`Subscription ${subscriptionId} updated for user ${userId}, status: ${status}`);

  // Determine plan from price ID
  const priceId = subscription.items.data[0].price.id;
  let plan = 'monthly';
  if (priceId === process.env.STRIPE_PRICE_ID_ANNUAL) {
    plan = 'annual';
  }

  // Upsert subscription record
  await pool.query(
    `INSERT INTO subscriptions (
      user_id, stripe_customer_id, stripe_subscription_id, status, plan, 
      stripe_price_id, current_period_start, current_period_end, 
      cancel_at_period_end, canceled_at, trial_start, trial_end, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7), to_timestamp($8), $9, $10, to_timestamp($11), to_timestamp($12), CURRENT_TIMESTAMP)
    ON CONFLICT (stripe_subscription_id) 
    DO UPDATE SET 
      status = $4,
      plan = $5,
      stripe_price_id = $6,
      current_period_start = to_timestamp($7),
      current_period_end = to_timestamp($8),
      cancel_at_period_end = $9,
      canceled_at = $10,
      trial_start = to_timestamp($11),
      trial_end = to_timestamp($12),
      updated_at = CURRENT_TIMESTAMP`,
    [
      userId,
      customerId,
      subscriptionId,
      status,
      plan,
      priceId,
      subscription.current_period_start,
      subscription.current_period_end,
      subscription.cancel_at_period_end,
      subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null,
      subscription.trial_start,
      subscription.trial_end
    ]
  );
}

async function handleSubscriptionDeleted(subscription) {
  const subscriptionId = subscription.id;
  const userId = parseInt(subscription.metadata.user_id);

  logger.info(`Subscription ${subscriptionId} deleted for user ${userId}`);

  await pool.query(
    `UPDATE subscriptions 
     SET status = 'canceled', canceled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE stripe_subscription_id = $1`,
    [subscriptionId]
  );
}

async function handlePaymentSucceeded(invoice) {
  const subscriptionId = invoice.subscription;
  
  if (!subscriptionId) return;

  logger.info(`Payment succeeded for subscription ${subscriptionId}`);

  // Update subscription status to active and clear any past_due flags
  await pool.query(
    `UPDATE subscriptions 
     SET status = 'active', updated_at = CURRENT_TIMESTAMP
     WHERE stripe_subscription_id = $1`,
    [subscriptionId]
  );
}

async function handlePaymentFailed(invoice) {
  const subscriptionId = invoice.subscription;
  
  if (!subscriptionId) return;

  logger.error(`Payment failed for subscription ${subscriptionId}`);

  // Update subscription status to past_due (immediate blocking, no grace period)
  await pool.query(
    `UPDATE subscriptions 
     SET status = 'past_due', updated_at = CURRENT_TIMESTAMP
     WHERE stripe_subscription_id = $1`,
    [subscriptionId]
  );

  // Optional: Send notification to user about failed payment
  // You can add email notification logic here
}

async function handleTrialWillEnd(subscription) {
  const subscriptionId = subscription.id;
  const userId = parseInt(subscription.metadata.user_id);

  logger.info(`Trial ending soon for subscription ${subscriptionId}, user ${userId}`);

  // Optional: Send notification to user about trial ending
  // You can add email notification logic here
}

module.exports = router;
module.exports.initializeStripe = initializeStripe;

