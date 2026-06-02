#!/usr/bin/env node
import 'dotenv/config';
import { createQueue } from '../shared/utils/redis.js';

const postQueue = createQueue('posts');

// Create a test deal with good score to trigger automatic posting
const testDeal = {
  asin: 'B0TEST12345',
  title: 'Test Product - Wireless Earbuds with 50 Hours Playtime',
  price: 999,
  mrp: 2999,
  discountPct: 67,
  rating: 4.3,
  reviewCount: 1250,
  imageUrl: 'https://m.media-amazon.com/images/I/61CGHv6kmWL._AC_UL320_.jpg',
  productUrl: 'https://www.amazon.in/dp/B0TEST12345',
  affiliateUrl: 'https://www.amazon.in/dp/B0TEST12345?tag=yourtag-21&linkCode=ll1&ref=as_li_ss_tl',
  category: 'electronics',
  source: 'test'
};

const testScore = {
  asin: 'B0TEST12345',
  score: 6.5,
  verdict: 'hot',
  factors: {
    discountWeight: 0.9,
    historicalWeight: 0.8,
    ratingWeight: 0.7,
    socialWeight: 0.6
  },
  metadata: {
    fakeDiscountDetected: false,
    fakeDiscountConfidence: 0,
    priceTrend: 'decreasing',
    realDiscount: 67
  }
};

console.log('🧪 Testing automatic posting...');
console.log('📦 Creating test deal with HOT verdict (score: 6.5)');
console.log('⏰ Current time:', new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }));

try {
  // Queue the deal for posting (simulating what deal-analysis does)
  await postQueue.add('create-post', {
    deal: testDeal,
    score: testScore
  }, {
    priority: 1 // High priority for hot deals
  });

  console.log('✅ Test deal queued successfully!');
  console.log('📱 Check your Telegram channel in a few seconds...');
  console.log('🔍 Monitor logs: docker logs affiliate-platform-telegram-posting-1 -f');
  
  process.exit(0);
} catch (err) {
  console.error('❌ Error:', err.message);
  process.exit(1);
}
