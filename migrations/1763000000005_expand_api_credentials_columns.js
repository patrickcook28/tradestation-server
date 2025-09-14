/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // Expand columns after prior migrations already applied
  pgm.alterColumn('api_credentials', 'access_token', { type: 'varchar(4096)' });
  pgm.alterColumn('api_credentials', 'refresh_token', { type: 'varchar(4096)' });
};

exports.down = (pgm) => {
  pgm.alterColumn('api_credentials', 'access_token', { type: 'varchar(1500)' });
  pgm.alterColumn('api_credentials', 'refresh_token', { type: 'varchar(1500)' });
};


