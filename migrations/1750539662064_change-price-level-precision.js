/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // Change price_level column in trade_alerts table
  pgm.alterColumn('trade_alerts', 'price_level', {
    type: 'decimal(10,2)'
  });

  // Change price columns in std_dev_levels table
  pgm.alterColumn('std_dev_levels', 'mean_price', {
    type: 'decimal(10,2)'
  });
  pgm.alterColumn('std_dev_levels', 'std_dev', {
    type: 'decimal(10,2)'
  });
  pgm.alterColumn('std_dev_levels', 'std_dev_1_upper', {
    type: 'decimal(10,2)'
  });
  pgm.alterColumn('std_dev_levels', 'std_dev_1_lower', {
    type: 'decimal(10,2)'
  });
  pgm.alterColumn('std_dev_levels', 'std_dev_1_5_upper', {
    type: 'decimal(10,2)'
  });
  pgm.alterColumn('std_dev_levels', 'std_dev_1_5_lower', {
    type: 'decimal(10,2)'
  });
  pgm.alterColumn('std_dev_levels', 'std_dev_2_upper', {
    type: 'decimal(10,2)'
  });
  pgm.alterColumn('std_dev_levels', 'std_dev_2_lower', {
    type: 'decimal(10,2)'
  });

  // Change trigger_price column in alert_logs table
  pgm.alterColumn('alert_logs', 'trigger_price', {
    type: 'decimal(10,2)'
  });
};

exports.down = (pgm) => {
  // Revert price_level column in trade_alerts table
  pgm.alterColumn('trade_alerts', 'price_level', {
    type: 'decimal(10,4)'
  });

  // Revert price columns in std_dev_levels table
  pgm.alterColumn('std_dev_levels', 'mean_price', {
    type: 'decimal(10,4)'
  });
  pgm.alterColumn('std_dev_levels', 'std_dev', {
    type: 'decimal(10,4)'
  });
  pgm.alterColumn('std_dev_levels', 'std_dev_1_upper', {
    type: 'decimal(10,4)'
  });
  pgm.alterColumn('std_dev_levels', 'std_dev_1_lower', {
    type: 'decimal(10,4)'
  });
  pgm.alterColumn('std_dev_levels', 'std_dev_1_5_upper', {
    type: 'decimal(10,4)'
  });
  pgm.alterColumn('std_dev_levels', 'std_dev_1_5_lower', {
    type: 'decimal(10,4)'
  });
  pgm.alterColumn('std_dev_levels', 'std_dev_2_upper', {
    type: 'decimal(10,4)'
  });
  pgm.alterColumn('std_dev_levels', 'std_dev_2_lower', {
    type: 'decimal(10,4)'
  });

  // Revert trigger_price column in alert_logs table
  pgm.alterColumn('alert_logs', 'trigger_price', {
    type: 'decimal(10,4)'
  });
}; 