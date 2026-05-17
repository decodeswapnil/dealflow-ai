-- Semantic Search Schema Update
-- Add semantic_tags column to products table
ALTER TABLE products ADD COLUMN IF NOT EXISTS semantic_tags TEXT;

-- Create GIN index for Full-Text Search on title and tags
CREATE INDEX IF NOT EXISTS idx_products_fts 
ON products USING GIN (to_tsvector('english', title || ' ' || COALESCE(semantic_tags, '')));
