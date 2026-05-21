import { createStealthBrowser, createStealthContext, safeGoto, randomDelay } from './stealth-browser.js';
import { createLogger } from './logger.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const logger = createLogger('image-extractor');

// Cache directory for downloaded images
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', '..', 'cache', 'images');

// Ensure cache dir exists on startup
fs.mkdir(CACHE_DIR, { recursive: true }).catch(() => {});

// Ensure cache directory exists
async function ensureCacheDir() {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch (err) {
    logger.error('Failed to create cache directory', { error: err.message });
  }
}

/**
 * Extract the best quality image URL from Amazon product page HTML
 * Tries multiple strategies to find the highest resolution image
 */
export function extractBestImageUrl(htmlContent, asin) {
  try {
    // Strategy 1: Look for data-old-hires (highest quality direct image)
    const oldHiresMatch = htmlContent.match(/data-old-hires="([^"]+)"/);
    if (oldHiresMatch && oldHiresMatch[1] && !oldHiresMatch[1].includes('placeholder')) {
      logger.info(`Found data-old-hires image for ${asin}`);
      return oldHiresMatch[1];
    }

    // Strategy 2: Look for data-a-dynamic-image JSON (contains multiple resolutions)
    const dynamicImageMatch = htmlContent.match(/data-a-dynamic-image="({[^}]+})"/);
    if (dynamicImageMatch && dynamicImageMatch[1]) {
      try {
        // Decode HTML entities in the JSON string
        const jsonStr = dynamicImageMatch[1]
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&');
        
        const imageMap = JSON.parse(jsonStr);
        const urls = Object.keys(imageMap);
        
        if (urls.length > 0) {
          // Find the highest resolution image
          // URLs usually contain dimensions like _SL1500_, _SX1500_, etc.
          let bestUrl = urls[0];
          let bestSize = 0;
          
          for (const url of urls) {
            // Extract dimension from URL (e.g., _SL1500_ -> 1500)
            const sizeMatch = url.match(/_(?:SL|SX|SY)(\d+)_/);
            if (sizeMatch) {
              const size = parseInt(sizeMatch[1]);
              if (size > bestSize) {
                bestSize = size;
                bestUrl = url;
              }
            }
          }
          
          logger.info(`Found dynamic image ${bestSize}px for ${asin}`);
          return bestUrl;
        }
      } catch (parseErr) {
        logger.warn(`Failed to parse dynamic image JSON for ${asin}`, { error: parseErr.message });
      }
    }

    // Strategy 3: Look for landingImage src
    const landingImageMatch = htmlContent.match(/id="landingImage"[^>]*src="([^"]+)"/);
    if (landingImageMatch && landingImageMatch[1]) {
      logger.info(`Found landingImage src for ${asin}`);
      return landingImageMatch[1];
    }

    // Strategy 4: Look for any high-res image in the image block
    // Tightened regex to avoid matching massive HTML chunks with escaped quotes
    const imageBlockMatch = htmlContent.match(/https:\/\/m\.media-amazon\.com\/images\/[A-Za-z0-9\/+%_-]+_(?:SL|SX|SY)\d+_[A-Za-z0-9+%_-]*\.(?:jpg|jpeg|png|webp)/);
    if (imageBlockMatch && imageBlockMatch[0]) {
      logger.info(`Found image block URL for ${asin}`);
      return imageBlockMatch[0];
    }

    // Strategy 5: Look for hiRes image in image data
    const hiResMatch = htmlContent.match(/"hiRes"\s*:\s*"([^"]+)"/);
    if (hiResMatch && hiResMatch[1]) {
      logger.info(`Found hiRes image for ${asin}`);
      return hiResMatch[1];
    }

    logger.warn(`Could not extract image URL for ${asin}`);
    return null;
  } catch (err) {
    logger.error(`Error extracting image URL for ${asin}`, { error: err.message });
    return null;
  }
}

// ── Singleton browser for image extraction ──
// Avoids launching a new Chromium process per image (each is ~500MB RAM)
let sharedBrowser = null;

async function getSharedBrowser() {
  if (!sharedBrowser || !sharedBrowser.isConnected()) {
    sharedBrowser = await createStealthBrowser();
    logger.info('Shared image-extraction browser launched');
  }
  return sharedBrowser;
}

