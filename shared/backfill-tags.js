import pg from 'pg';
import axios from 'axios';

// Use Docker internal hostname — this runs INSIDE a container
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'postgres',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'affiliate_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'affiliate_platform',
});

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://host.docker.internal:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b';

async function callOllama(prompt) {
  try {
    const res = await axios.post(`${OLLAMA_HOST}/api/generate`, {
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
    }, { timeout: 30000 });
    return res.data?.response?.trim() || null;
  } catch (e) {
    console.error(`  Ollama error: ${e.message}`);
    return null;
  }
}

async function main() {
  console.log('Ensuring semantic_tags column exists...');
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS semantic_tags TEXT;`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_products_semantic_tags_gin
    ON products USING gin(to_tsvector('english', COALESCE(semantic_tags, '')));
  `);
  console.log('Column ready.\n');

  // Get ALL products to regenerate tags
  const result = await pool.query(`SELECT asin, title, category FROM products`);
  const products = result.rows;
  console.log(`Found ${products.length} products to tag.\n`);

  if (products.length === 0) {
    console.log('No products found!');
    await pool.end();
    process.exit(0);
  }

  let success = 0;

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const shortTitle = (p.title || '').substring(0, 60).replace(/\n/g, ' ');
    console.log(`[${i + 1}/${products.length}] ${shortTitle}...`);

    const prompt = `Generate a single line of space-separated semantic keywords for this product so users can easily find it via search.
Product: ${p.title}
Category: ${p.category || 'General'}

INCLUDE:
- Broad category (e.g., smartphone, appliance)
- Synonyms (e.g., earbuds, tws, airdopes)
- Key features/specs (e.g., 5g, 128gb, 8gb ram, amoled, wireless, fast charging)

Respond with ONLY the space-separated string of words, no explanation, no bullet points, no JSON, no punctuation.`;

    const raw = await callOllama(prompt);

    if (raw) {
      const tags = raw.replace(/[\[\]{}"':,.\n\r]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
      if (tags.length >= 3) {
        await pool.query('UPDATE products SET semantic_tags = $1 WHERE asin = $2', [tags, p.asin]);
        console.log(`  -> ${tags}\n`);
        success++;
      } else {
        console.log(`  -> Skipped (too short)\n`);
      }
    } else {
      console.log(`  -> Failed\n`);
    }

    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\nDone! Tagged ${success}/${products.length} products.`);
  await pool.end();
  process.exit(0);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
