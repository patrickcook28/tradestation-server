/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('trade_alerts', {
    timeframe: { type: 'varchar(20)' },
    std_dev_level: { type: 'varchar(30)' }
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('trade_alerts', ['timeframe', 'std_dev_level']);
};
