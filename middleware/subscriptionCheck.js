const { hasActiveSubscription, getSubscriptionStatus } = require('../utils/subscriptionHelpers');
const logger = require('../config/logging');

/**
 * Middleware to require active subscription for protected routes
 * Superusers and beta users with valid referral codes bypass this check
 */
const requireActiveSubscription = async (req, res, next) => {
  try {
    const userId = req.user.id;

    const hasAccess = await hasActiveSubscription(userId);

    if (!hasAccess) {
      logger.auth(req.method, req.path, 'Subscription Required', userId);
      return res.status(402).json({ 
        error: 'Active subscription required',
        message: 'You need an active subscription to access this feature',
        redirectTo: '/pricing'
      });
    }

    logger.auth(req.method, req.path, 'Subscription Check Passed', userId);
    next();
  } catch (error) {
    logger.error('Error in subscription check middleware:', error);
    return res.status(500).json({ error: 'Failed to verify subscription status' });
  }
};

/**
 * Middleware to attach subscription status to request object
 * Does not block access, just adds subscription info for use in route handlers
 */
const attachSubscriptionStatus = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const subscriptionStatus = await getSubscriptionStatus(userId);
    req.subscriptionStatus = subscriptionStatus;
    next();
  } catch (error) {
    logger.error('Error attaching subscription status:', error);
    req.subscriptionStatus = { hasAccess: false, reason: 'error' };
    next();
  }
};

module.exports = {
  requireActiveSubscription,
  attachSubscriptionStatus
};


