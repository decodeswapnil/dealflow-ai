# AI Affiliate Automation Platform

Autonomous multi-agent system for Amazon India deal discovery and Telegram posting.

## Quick Start

```bash
# 1. Clone and configure
cp .env.template .env
# Edit .env with your credentials

# 2. Start infrastructure
docker compose up -d postgres redis

# 3. Install shared dependencies
cd shared && npm install && cd ..

# 4. Start agents
docker compose up -d deal-discovery deal-analysis telegram-posting

# 5. Start WhatsApp (optional, requires QR scan)
docker compose --profile whatsapp up whatsapp-ingestion
```

## Configuration

Required environment variables:
- `DB_PASSWORD` — PostgreSQL password
- `TELEGRAM_BOT_TOKEN` — From @BotFather
- `TELEGRAM_CHANNEL_ID` — Channel username or ID
- `AMAZON_ASSOCIATE_TAG` — Your Amazon affiliate tag
- `GEMINI_API_KEY` — For AI analysis (optional but recommended)

## Agent Commands

```bash
# View logs
docker compose logs -f deal-analysis

# Restart agent
docker compose restart deal-discovery

# Scale analysis workers
docker compose up -d --scale deal-analysis=3

# Monitor queues
redis-cli LLEN bull:deals:wait
redis-cli LLEN bull:posts:wait
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for full system design.

## Phases

| Phase | Features | Status |
|-------|----------|--------|
| MVP | Discovery → Analysis → Posting | ✅ |
| WhatsApp | Group ingestion | ✅ |
| Analytics | Dashboard + metrics | 🔄 |
| Swarm | Multi-agent orchestration | 📋 |