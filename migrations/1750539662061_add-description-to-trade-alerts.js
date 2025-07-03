/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('trade_alerts', {
    description: { type: 'text' }
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('trade_alerts', ['description']);
};
