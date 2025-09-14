/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('password_resets', {
    invalidated_reason: { type: 'varchar(50)' }
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('password_resets', 'invalidated_reason');
};


