-- Add bank_offers column to products table
ALTER TABLE products ADD COLUMN IF NOT EXISTS bank_offers TEXT;
