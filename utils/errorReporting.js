const Sentry = require('@sentry/node');

// Sentry is initialized early in instrument.js. This module only provides safe wrappers.

const captureException = (error, context) => {
  try {
    if (!error) return;
    if (context && typeof context === 'object') {
      Sentry.withScope(scope => {
        Object.entries(context).forEach(([k, v]) => scope.setExtra(k, v));
        Sentry.captureException(error);
      });
    } else {
      Sentry.captureException(error);
    }
  } catch (_) {}
};

const captureMessage = (message, context) => {
  try {
    if (!message) return;
    if (context && typeof context === 'object') {
      Sentry.withScope(scope => {
        Object.entries(context).forEach(([k, v]) => scope.setExtra(k, v));
        Sentry.captureMessage(message);
      });
    } else {
      Sentry.captureMessage(message);
    }
  } catch (_) {}
};

// No-op middlewares retained for compatibility where imported
const requestHandler = () => (req, res, next) => next();
const errorHandler = () => (err, req, res, next) => next(err);

module.exports = {
  captureException,
  captureMessage,
  requestHandler,
  errorHandler,
};


