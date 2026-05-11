# AI Affiliate Automation Platform — Architecture

## System Overview

Production-grade multi-agent AI system for autonomous Amazon India deal discovery, analysis, and Telegram posting with WhatsApp ingestion support.

```
┌─────────────────────────────────────────────────────────────┐
│                    ORCHESTRATION LAYER                       │
│              (BullMQ Queues + Redis Streams)                 │
└──────────────────┬──────────────────────┬───────────────────┘
                   │                      │
        ┌──────────▼──────────┐  ┌───────▼────────┐
        │   DEAL DISCOVERY    │  │  WHATSAPP      │
        │   AGENT             │  │  INGESTION     │
        │   (Playwright)      │  │  AGENT         │
        └──────────┬──────────┘  └───────┬────────┘
                   │                      │
                   └──────────┬───────────┘
                              ▼
                   ┌─────────────────┐
                   │  DEAL ANALYSIS  │
                   │  AGENT (AI)     │
                   └────────┬────────┘
                            │
                   ┌────────▼────────┐
                   │ TELEGRAM POSTING│
                   │   AGENT         │
                   └─────────────────┘
```

## Agent Architecture

### Deal Discovery Agent
- **Trigger**: Cron (every 30 min)
- **Input**: Amazon India URLs
- **Output**: Raw deal objects → `deals` queue
- **Tech**: Playwright, proxy rotation ready
- **Scale**: 50 deals/source, deduplicated

### WhatsApp Ingestion Agent
- **Trigger**: Cron (every 10 min)
- **Input**: WhatsApp Web groups
- **Output**: Extracted ASINs → `deals` queue
- **Tech**: Playwright, session persistence
- **Note**: Requires headless=false for QR scan

### Deal Analysis Agent
- **Trigger**: BullMQ Worker on `deals` queue
- **Input**: Deal objects
- **Output**: Scored deals → `posts` queue (if hot/good)
- **AI**: Gemini API for quality boost, Ollama fallback
- **Logic**: Base scoring + AI enhancement

### Telegram Posting Agent
- **Trigger**: BullMQ Worker on `posts` queue
- **Input**: Scored deals
- **Output**: Channel posts
- **Rate Limit**: 2s between posts
- **Features**: Affiliate links, inline keyboards

## Data Flow

```
Amazon.in ──► Discovery ──► Redis Queue ──► Analysis ──► Redis Queue ──► Telegram
WhatsApp ───► Ingestion ──► (deals) ────► (AI Score) ──► (posts) ────► Channel
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20+ |
| Database | PostgreSQL + pgvector |
| Queue | Redis + BullMQ |
| Browser | Playwright |
| Bot API | Telegraf |
| AI | Gemini Pro / Ollama |
| Container | Docker + Compose |
| Monitor | Prometheus + Grafana |
| Schema | Zod |

## Database Schema

- **products**: Product catalog with metadata
- **price_history**: Time-series pricing
- **posted_deals**: Post audit log
- **whatsapp_ingestion**: Source tracking

## Scaling Strategy

### Phase 1: Single Instance
- Docker Compose on single host
- All agents co-located
- SQLite cache fallback

### Phase 2: Horizontal
- Kubernetes deployment
- Separate agent pools
- Dedicated scraping nodes

### Phase 3: Swarm
- Multi-region scraping
- AI model routing
- Distributed analytics

## Security

- Secrets in `.env` only
- No hardcoded credentials
- DB connections encrypted
- Redis AUTH ready
- Session file persistence

## Monitoring

### Metrics
- Deals discovered/hour
- Analysis queue depth
- Post success rate
- AI API latency
- Scraping error rate

### Alerts
- Queue backlog > 100
- Error rate > 10%
- Agent offline > 5min

## Cost Estimates

| Component | Monthly |
|-----------|---------|
| VPS (4GB) | $20 |
| Gemini API | $5-15 |
| Telegram | Free |
| Domain | $1 |
| **Total** | **$26-36** |

## File Structure

```
affiliate-platform/
├── agents/
│   ├── deal-discovery/
│   ├── deal-analysis/
│   ├── telegram-posting/
│   └── whatsapp-ingestion/
├── shared/
│   ├── utils/
│   └── types/
├── infrastructure/
│   ├── docker/
│   ├── db/
│   ├── grafana/
│   └── prometheus/
├── docker-compose.yml
└── .env