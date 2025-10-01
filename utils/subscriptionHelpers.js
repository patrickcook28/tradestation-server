const pool = require('../db');
const logger = require('../config/logging');

/**
 * Get active subscription for a user
 * @param {number} userId - User ID
 * @returns {object|null} Subscription object or null
 */
async function getActiveSubscription(userId) {
  try {
    const result = await pool.query(
      `SELECT * FROM subscriptions 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT 1`,
      [userId]
    );

    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (error) {
    logger.error('Error fetching active subscription:', error);
    throw error;
  }
}

/**
 * Check if user has active subscription or is in trial
 * Beta users with valid referral codes bypass subscription requirements
 * @param {number} userId - User ID
 * @returns {boolean} True if user has access
 */
async function hasActiveSubscription(userId) {
  try {
    // Check if user is a beta user with valid referral code
    const userResult = await pool.query(
      'SELECT superuser, beta_user, referral_code FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return false;
    }

    const user = userResult.rows[0];

    // Superusers always have access
    if (user.superuser) {
      return true;
    }

    // Beta users with valid referral codes have free access
    if (user.beta_user && user.referral_code) {
      // Verify referral code is still valid
      const referralResult = await pool.query(
        'SELECT is_active FROM referral_codes WHERE code = $1',
        [user.referral_code]
      );

      if (referralResult.rows.length > 0 && referralResult.rows[0].is_active) {
        return true;
      } else {
        // Referral code is invalid or inactive - clear beta_user status
        await pool.query(
          'UPDATE users SET beta_user = false WHERE id = $1',
          [userId]
        );
        return false;
      }
    }

    // Check for active subscription
    const subscription = await getActiveSubscription(userId);
    
    if (!subscription) {
      return false;
    }

    // Allow access if status is active or trialing
    return ['active', 'trialing'].includes(subscription.status);
  } catch (error) {
    logger.error('Error checking subscription status:', error);
    return false;
  }
}

/**
 * Check if user is currently in trial period
 * @param {number} userId - User ID
 * @returns {boolean} True if user is in trial
 */
async function isInTrial(userId) {
  try {
    const subscription = await getActiveSubscription(userId);
    
    if (!subscription) {
      return false;
    }

    return subscription.status === 'trialing';
  } catch (error) {
    logger.error('Error checking trial status:', error);
    return false;
  }
}

/**
 * Get subscription status summary for a user
 * @param {number} userId - User ID
 * @returns {object} Status summary including access level, subscription details, trial info
 */
async function getSubscriptionStatus(userId) {
  try {
    // Get user info
    const userResult = await pool.query(
      'SELECT superuser, beta_user, referral_code FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return {
        hasAccess: false,
        reason: 'user_not_found'
      };
    }

    const user = userResult.rows[0];

    // Superuser
    if (user.superuser) {
      return {
        hasAccess: true,
        reason: 'superuser',
        subscription: null
      };
    }

    // Beta user with valid referral code
    if (user.beta_user && user.referral_code) {
      const referralResult = await pool.query(
        'SELECT is_active FROM referral_codes WHERE code = $1',
        [user.referral_code]
      );

      if (referralResult.rows.length > 0 && referralResult.rows[0].is_active) {
        return {
          hasAccess: true,
          reason: 'beta_access',
          referralCode: user.referral_code,
          subscription: null
        };
      } else {
        // Clear invalid beta status
        await pool.query(
          'UPDATE users SET beta_user = false WHERE id = $1',
          [userId]
        );
      }
    }

    // Check subscription
    const subscription = await getActiveSubscription(userId);
    
    if (!subscription) {
      return {
        hasAccess: false,
        reason: 'no_subscription',
        subscription: null
      };
    }

    const hasAccess = ['active', 'trialing'].includes(subscription.status);

    return {
      hasAccess,
      reason: hasAccess ? 'subscription' : 'subscription_inactive',
      subscription: {
        id: subscription.id,
        status: subscription.status,
        plan: subscription.plan,
        currentPeriodEnd: subscription.current_period_end,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        trialEnd: subscription.trial_end
      }
    };
  } catch (error) {
    logger.error('Error getting subscription status:', error);
    throw error;
  }
}

module.exports = {
  getActiveSubscription,
  hasActiveSubscription,
  isInTrial,
  getSubscriptionStatus
};


