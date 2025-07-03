/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('std_dev_levels', {
    reference_price: { type: 'decimal(10, 2)' }
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('std_dev_levels', 'reference_price');
}; 