/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('trade_alerts', {
    indicator_type: { type: 'varchar(20)' },
    indicator_period: { type: 'integer' }
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('trade_alerts', ['indicator_type', 'indicator_period']);
}; 