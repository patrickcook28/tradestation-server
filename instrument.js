// Sentry must be initialized before anything else
const Sentry = require("@sentry/node");

const sentryEnvironment = process.env.SENTRY_ENV
  || process.env.REACT_APP_SENTRY_ENV
  || process.env.NODE_ENV
  || 'development';

const sentryDsn = process.env.SENTRY_DSN
  || process.env.REACT_APP_SENTRY_DSN
  || "https://63e0626c1cf71f8af00d254ad11da7ea@o4509895088078848.ingest.us.sentry.io/4510019262283776";

Sentry.init({
  dsn: sentryDsn,
  environment: sentryEnvironment,
  sendDefaultPii: true,
});

module.exports = Sentry;


