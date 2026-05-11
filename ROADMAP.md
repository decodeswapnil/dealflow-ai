# Execution Roadmap — AI Affiliate Automation Platform

## Phase 1: MVP (✅ COMPLETED)

### Delivered
- [x] Multi-agent architecture with BullMQ orchestration
- [x] Deal Discovery Agent (Playwright scraping)
- [x] Deal Analysis Agent (Base scoring + AI boost with Gemini/Ollama)
- [x] Telegram Posting Agent (Auto-posting with affiliate links)
- [x] WhatsApp Ingestion Agent (Web automation + ASIN extraction)
- [x] PostgreSQL + pgvector database schema
- [x] Redis + BullMQ queue system
- [x] Docker Compose orchestration
- [x] Shared utilities (logging, DB, Redis, Zod schemas)
- [x] Architecture documentation

### Quick Start
```bash
cp .env.template .env
# Edit .env with your keys
cd shared && npm install && cd ..
docker compose up -d postgres redis deal-discovery deal-analysis telegram-posting
```

---

## Phase 2: WhatsApp + Analytics (NEXT)

### Week 1-2: WhatsApp Hardening
- [ ] QR code scan workflow documentation
- [ ] Session reliability (re-auth handling)
- [ ] Image OCR for deal screenshots
- [ ] Multi-group support with rate limiting
- [ ] Duplicate detection improvements

### Week 2-3: Monitoring Stack
- [ ] Prometheus metrics collection from agents
- [ ] Grafana dashboards (deals, queue depth, success rates)
- [ ] Alertmanager alerts (queue backlog, error spikes)
- [ ] Agent health check endpoints

---

## Phase 3: AI Enhancement (HIGH PRIORITY)

### Week 3-5: Model Strategy
- [ ] Integrate DeepSeek R1 for reasoning/planning
- [ ] Integrate Kimi K2.6 for execution workflows
- [ ] Hybrid routing (cheap model first, expensive fallback)
- [ ] Local Ollama optimization (Qwen, DeepSeek Coder)
- [ ] Caption A/B testing with engagement tracking
- [ ] Virality prediction model

### Week 5-6: Price Intelligence
- [ ] Keepa API integration or alternative
- [ ] Historical price charts in Telegram posts
- [ ] "Fake discount" detection algorithms
- [ ] Lightning deal prediction

---

## Phase 4: Scale & Swarm (FUTURE)

### Week 6-8: Multi-Agent Swarm
- [ ] CrewAI / LangGraph orchestration layer
- [ ] Agent specialization (niche categories)
- [ ] Dynamic task delegation
- [ ] Cross-agent memory sharing
- [ ] Conflict resolution between agents

### Week 8-10: Platform Scale
- [ ] Kubernetes deployment manifests
- [ ] Multi-channel Telegram support
- [ ] Category-based channel routing
- [ ] A/B testing framework
- [ ] Revenue analytics dashboard

### Week 10-12: Autonomy
- [ ] Self-healing agents (auto-restart, circuit breakers)
- [ ] Auto-scaling based on deal volume
- [ ] ML-based posting time optimization
- [ ] Competitor analysis agent
- [ ] Automatic deal source discovery

---

## Immediate Action Items

1. **Configure Environment**: Fill in `.env` with real credentials
2. **Test Discovery**: Run deal-discovery locally, verify ASIN extraction
3. **Setup Telegram**: Create bot via @BotFather, add to channel
4. **Amazon Affiliate**: Get associate tag from Amazon India
5. **AI Setup**: Get Gemini API key (free tier available)
6. **First Post**: Verify end-to-end flow works
7. **WhatsApp**: Run `docker compose --profile whatsapp up` and scan QR

---

## Cost Projections

| Phase | Infra | AI APIs | Total/Month |
|-------|-------|---------|-------------|
| MVP | $20 VPS | $0-15 | $20-35 |
| +Analytics | $25 | $15 | $40 |
| +AI Scale | $40 | $50-100 | $90-140 |
| Swarm | $100+ | $200+ | $300+ |

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Amazon blocking scraper | High | High | Proxy rotation, rate limiting, user-agent rotation |
| WhatsApp account ban | Medium | High | Secondary backup account, minimal automation |
| Telegram rate limits | Low | Medium | Exponential backoff, queue management |
| AI API costs | Medium | Low | Local fallback, caching, batching |
| Fake deal reputation | Medium | High | Strict scoring, human verification layer |