export async function closeSharedBrowser() {
  if (sharedBrowser) {
    await sharedBrowser.close().catch(() => {});
    sharedBrowser = null;
    logger.info('Shared image-extraction browser closed');
  }
}

/**
 * Fetch product page and extract the best quality image URL
 * Uses a shared browser instance to avoid per-call Chromium launches
 */
export async function fetchProductImageUrl(productUrl, asin) {
  let context = null;
  
  try {
    logger.info(`Fetching product page for image extraction`, { asin, url: productUrl });
    
    const browser = await getSharedBrowser();
    context = await createStealthContext(browser);
    const page = await context.newPage();
    
    // Navigate to product page — use domcontentloaded (networkidle times out on Amazon)
    await safeGoto(page, productUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    
    // Brief wait for images to appear in DOM
    await randomDelay(1000, 2000);
    
    // Get page content
    const htmlContent = await page.content();
    
    // Extract best image URL
    const imageUrl = extractBestImageUrl(htmlContent, asin);
    
    await context.close();
    
    return imageUrl;
  } catch (err) {
    logger.error(`Failed to fetch product image`, { asin, error: err.message });
    if (context) await context.close().catch(() => {});
    return null;
  }
}

/**
 * Download image and cache it locally
 * Returns the local file path
 */
export async function downloadAndCacheImage(imageUrl, asin) {
  try {
    await ensureCacheDir();
    
    const ext = path.extname(new URL(imageUrl).pathname) || '.jpg';
    const filename = `${asin}${ext}`;
    const filepath = path.join(CACHE_DIR, filename);
    
    // Check if already cached
    try {
      await fs.access(filepath);
      logger.info(`Using cached image for ${asin}`);
      return filepath;
    } catch {
      // Not cached, download it
    }
    
    logger.info(`Downloading image for ${asin}`, { url: imageUrl });
    
    // Use fetch to download the image
    const response = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer': 'https://www.amazon.in/',
      },
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const buffer = await response.arrayBuffer();
    await fs.writeFile(filepath, Buffer.from(buffer));
    
    logger.info(`Image cached for ${asin}`, { size: buffer.byteLength, path: filepath });
    return filepath;
  } catch (err) {
    logger.error(`Failed to download image`, { asin, error: err.message });
    return null;
  }
}

/**
 * Get high-quality image for a product
 * Tries to fetch from product page, falls back to provided imageUrl
 */
export async function getHighQualityImage(productUrl, asin, fallbackImageUrl = null) {
  // Try to extract from product page first
  const extractedUrl = await fetchProductImageUrl(productUrl, asin);
  
  if (extractedUrl) {
    // Download and cache the high-quality image
    const cachedPath = await downloadAndCacheImage(extractedUrl, asin);
    if (cachedPath) {
      return { url: extractedUrl, localPath: cachedPath, source: 'extracted' };
    }
    // If download failed, return the URL anyway (Telegram can fetch from URL)
    return { url: extractedUrl, localPath: null, source: 'extracted' };
  }
  
  // Fall back to provided image URL
  if (fallbackImageUrl) {
    const cachedPath = await downloadAndCacheImage(fallbackImageUrl, asin);
    if (cachedPath) {
      return { url: fallbackImageUrl, localPath: cachedPath, source: 'fallback' };
    }
    return { url: fallbackImageUrl, localPath: null, source: 'fallback' };
  }
  
  return null;
}

/**
 * Clean up old cached images (older than 7 days)
 */
export async function cleanupOldImages(maxAgeDays = 7) {
  try {
    const files = await fs.readdir(CACHE_DIR);
    const now = Date.now();
    const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;
    
    let cleaned = 0;
    for (const file of files) {
      const filepath = path.join(CACHE_DIR, file);
      const stats = await fs.stat(filepath);
      
      if (now - stats.mtime.getTime() > maxAge) {
        await fs.unlink(filepath);
        cleaned++;
      }
    }
    
    logger.info(`Cleaned up ${cleaned} old cached images`);
  } catch (err) {
    logger.error('Failed to cleanup old images', { error: err.message });
  }
}
