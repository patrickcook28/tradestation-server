const pool = require('../db');

/**
 * Migration: Migrate app_settings to support multiple independent charts
 * 
 * Changes:
 * - Move chart-specific settings (ticker, interval, unit, sessionTemplate, indicators) into charts array
 * - Add activeChartId to track which chart is receiving orders/brackets
 * - Keep global settings (showOrders, logScale, showStdDevLines, etc.) at root level
 * - Create default 2-chart layout for desktop
 */

async function up() {
  const client = await pool.connect();
  try {
    console.log('Migrating app_settings to multi-chart architecture...');

    await client.query('BEGIN');

    // Get all users with app_settings
    const result = await client.query(`
      SELECT id, app_settings 
      FROM users 
      WHERE app_settings IS NOT NULL AND app_settings::text != '{}'
    `);

    let migratedCount = 0;
    let skippedCount = 0;

    for (const row of result.rows) {
      const userId = row.id;
      const oldSettings = row.app_settings || {};

      // Skip if already migrated (has charts array)
      if (oldSettings.charts) {
        skippedCount++;
        continue;
      }

      // Extract chart-specific settings from old structure
      const chart1Ticker = oldSettings.chartTicker || null; // May not exist
      const chart1Interval = oldSettings.chartInterval || 5;
      const chart1Unit = oldSettings.chartUnit || 'Minute';
      const chart1SessionTemplate = oldSettings.sessionTemplate || 'Default';
      const chart1Barsback = oldSettings.barsback || 200;

      // Create new settings structure
      const newSettings = {
        // Chart array with 2 default charts
        charts: [
          {
            id: 'chart1',
            ticker: chart1Ticker, // Can be null - will use selectedTicker from TradingContext
            interval: chart1Interval,
            unit: chart1Unit,
            sessionTemplate: chart1SessionTemplate,
            barsback: chart1Barsback,
            indicators: [] // Will be populated from indicator settings if needed
          },
          {
            id: 'chart2',
            ticker: null, // Independent ticker
            interval: 15, // Default to 15min for second chart
            unit: 'Minute',
            sessionTemplate: chart1SessionTemplate, // Copy from chart1
            barsback: 200,
            indicators: []
          }
        ],
        activeChartId: 'chart1', // First chart is active by default
        chartLayout: oldSettings.chartLayout || 'single', // Default layout - single chart
        
        // Global settings (preserve existing values)
        showOrders: oldSettings.showOrders !== false, // Default true
        logScale: oldSettings.logScale === true,
        showStdDevLines: oldSettings.showStdDevLines === true,
        showLiquidity: oldSettings.showLiquidity === true,
        liquidityLevelsCount: oldSettings.liquidityLevelsCount || 3,
        
        // UI/UX settings (preserve)
        manualQuantityOverride: oldSettings.manualQuantityOverride === true,
        limitSyncEnabled: oldSettings.limitSyncEnabled === true,
        
        // Order settings (preserve)
        bracketType: oldSettings.bracketType || 'tp_1',
        manualAtr: oldSettings.manualAtr || 2,
        timeInForce: oldSettings.timeInForce || 'DAY',
        orderType: oldSettings.orderType || 'market',
        
        // Mobile settings (preserve)
        mobileWatchlistsCollapsed: oldSettings.mobileWatchlistsCollapsed === true,
        mobileChartCollapsed: oldSettings.mobileChartCollapsed === true,
        mobileOrderSettingsCollapsed: oldSettings.mobileOrderSettingsCollapsed === true,
        
        // Take profit settings (preserve if exists)
        takeProfitPrices: Array.isArray(oldSettings.takeProfitPrices) ? oldSettings.takeProfitPrices : []
      };

      // Update the user's settings
      await client.query(
        `UPDATE users SET app_settings = $1 WHERE id = $2`,
        [JSON.stringify(newSettings), userId]
      );

      migratedCount++;
    }

    await client.query('COMMIT');
    console.log(`✅ Successfully migrated ${migratedCount} users to multi-chart settings`);
    console.log(`   Skipped ${skippedCount} users (already migrated)`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error in migration:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function down() {
  const client = await pool.connect();
  try {
    console.log('Reverting multi-chart settings to legacy structure...');

    await client.query('BEGIN');

    // Get all users with charts array
    const result = await client.query(`
      SELECT id, app_settings 
      FROM users 
      WHERE app_settings IS NOT NULL 
        AND app_settings::jsonb ? 'charts'
    `);

    let revertedCount = 0;

    for (const row of result.rows) {
      const userId = row.id;
      const newSettings = row.app_settings || {};

      // Skip if no charts array
      if (!newSettings.charts || !Array.isArray(newSettings.charts)) {
        continue;
      }

      // Get chart1 settings (the active chart)
      const activeChart = newSettings.charts.find(c => c.id === newSettings.activeChartId) || newSettings.charts[0];

      // Create legacy settings structure
      const oldSettings = {
        // Chart settings from active chart
        chartInterval: activeChart.interval,
        chartUnit: activeChart.unit,
        sessionTemplate: activeChart.sessionTemplate,
        barsback: activeChart.barsback,
        chartLayout: newSettings.chartLayout, // Preserve layout
        
        // Global settings (preserve)
        showOrders: newSettings.showOrders,
        logScale: newSettings.logScale,
        showStdDevLines: newSettings.showStdDevLines,
        showLiquidity: newSettings.showLiquidity,
        liquidityLevelsCount: newSettings.liquidityLevelsCount,
        manualQuantityOverride: newSettings.manualQuantityOverride,
        limitSyncEnabled: newSettings.limitSyncEnabled,
        bracketType: newSettings.bracketType,
        manualAtr: newSettings.manualAtr,
        timeInForce: newSettings.timeInForce,
        orderType: newSettings.orderType,
        mobileWatchlistsCollapsed: newSettings.mobileWatchlistsCollapsed,
        mobileChartCollapsed: newSettings.mobileChartCollapsed,
        mobileOrderSettingsCollapsed: newSettings.mobileOrderSettingsCollapsed,
        takeProfitPrices: newSettings.takeProfitPrices
      };

      // Update the user's settings
      await client.query(
        `UPDATE users SET app_settings = $1 WHERE id = $2`,
        [JSON.stringify(oldSettings), userId]
      );

      revertedCount++;
    }

    await client.query('COMMIT');
    console.log(`✅ Successfully reverted ${revertedCount} users to legacy chart settings`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };

