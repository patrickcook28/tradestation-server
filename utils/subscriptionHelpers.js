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
 * Early access users and beta users with valid referral codes bypass subscription requirements
 * @param {number} userId - User ID
 * @returns {boolean} True if user has access
 */
async function hasActiveSubscription(userId) {
  try {
    // Check if user has early access, beta access, or is superuser
    const userResult = await pool.query(
      'SELECT superuser, beta_user, early_access, referral_code FROM users WHERE id = $1',
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

    // Early access users have free access (new system)
    if (user.early_access) {
      return true;
    }

    // Beta users with valid referral codes have free access (legacy system)
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
 * Check if user has ever used a free trial
 * @param {number} userId - User ID
 * @returns {boolean} True if user has used a trial before
 */
async function hasUsedTrial(userId) {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) as count 
       FROM subscriptions 
       WHERE user_id = $1 
       AND (trial_start IS NOT NULL OR trial_end IS NOT NULL)`,
      [userId]
    );

    return parseInt(result.rows[0].count) > 0;
  } catch (error) {
    logger.error('Error checking trial history:', error);
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
      'SELECT superuser, beta_user, early_access, referral_code FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return {
        hasAccess: false,
        reason: 'user_not_found',
        hasUsedTrial: false
      };
    }

    const user = userResult.rows[0];

    // Check if user has used trial before
    const hasUsedTrialBefore = await hasUsedTrial(userId);

    // Fetch subscription so we can include it when user has access via superuser/early_access (for UI "Manage Subscription")
    const subscription = await getActiveSubscription(userId);

    // Build subscription payload for response (shared by early-access and subscription paths)
    const buildSubscriptionPayload = async (sub) => {
      if (!sub) return null;
      let cancelAtPeriodEnd = sub.cancel_at_period_end;
      let canceledAt = sub.canceled_at;
      let cancelAt = null;
      if (sub.status === 'trialing' && sub.stripe_subscription_id) {
        try {
          const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
          const stripeSubscription = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
          cancelAtPeriodEnd = stripeSubscription.cancel_at_period_end || false;
          canceledAt = stripeSubscription.canceled_at ? new Date(stripeSubscription.canceled_at * 1000) : null;
          cancelAt = stripeSubscription.cancel_at ? new Date(stripeSubscription.cancel_at * 1000) : null;
          if (canceledAt && !sub.canceled_at) {
            await pool.query('UPDATE subscriptions SET canceled_at = $1 WHERE id = $2', [canceledAt, sub.id]);
          }
          if (cancelAtPeriodEnd !== sub.cancel_at_period_end) {
            await pool.query('UPDATE subscriptions SET cancel_at_period_end = $1 WHERE id = $2', [cancelAtPeriodEnd, sub.id]);
          }
        } catch (error) {
          logger.error('Error fetching subscription from Stripe:', error);
        }
      }
      const isCanceled = cancelAt !== null || cancelAtPeriodEnd === true || canceledAt !== null;
      return {
        id: sub.id,
        status: sub.status,
        plan: sub.plan,
        currentPeriodEnd: sub.current_period_end,
        cancelAtPeriodEnd,
        canceledAt,
        cancelAt,
        trialEnd: sub.trial_end,
        isCanceled
      };
    };

    // Superuser – include subscription if present so UI can show "Manage Subscription"
    if (user.superuser) {
      return {
        hasAccess: true,
        reason: 'superuser',
        subscription: await buildSubscriptionPayload(subscription),
        hasUsedTrial: hasUsedTrialBefore
      };
    }

    // Early access user (new system) – include subscription if present so UI can show "Manage Subscription"
    if (user.early_access) {
      return {
        hasAccess: true,
        reason: 'early_access',
        subscription: await buildSubscriptionPayload(subscription),
        hasUsedTrial: hasUsedTrialBefore
      };
    }

    // Beta user with valid referral code (legacy system)
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
          subscription: await buildSubscriptionPayload(subscription),
          hasUsedTrial: hasUsedTrialBefore
        };
      } else {
        // Clear invalid beta status
        await pool.query(
          'UPDATE users SET beta_user = false WHERE id = $1',
          [userId]
        );
      }
    }

    // No bypass – check subscription for access
    
    if (!subscription) {
      return {
        hasAccess: false,
        reason: 'no_subscription',
        subscription: null,
        hasUsedTrial: hasUsedTrialBefore
      };
    }

    const hasAccess = ['active', 'trialing'].includes(subscription.status);
    const subscriptionPayload = await buildSubscriptionPayload(subscription);

    return {
      hasAccess,
      reason: hasAccess ? 'subscription' : 'subscription_inactive',
      subscription: subscriptionPayload,
      hasUsedTrial: hasUsedTrialBefore
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
  hasUsedTrial,
  getSubscriptionStatus
};


