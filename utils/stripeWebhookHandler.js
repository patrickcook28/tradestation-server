const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const logger = require('../config/logging');
const pool = require('../db');
const billingRoutes = require('../routes/billing');

/**
 * Stripe webhook handler middleware
 * This must be used BEFORE express.json() middleware to preserve raw body for signature verification
 */
const stripeWebhookHandler = express.raw({ type: 'application/json' });

/**
 * Main webhook processing function
 */
const processWebhook = async (req, res) => {
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

  // Handle the event using existing billing route handlers
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await billingRoutes.handleCheckoutSessionCompleted(event.data.object);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await billingRoutes.handleSubscriptionUpdated(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await billingRoutes.handleSubscriptionDeleted(event.data.object);
        break;
      case 'invoice.payment_succeeded':
        await billingRoutes.handlePaymentSucceeded(event.data.object);
        break;
      case 'invoice.payment_failed':
        await billingRoutes.handlePaymentFailed(event.data.object);
        break;
      case 'customer.subscription.trial_will_end':
        await billingRoutes.handleTrialWillEnd(event.data.object);
        break;
      default:
        logger.info(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    logger.error(`Error handling webhook event ${event.type}:`, error);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
};

/**
 * Setup Stripe webhook route
 * @param {Express} app - Express app instance
 */
const setupStripeWebhook = (app) => {
  // Handle Stripe webhook events (NOT protected by auth middleware)
  app.post('/billing/webhook', stripeWebhookHandler, processWebhook);
};

module.exports = {
  setupStripeWebhook,
  stripeWebhookHandler,
  processWebhook
};
