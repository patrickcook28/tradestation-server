const authRoutes = require('./auth');
const tradeStationRoutes = require('./tradestation');
const tradeAlertsRoutes = require('./tradeAlerts');
const technicalIndicatorsRoutes = require('./technicalIndicators');
const referralRoutes = require('./referral');
const clientConfigRoutes = require('./clientConfig');
const watchlistsRouter = require('./watchlists');
const tradeJournalsRouter = require('./tradeJournals');
const indicatorsRoutes = require('./indicators');

module.exports = {
    authRoutes,
    tradeStationRoutes,
    tradeAlertsRoutes,
    technicalIndicatorsRoutes,
    referralRoutes,
    clientConfigRoutes,
    watchlistsRouter,
    tradeJournalsRouter
    ,indicatorsRoutes
};