import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({
  user: process.env.DB_USER || "affiliate_user",
  host: process.env.DB_HOST || "postgres",
  database: process.env.DB_NAME || "affiliate_platform",
  password: process.env.DB_PASSWORD,
  port: Number(process.env.DB_PORT) || 5432,
});

async function run() {
  const res = await pool.query("SELECT asin, title, price, mrp, discount_pct FROM products WHERE title ILIKE '%Acer%' OR title ILIKE '%Vivobook%'");
  console.log(res.rows);
  pool.end();
}
run();
