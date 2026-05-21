import { chromium } from 'playwright';
import { createLogger } from './logger.js';

const logger = createLogger('stealth-browser');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
];

const DEVICE_TYPES = ['desktop', 'mobile'];

const MOBILE_USER_AGENTS = [
  'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
];

const MOBILE_VIEWPORTS = [
  { width: 375, height: 667 },
  { width: 414, height: 896 },
  { width: 360, height: 640 },
];

function getRandomFingerprint() {
  const isMobile = Math.random() > 0.7; // 30% mobile
  
  if (isMobile) {
    return {
      userAgent: MOBILE_USER_AGENTS[Math.floor(Math.random() * MOBILE_USER_AGENTS.length)],
      viewport: MOBILE_VIEWPORTS[Math.floor(Math.random() * MOBILE_VIEWPORTS.length)],
      deviceScaleFactor: 2 + Math.floor(Math.random() * 2), // 2-3
      isMobile: true,
      hasTouch: true,
    };
  }
  
  return {
    userAgent: USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    viewport: VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)],
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  };
}

export async function createStealthBrowser() {
  logger.info('Launching stealth browser');
  
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  
  if (executablePath) {
    logger.info(`Using system Chromium at ${executablePath}`);
  }
  
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });
  
  return browser;
}

export async function createStealthContext(browser) {
  const fingerprint = getRandomFingerprint();
  
  logger.info('Creating stealth context with fingerprint', {
    userAgent: fingerprint.userAgent.substring(0, 50) + '...',
    viewport: fingerprint.viewport,
    isMobile: fingerprint.isMobile,
  });
  
  const context = await browser.newContext({
    userAgent: fingerprint.userAgent,
    viewport: fingerprint.viewport,
    deviceScaleFactor: fingerprint.deviceScaleFactor,
    isMobile: fingerprint.isMobile,
    hasTouch: fingerprint.hasTouch,
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    permissions: ['geolocation'],
    geolocation: { latitude: 28.6139, longitude: 77.2090 }, // Delhi
    javaScriptEnabled: true,
    bypassCSP: false,
    extraHTTPHeaders: {
      'Accept-Language': 'en-IN,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'max-age=0',
    },
  });
  
  // Add stealth scripts to mask automation
  await context.addInitScript(() => {
    // Override navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
    
    // Override permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' 
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters)
    );
    
    // Mask plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
        { name: 'Native Client', filename: 'internal-nacl-plugin' },
      ],
    });
    
    // Mask languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-IN', 'en', 'hi'],
    });
    
    // Override chrome runtime
    window.chrome = { runtime: {} };
    
    // Override notification permission
    const originalNotification = window.Notification;
    Object.defineProperty(window, 'Notification', {
      get: () => originalNotification,
      set: (val) => {},
    });
  });
  
  return context;
}

export async function humanLikeScroll(page) {
  const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  
  let currentPosition = 0;
  const scrollStep = 100 + Math.floor(Math.random() * 200); // 100-300px
  const scrollDelay = 50 + Math.floor(Math.random() * 150); // 50-200ms
  let maxScrolls = 30; // Guard against infinite scroll on lazy-loaded pages
  
  while (currentPosition < scrollHeight - viewportHeight && maxScrolls-- > 0) {
    currentPosition += scrollStep;
    await page.evaluate((pos) => window.scrollTo(0, pos), currentPosition);
    await page.waitForTimeout(scrollDelay);
    
    // Random pause
    if (Math.random() > 0.7) {
      await page.waitForTimeout(500 + Math.floor(Math.random() * 1000));
    }
  }
  
  // Scroll back up sometimes
  if (Math.random() > 0.5) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
  }
}

export async function humanLikeMouseMove(page) {
  const points = [];
  const numPoints = 3 + Math.floor(Math.random() * 5);
  
  for (let i = 0; i < numPoints; i++) {
    points.push({
      x: Math.floor(Math.random() * 800),
      y: Math.floor(Math.random() * 600),
    });
  }
  
  for (const point of points) {
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(50 + Math.floor(Math.random() * 200));
  }
}

export async function randomDelay(min = 1000, max = 3000) {
  const delay = min + Math.floor(Math.random() * (max - min));
  await new Promise(resolve => setTimeout(resolve, delay));
}

export async function safeGoto(page, url, options = {}) {
  const maxRetries = 3;
  let lastError;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      logger.info(`Navigating to ${url} (attempt ${i + 1}/${maxRetries})`);
      
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
        ...options,
      });
      
      if (response && response.status() >= 400) {
        throw new Error(`HTTP ${response.status()}`);
      }
      
      // Wait for page to settle
      await page.waitForTimeout(1000 + Math.floor(Math.random() * 2000));
      
      // Check for anti-bot indicators
      const title = await page.title().catch(() => '');
      const url_after = page.url();
      
      if (title.includes('Robot Check') || title.includes('CAPTCHA')) {
        throw new Error('Anti-bot detected');
      }
      
      if (url_after.includes('signin') || url_after.includes('ap/signin')) {
        logger.warn('Redirected to signin page, continuing anyway');
      }
      
      logger.info(`Successfully loaded ${url}`);
      return response;
      
    } catch (error) {
      lastError = error;
      logger.warn(`Navigation attempt ${i + 1} failed`, { error: error.message });
      
      if (i < maxRetries - 1) {
        const backoffDelay = (i + 1) * 5000 + Math.floor(Math.random() * 5000);
        logger.info(`Waiting ${backoffDelay}ms before retry`);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
      }
    }
  }
  
  throw new Error(`Failed to navigate to ${url} after ${maxRetries} attempts: ${lastError.message}`);
}

export async function closeBrowser(browser) {
  if (browser) {
    await browser.close();
    logger.info('Browser closed');
  }
}
