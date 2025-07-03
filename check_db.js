const pool = require('./db');

async function checkDatabase() {
  try {
    console.log('Checking database structure...');
    
    // Check if std_dev_levels table exists
    const tableQuery = `
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'std_dev_levels' 
      ORDER BY ordinal_position
    `;
    
    const result = await pool.query(tableQuery);
    
    if (result.rows.length === 0) {
      console.log('std_dev_levels table does not exist!');
    } else {
      console.log('std_dev_levels table columns:');
      result.rows.forEach(row => {
        console.log(`  ${row.column_name}: ${row.data_type}`);
      });
    }
    
    // Try to drop and recreate the table
    console.log('\nDropping and recreating std_dev_levels table...');
    await pool.query('DROP TABLE IF EXISTS std_dev_levels CASCADE');
    
    // Recreate the table
    const createTableQuery = `
      CREATE TABLE std_dev_levels (
        id SERIAL PRIMARY KEY,
        ticker VARCHAR(10) NOT NULL,
        timeframe VARCHAR(20) NOT NULL DEFAULT '1hour',
        mean_price DECIMAL(10, 4),
        std_dev DECIMAL(10, 4),
        std_dev_1_upper DECIMAL(10, 4),
        std_dev_1_lower DECIMAL(10, 4),
        std_dev_1_5_upper DECIMAL(10, 4),
        std_dev_1_5_lower DECIMAL(10, 4),
        std_dev_2_upper DECIMAL(10, 4),
        std_dev_2_lower DECIMAL(10, 4),
        bars_count INTEGER,
        last_calculated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(ticker, timeframe)
      )
    `;
    
    await pool.query(createTableQuery);
    console.log('Table recreated successfully!');
    
    // Check the new table structure
    const newResult = await pool.query(tableQuery);
    console.log('\nNew std_dev_levels table columns:');
    newResult.rows.forEach(row => {
      console.log(`  ${row.column_name}: ${row.data_type}`);
    });
    
  } catch (error) {
    console.error('Error checking database:', error);
  } finally {
    await pool.end();
  }
}

checkDatabase(); 