import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'affiliate_platform',
  user: process.env.DB_USER || 'affiliate_user',
  password: process.env.DB_PASSWORD,
});

async function migrate() {
  const client = await pool.connect();
  try {
    // Check current schema
    const cols = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'posted_deals' ORDER BY ordinal_position
    `);
    console.log('Current posted_deals columns:', cols.rows.map(r => r.column_name).join(', '));
    
    // Add missing columns
    const migrations = [
      { col: 'message_id', sql: `ALTER TABLE posted_deals ADD COLUMN IF NOT EXISTS message_id BIGINT` },
      { col: 'engagement_views', sql: `ALTER TABLE posted_deals ADD COLUMN IF NOT EXISTS engagement_views INTEGER DEFAULT 0` },
      { col: 'engagement_clicks', sql: `ALTER TABLE posted_deals ADD COLUMN IF NOT EXISTS engagement_clicks INTEGER DEFAULT 0` },
      { col: 'bank_offers', sql: `ALTER TABLE products ADD COLUMN IF NOT EXISTS bank_offers TEXT` },
    ];
    
    for (const m of migrations) {
      try {
        await client.query(m.sql);
        console.log(`✅ Added/verified column: ${m.col}`);
      } catch (err) {
        console.log(`⚠️ ${m.col}: ${err.message}`);
      }
    }
    
    // Create index on message_id if missing
    try {
      await client.query(`CREATE INDEX IF NOT EXISTS idx_posted_deals_message_id ON posted_deals(message_id) WHERE message_id IS NOT NULL`);
      console.log('✅ Index on message_id created/verified');
    } catch (err) {
      console.log(`⚠️ Index: ${err.message}`);
    }
    
    // Verify final schema
    const finalCols = await client.query(`
      SELECT column_name, data_type FROM information_schema.columns 
      WHERE table_name = 'posted_deals' ORDER BY ordinal_position
    `);
    console.log('\nFinal posted_deals schema:');
    finalCols.rows.forEach(r => console.log(`  ${r.column_name}: ${r.data_type}`));
    
    console.log('\n✅ Migration complete!');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
