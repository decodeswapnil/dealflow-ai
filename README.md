# 🤖 DealFlow AI

**Autonomous Multi-Agent System for Real-Time E-Commerce Deal Intelligence**

An AI-powered pipeline that discovers, scores, and publishes high-value e-commerce deals to Telegram — fully autonomously, 24/7. Built with a multi-agent architecture where each agent specializes in one job, communicating through Redis queues.

[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-pgvector-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-BullMQ-DC382D?logo=redis&logoColor=white)](https://redis.io/)
[![Gemini](https://img.shields.io/badge/Gemini-AI_Scoring-4285F4?logo=google&logoColor=white)](https://ai.google.dev/)

---

## Why This Exists

Running an affiliate deals channel is repetitive, time-consuming work: scrape deals → analyze quality → write captions → post at the right time → repeat forever. This system replaces the entire workflow with specialized AI agents that coordinate autonomously.

**The result**: A Telegram channel that runs itself, posting only high-quality deals with AI-written captions and smart scheduling.

---

## Architecture

```
  ┌─────────────────────────────────────────────────────────┐
  │                  ORCHESTRATION LAYER                     │
  │            (BullMQ Queues + Redis Streams)               │
  └────────────┬──────────────────────┬─────────────────────┘
               │                      │
    ┌──────────▼──────────┐  ┌───────▼────────┐
    │   DEAL DISCOVERY    │  │  WHATSAPP      │
    │   AGENT             │  │  INGESTION     │
    │   (Playwright)      │  │  AGENT         │
    └──────────┬──────────┘  └───────┬────────┘
               │                      │
               └──────────┬───────────┘
                          ▼
               ┌─────────────────────┐
               │   DEAL ANALYSIS     │
               │   AGENT (AI)        │
               └──────────┬──────────┘
                          │
               ┌──────────▼──────────┐
               │  TELEGRAM POSTING   │
               │  AGENT              │
               └─────────────────────┘
```

### Agent Breakdown

| Agent | Trigger | Job | Key Tech |
|-------|---------|-----|----------|
| **Deal Discovery** | Cron (30 min) | Scrapes Amazon India for live deals, extracts pricing, discounts, metadata | Playwright, proxy-ready |
| **WhatsApp Ingestion** | Cron (10 min) | Monitors WhatsApp groups for deal links, extracts ASINs | Playwright, session persistence |
| **Deal Analysis** | Queue worker | AI-scores deals on quality, value, urgency. Filters out noise | Gemini 2.0 Flash, Ollama fallback |
| **Telegram Posting** | Queue worker | Generates captions, attaches affiliate links, posts to channel | node-telegram-bot-api, rate-limited |
| **Curated Lists** | Cron (4 hrs) | Scrapes bestseller/most-gifted lists, creates themed roundups | Playwright, Gemini |

---

## Tech Stack

| Layer | Technology | Why |
|-------|------------|-----|
| **Runtime** | Node.js 20+ | Non-blocking I/O for concurrent scraping |
| **Database** | PostgreSQL (pgvector image) | Product catalog, price history, full-text search over titles + semantic tags |
| **Queue** | Redis + BullMQ | Reliable job queues with retry, backoff, priorities |
| **Scraping** | Playwright | Headless browser for JS-rendered pages |
| **AI** | Gemini 2.0 Flash → OpenRouter → Ollama | Multi-tier AI with automatic fallback chain |
| **Bot** | node-telegram-bot-api | Channel posting, photo/voice messages, message edits |
| **Container** | Docker Compose | One-command deployment, per-agent memory limits |
| **Monitoring** | Prometheus + Grafana | Real-time dashboards, alerting |
| **Validation** | Zod | Runtime type safety for deal objects |

---

## Quick Start

```bash
# 1. Clone and configure
git clone https://github.com/decodeswapnil/dealflow-ai.git
cd dealflow-ai
cp .env.template .env
# Edit .env with your credentials (see Configuration below)

# 2. Install shared dependencies
cd shared && npm install && cd ..

# 3. Start infrastructure + agents
docker compose up -d

# 4. Monitor
docker compose logs -f deal-analysis
```

## Configuration

Copy `.env.template` to `.env` and fill in:

| Variable | Description | Required |
|----------|-------------|----------|
| `DB_PASSWORD` | PostgreSQL password | ✅ |
| `TELEGRAM_BOT_TOKEN` | From [@BotFather](https://t.me/BotFather) | ✅ |
| `TELEGRAM_CHANNEL_ID` | Channel username (e.g., `@mychannel`) | ✅ |
| `AMAZON_ASSOCIATE_TAG` | Amazon India affiliate tag | ✅ |
| `GEMINI_API_KEY` | Google AI API key ([free tier](https://ai.google.dev/)) | Recommended |
| `OPENROUTER_API_KEY` | OpenRouter fallback | Optional |
| `OLLAMA_HOST` | Local Ollama instance | Optional |

---

## AI Strategy

The system uses a **cascading AI fallback chain** to balance cost and quality:

```
Gemini 2.0 Flash (primary) → OpenRouter GPT-4o-mini (fallback) → Ollama local (offline)
```

Each deal gets:
- **Base score**: Computed from discount %, price, category, urgency signals
- **AI boost**: Gemini analyzes deal quality, generates engagement-optimized captions
- **Revenue scoring**: Factors in commission rates and conversion probability
- **A/B testing**: Multiple caption variants tested for engagement
- **Dedup**: Redis ASIN cache with a 24h TTL stops the same deal being posted twice

---

## Scaling

| Phase | Infrastructure | Status |
|-------|---------------|--------|
| **MVP** | Docker Compose, single host | ✅ Completed |
| **Horizontal** | Kubernetes, dedicated scraping nodes | 🔄 Planned |
| **Swarm** | Multi-region, AI model routing, distributed analytics | 📋 Roadmap |

---

## Commands

```bash
# View agent logs
docker compose logs -f deal-analysis

# Restart a specific agent
docker compose restart deal-discovery

# Scale analysis workers
docker compose up -d --scale deal-analysis=3

# Monitor queue depth
redis-cli LLEN bull:deals:wait
redis-cli LLEN bull:posts:wait

# Start WhatsApp (requires QR scan)
docker compose --profile whatsapp up whatsapp-ingestion
```

---

## Project Structure

```
dealflow-ai/
├── agents/
│   ├── deal-discovery/       # Amazon scraper agent
│   ├── deal-analysis/        # AI scoring + filtering
│   ├── telegram-posting/     # Channel posting + captions
│   ├── curated-lists/        # Bestseller roundups
│   ├── whatsapp-ingestion/   # WhatsApp deal extraction
│   ├── affiliate-system/     # Commission tracking
│   ├── quality-control/      # Post quality validation
│   └── scheduler/            # Cron orchestration
├── shared/                   # Shared utils, DB, Redis, Zod schemas
├── infrastructure/
│   ├── docker/               # Dockerfiles per agent
│   ├── db/                   # Database init scripts
│   ├── grafana/              # Dashboard configs
│   └── prometheus/           # Metrics collection
├── scripts/                  # Migration, cleanup, testing tools
├── docker-compose.yml        # Full orchestration
└── .env.template             # Configuration reference
```

---

## License

MIT

---

*Built by [@decodeswapnil](https://github.com/decodeswapnil)*