/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // Add SMS columns to alert_logs table if they don't exist
  pgm.addColumn('alert_logs', {
    sms_sent: { type: 'boolean', default: false },
    sms_sent_at: { type: 'timestamp' }
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('alert_logs', ['sms_sent', 'sms_sent_at']);
}; 