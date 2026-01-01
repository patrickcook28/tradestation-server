const pool = require('../db');

/**
 * Migration script to normalize journal template options to {label, value} format
 * This ensures all templates use a consistent format for options
 */

async function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.map(opt => {
    // If already an object with label/value, ensure it has both
    if (typeof opt === 'object' && opt !== null) {
      const label = opt.label || opt.value || String(opt);
      const value = opt.value || opt.label || String(opt);
      return { label, value };
    }
    // If string, convert to object
    const str = String(opt);
    return { label: str, value: str };
  });
}

async function migrateTemplates() {
  const client = await pool.connect();
  try {
    console.log('Fetching all journal templates...');
    const result = await client.query('SELECT id, user_id, name, template FROM trade_journal_templates');
    
    console.log(`Found ${result.rows.length} templates to migrate`);
    
    let migrated = 0;
    let skipped = 0;
    
    for (const row of result.rows) {
      const template = row.template;
      let needsUpdate = false;
      
      if (template && Array.isArray(template.fields)) {
        const normalizedFields = template.fields.map(field => {
          // Only normalize options for single and multi type fields
          if ((field.type === 'single' || field.type === 'multi') && Array.isArray(field.options)) {
            const normalized = normalizeOptions(field.options);
            // Check if normalization changed anything
            const changed = JSON.stringify(normalized) !== JSON.stringify(field.options);
            if (changed) {
              needsUpdate = true;
              return { ...field, options: normalized };
            }
          }
          return field;
        });
        
        if (needsUpdate) {
          const normalizedTemplate = { ...template, fields: normalizedFields };
          await client.query(
            'UPDATE trade_journal_templates SET template = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [JSON.stringify(normalizedTemplate), row.id]
          );
          console.log(`✓ Migrated template ${row.id} (user: ${row.user_id}, name: ${row.name})`);
          migrated++;
        } else {
          console.log(`- Skipped template ${row.id} (already normalized)`);
          skipped++;
        }
      } else {
        console.log(`- Skipped template ${row.id} (invalid format)`);
        skipped++;
      }
    }
    
    console.log(`\n✅ Migration complete!`);
    console.log(`   Migrated: ${migrated}`);
    console.log(`   Skipped: ${skipped}`);
    console.log(`   Total: ${result.rows.length}`);
    
  } catch (error) {
    console.error('❌ Error migrating templates:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run migration
migrateTemplates()
  .then(() => {
    console.log('Migration script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration script failed:', error);
    process.exit(1);
  });
