const authRoutes = require('./auth');
const tradeStationRoutes = require('./tradestation');
const tradeAlertsRoutes = require('./tradeAlerts');
const technicalIndicatorsRoutes = require('./technicalIndicators');
const referralRoutes = require('./referral');
const betaRoutes = require('./beta');
const clientConfigRoutes = require('./clientConfig');
const watchlistsRouter = require('./watchlists');
const tradeJournalsRouter = require('./tradeJournals');
const indicatorsRoutes = require('./indicators');
const contactRoutes = require('./contact');
const bugReportsRoutes = require('./bugReports');
const debugRoutes = require('./debug');
const learnRoutes = require('./learn');
const emailTemplatesRoutes = require('./emailTemplates');

module.exports = {
    authRoutes,
    tradeStationRoutes,
    tradeAlertsRoutes,
    technicalIndicatorsRoutes,
    referralRoutes,
    betaRoutes,
    clientConfigRoutes,
    watchlistsRouter,
    tradeJournalsRouter,
    indicatorsRoutes,
    contactRoutes,
    bugReportsRoutes,
    debugRoutes,
    learnRoutes,
    emailTemplatesRoutes
};