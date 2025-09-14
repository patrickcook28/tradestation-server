/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = async (pgm) => {
  // No schema changes; transform data in place using Node's crypto would be ideal,
  // but migrations run in DB context. We'll mark rows with a helper function that the app can run on startup if needed.
  // As a pragmatic approach, prepend a marker to detect already-encrypted values and let app-layer encrypt once on next write.
  // However, we prefer immediate encryption if possible via SQL function is not feasible. We'll leave schema untouched.
  // This migration exists to document the version bump and allows optional app-side backfill script.
};

exports.down = async (pgm) => {
  // No-op: cannot safely decrypt without key in migration context.
};


