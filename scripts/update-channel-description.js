import 'dotenv/config';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

const DESCRIPTION = `🔥 India's Smartest Deal Finder — Amazon & more
📊 Every deal is price-verified with history
💰 Save up to 80% on top brands daily
⏰ Fresh deals 8AM - 11PM IST

🏷️ Browse by category:
#TechLoot #MobileDeal #LaptopDeal #AudioDeal
#FashionDeal #BeautySteal #KitchenDeal
#FitnessDeal #GymGear #HomeSmart
#BookDeal #GroceryDeal #GamingDeal

💸 Browse by price:
#Under99 #Under199 #Under299 #Under399
#Under499 #Under599 #Under799 #Under999
#Under1499 #Under2K #Under3K #Under5K

🔥 Deal types:
#MegaDeal #HalfPrice #PriceDrop #LightningDeal
#FlashSale #GreatSummerSale #DealOfTheDay

🤖 Powered by DealDecode AI`;

async function updateChannel() {
  // 1. Update channel description
  console.log('Updating channel description...');
  const descRes = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/setChatDescription`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHANNEL_ID,
        description: DESCRIPTION,
      }),
    }
  );
  const descData = await descRes.json();
  console.log('Description update:', descData.ok ? '✅ Success' : `❌ ${descData.description}`);

  // 2. Post a pinned welcome message
  const WELCOME_POST = `🎯 <b>Welcome to DealDecode India!</b>

Yahan pe sirf <b>verified deals</b> milenge — no spam, no fake discounts.

📱 <b>Browse by category:</b>
#TechLoot — Phones, Laptops, Gadgets
#AudioDeal — Earbuds, Headphones, Speakers
#FashionDeal — Clothing, Shoes, Accessories
#BeautySteal — Skincare, Haircare, Perfumes
#KitchenDeal — Appliances, Cookware
#FitnessDeal #GymGear — Workout essentials
#HomeSmart — Lights, Decor, Storage
#BookDeal — Books at crazy prices
#GroceryDeal — Daily needs & pantry

💸 <b>Browse by price:</b>
#Under99 · #Under199 · #Under299 · #Under399
#Under499 · #Under599 · #Under799 · #Under999
#Under1499 · #Under2K · #Under3K · #Under5K

🔥 <b>Deal types:</b>
#MegaDeal — 70%+ off
#HalfPrice — 50%+ off
#PriceDrop — Price just dropped!
#LightningDeal — Limited time only
#GreatSummerSale — Summer sale specials

⚡ Deals refresh every 30 minutes. Turn on notifications! 🔔

<i>Happy saving! 💰</i>`;

  console.log('\nPosting welcome message...');
  const msgRes = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHANNEL_ID,
        text: WELCOME_POST,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    }
  );
  const msgData = await msgRes.json();

  if (msgData.ok) {
    console.log('Welcome message posted: ✅');
    
    // 3. Pin the welcome message
    const messageId = msgData.result.message_id;
    console.log('Pinning message...');
    const pinRes = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/pinChatMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHANNEL_ID,
          message_id: messageId,
          disable_notification: true,
        }),
      }
    );
    const pinData = await pinRes.json();
    console.log('Pin:', pinData.ok ? '✅ Pinned!' : `❌ ${pinData.description}`);
  } else {
    console.log('Message failed:', msgData.description);
  }

  console.log('\n✅ Channel setup complete!');
}

updateChannel().catch(console.error);
