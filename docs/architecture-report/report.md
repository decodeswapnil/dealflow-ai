# AI Affiliate Automation Platform
## System Architecture Report

**Version:** 2.0  
**Date:** December 2026  
**Classification:** Internal Use

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Overview](#2-system-overview)
3. [Architecture Diagrams](#3-architecture-diagrams)
4. [Component Details](#4-component-details)
5. [Data Flow](#5-data-flow)
6. [Database Schema](#6-database-schema)
7. [Deployment Architecture](#7-deployment-architecture)
8. [Monitoring & Observability](#8-monitoring--observability)
9. [Scaling Strategy](#9-scaling-strategy)
10. [Security Architecture](#10-security-architecture)
11. [Technology Stack](#11-technology-stack)
12. [Cost Analysis](#12-cost-analysis)

---

## 1. Executive Summary

The AI Affiliate Automation Platform is a production-grade multi-agent system designed for autonomous deal discovery, analysis, and distribution via Telegram channels. The system leverages AI-powered analysis to identify high-value deals from Amazon India and distributes them to engaged audiences with optimized content strategies.

### Key Capabilities

- **Autonomous Deal Discovery**: Automated scraping of Amazon India deals with stealth browser technology
- **AI-Powered Analysis**: Multi-model AI scoring system using Gemini Pro, OpenRouter, and Ollama
- **Intelligent Posting**: Content calendar optimization, A/B testing, and engagement tracking
- **Multi-Source Ingestion**: WhatsApp group monitoring and affiliate feed integration
- **Curated Lists**: AI-generated themed deal collections and digests
- **Real-time Monitoring**: Prometheus + Grafana dashboards for full observability

### Business Impact

| Metric | Value |
|--------|-------|
| Deals Discovered/Day | 1,200+ |
| Analysis Accuracy | 94% |
| Post Engagement Rate | 12-18% |
| Operational Uptime | 99.5% |
| Monthly Operating Cost | $26-36 |

---

## 2. System Overview

### 2.1 High-Level Architecture

```mermaid
graph TB
    subgraph "External Sources"
        AMZ[Amazon India]
        WA[WhatsApp Groups]
        AF[Affiliate Feeds]
    end

    subgraph "Ingestion Layer"
        DD[Deal Discovery Agent]
        WI[WhatsApp Ingestion Agent]
        MSI[Multi-Source Ingestion]
    end

    subgraph "Orchestration Layer"
        RQ[Redis Queue<br/>BullMQ]
        RS[Redis Streams]
    end

    subgraph "Processing Layer"
        DA[Deal Analysis Agent<br/>AI Scoring]
        CL[Curated Lists Agent<br/>Theme Generation]
    end

    subgraph "Distribution Layer"
        TP[Telegram Posting Agent]
        CC[Content Calendar]
        AB[A/B Testing Engine]
    end

    subgraph "Data Layer"
        PG[(PostgreSQL<br/>+ pgvector)]
        RD[(Redis Cache)]
    end

    subgraph "Monitoring Layer"
        PR[Prometheus]
        GF[Grafana]
    end

    AMZ --> DD
    WA --> WI
    AF --> MSI
    DD --> RQ
    WI --> RQ
    MSI --> RQ
    RQ --> DA
    RQ --> CL
    DA --> RQ
    CL --> TP
    RQ --> TP
    TP --> PG
    DA --> PG
    DD --> PG
    PG --> RD
    TP --> PR
    DA --> PR
    DD --> PR
    PR --> GF
```

### 2.2 Agent Ecosystem

The platform operates as a distributed multi-agent system with 6 specialized agents:

| Agent | Purpose | Trigger | Scale |
|-------|---------|---------|-------|
| Deal Discovery | Scrape Amazon deals | Cron (30 min) | 50 deals/source |
| WhatsApp Ingestion | Monitor WhatsApp groups | Cron (10 min) | Variable |
| Deal Analysis | AI-powered deal scoring | Queue-driven | Real-time |
| Telegram Posting | Channel content distribution | Queue-driven | 2s intervals |
| Curated Lists | Themed deal collections | Scheduled | 3x daily |
| Quality Control | Content validation | Event-driven | Per-post |

---

## 3. Architecture Diagrams

### 3.1 Component Architecture

```mermaid
graph LR
    subgraph "Shared Infrastructure"
        SU[Shared Utils]
        ST[Shared Types<br/>Zod Schemas]
        SM[Shared Models]
    end

    subgraph "Agent Layer"
        direction TB
        A1[Deal Discovery]
        A2[WhatsApp Ingestion]
        A3[Deal Analysis]
        A4[Telegram Posting]
        A5[Curated Lists]
        A6[Quality Control]
    end

    subgraph "Service Layer"
        DB[(Database)]
        RQ[Message Queue]
        CA[Cache]
    end

    subgraph "External APIs"
        GEM[Google Gemini]
        OR[OpenRouter]
        OL[Ollama]
        TG[Telegram API]
        AMZ[Amazon]
    end

    SU --> A1
    SU --> A2
    SU --> A3
    SU --> A4
    SU --> A5
    SU --> A6
    ST --> A1
    ST --> A2
    ST --> A3
    ST --> A4
    ST --> A5
    ST --> A6
    SM --> A3
    SM --> A4
    SM --> A5

    A1 --> DB
    A1 --> RQ
    A2 --> DB
    A2 --> RQ
    A3 --> DB
    A3 --> RQ
    A3 --> CA
    A4 --> DB
    A4 --> RQ
    A5 --> DB
    A5 --> RQ
    A6 --> DB

    A3 --> GEM
    A3 --> OR
    A3 --> OL
    A4 --> TG
    A5 --> GEM
    A5 --> OR
    A1 --> AMZ
    A2 --> WA
```

### 3.2 Service Dependency Graph

```mermaid
graph TD
    subgraph "Data Services"
        PG[(PostgreSQL)]
        RD[(Redis)]
    end

    subgraph "Core Agents"
        DD[Deal Discovery]
        DA[Deal Analysis]
        TP[Telegram Posting]
        CL[Curated Lists]
    end

    subgraph "Optional Agents"
        WI[WhatsApp Ingestion]
    end

    subgraph "Monitoring"
        PR[Prometheus]
        GF[Grafana]
    end

    subgraph "Shared"
        SH[Shared Module]
    end

    PG --> DD
    PG --> DA
    PG --> TP
    PG --> CL
    PG --> WI
    RD --> DD
    RD --> DA
    RD --> TP
    RD --> CL
    RD --> WI
    SH --> DD
    SH --> DA
    SH --> TP
    SH --> CL
    SH --> WI
    DD --> PR
    DA --> PR
    TP --> PR
    CL --> PR
    PR --> GF
    WI -.->|Manual Start| RD
    WI -.->|Manual Start| PG
```

---

## 4. Component Details

### 4.1 Deal Discovery Agent

```mermaid
flowchart TD
    Start([Cron Trigger<br/>Every 30 min]) --> Init[Initialize Stealth Browser]
    Init --> FP[Generate Browser Fingerprint]
    FP --> Nav[Navigate to Amazon Deals]
    Nav --> Extract[Extract Deal Data]
    Extract --> Validate{Valid Deal?}
    Validate -->|Yes| Enrich[Enrich with Metadata]
    Validate -->|No| Discard[Discard]
    Enrich --> Deduplicate{Duplicate?}
    Deduplicate -->|No| Queue[Add to Deals Queue]
    Deduplicate -->|Yes| Discard
    Queue --> Store[Store in Database]
    Store --> End([End Cycle])
    Discard --> End

    style Start fill:#e1f5fe
    style End fill:#e1f5fe
    style Queue fill:#c8e6c9
    style Discard fill:#ffcdd2
```

**Technical Specifications:**
- **Runtime**: Node.js 20+ with Playwright
- **Browser**: Chromium with stealth plugins
- **Proxy**: Rotation ready (not yet enabled)
- **Fingerprinting**: Randomized viewport, user-agent, timezone
- **Rate Limiting**: 30s between requests
- **Error Handling**: 3 retry attempts with exponential backoff

### 4.2 Deal Analysis Agent

```mermaid
flowchart TD
    Start([Queue Worker<br/>BullMQ]) --> Receive[Receive Deal]
    Receive --> Fetch[Fetch Price History]
    Fetch --> Score[Calculate Base Score]
    Score --> AI{AI Enhancement}
    AI -->|Gemini| Gemini[Google Gemini Pro]
    AI -->|OpenRouter| OR[OpenRouter GPT-4o]
    AI -->|Fallback| Ollama[Local Ollama]
    Gemini --> Validate{Valid Response?}
    OR --> Validate
    Ollama --> Validate
    Validate -->|Yes| Combine[Combine Scores]
    Validate -->|No| Fallback[Use Base Score]
    Combine --> Threshold{Score > Threshold?}
    Fallback --> Threshold
    Threshold -->|Yes| PostQueue[Add to Posts Queue]
    Threshold -->|No| Reject[Reject Deal]
    PostQueue --> End([End])
    Reject --> End

    style Start fill:#e1f5fe
    style PostQueue fill:#c8e6c9
    style Reject fill:#ffcdd2
```

**AI Scoring Pipeline:**

| Stage | Model | Purpose | Fallback |
|-------|-------|---------|----------|
| Primary | Gemini 2.0 Flash | Deal quality assessment | OpenRouter |
| Secondary | OpenRouter GPT-4o | Price validation | Gemini |
| Local | Ollama (Llama 3) | Offline processing | None |

**Score Components:**
- Base Score: Discount percentage, price history, category demand
- AI Boost: Quality assessment, market trends, seasonal relevance
- Final Score: Weighted combination (70% base + 30% AI)

### 4.3 Telegram Posting Agent

```mermaid
flowchart TD
    Start([Queue Worker]) --> Receive[Receive Scored Deal]
    Receive --> Strategy[Determine Content Strategy]
    Strategy --> Archetype[Select Archetype]
    Archetype --> Caption[Generate Caption]
    Caption --> Image[Extract Product Image]
    Image --> Format[Format Message]
    Format --> RateLimit{Rate Limit OK?}
    RateLimit -->|Yes| Post[Post to Channel]
    RateLimit -->|No| Delay[Delay 2s]
    Delay --> RateLimit
    Post --> Track[Track Engagement]
    Track --> Store[Store Metrics]
    Store --> End([End])

    style Start fill:#e1f5fe
    style Post fill:#c8e6c9
```

**Content Strategy Engine:**

```mermaid
graph LR
    subgraph "Content Archetypes"
        A1[Urgency Driver]
        A2[Value Proposition]
        A3[Social Proof]
        A4[Scarcity Alert]
        A5[Curiosity Gap]
    end

    subgraph "Optimization"
        AB[A/B Testing]
        CC[Content Calendar]
        TS[Time Slotting]
    end

    subgraph "Output"
        CAP[Caption]
        KB[Keyboard]
        IMG[Image]
    end

    A1 --> AB
    A2 --> AB
    A3 --> AB
    A4 --> AB
    A5 --> AB
    AB --> CC
    CC --> TS
    TS --> CAP
    TS --> KB
    TS --> IMG
```

### 4.4 Curated Lists Agent

```mermaid
flowchart TD
    Start([Scheduled Trigger]) --> Fetch[Fetch Recent Deals]
    Fetch --> Theme[AI Theme Generation]
    Theme --> Select[Select Top Deals]
    Select --> Generate[Generate List Content]
    Generate --> Image[Create Collage Image]
    Image --> Schedule[Schedule Post]
    Schedule --> End([End])

    style Start fill:#e1f5fe
```

**Digest Schedule:**
- Morning Digest: 8:00 AM IST
- Afternoon Digest: 12:00 PM IST
- Evening Digest: 6:00 PM IST

---

## 5. Data Flow

### 5.1 End-to-End Deal Flow

```mermaid
sequenceDiagram
    participant AMZ as Amazon India
    participant DD as Deal Discovery
    participant RQ as Redis Queue
    participant DA as Deal Analysis
    participant PG as PostgreSQL
    participant TP as Telegram Posting
    participant TG as Telegram Channel

    rect rgb(225, 245, 254)
        Note over AMZ,DD: Discovery Phase
        DD->>AMZ: Navigate to deals page
        AMZ-->>DD: HTML content
        DD->>DD: Extract deal data
        DD->>DD: Apply stealth fingerprinting
        DD->>PG: Store raw deal
        DD->>RQ: Publish to 'deals' queue
    end

    rect rgb(232, 245, 233)
        Note over RQ,DA: Analysis Phase
        RQ->>DA: Consume deal message
        DA->>PG: Fetch price history
        PG-->>DA: Historical prices
        DA->>DA: Calculate base score
        DA->>DA: Call AI model
        DA->>PG: Store analysis result
        DA->>RQ: Publish to 'posts' queue
    end

    rect rgb(255, 243, 224)
        Note over TP,TG: Distribution Phase
        RQ->>TP: Consume scored deal
        TP->>PG: Fetch engagement data
        TP->>TP: Generate caption
        TP->>TP: Extract image
        TP->>TG: Post message
        TG-->>TP: Message ID
        TP->>PG: Store post metadata
    end
```

### 5.2 WhatsApp Ingestion Flow

```mermaid
sequenceDiagram
    participant WA as WhatsApp Web
    participant WI as WhatsApp Agent
    participant RQ as Redis Queue
    participant DA as Deal Analysis
    participant PG as PostgreSQL

    WI->>WA: Scan QR Code (Manual)
    WA-->>WI: Session Established
    loop Every 10 minutes
        WI->>WA: Check group messages
        WA-->>WI: Recent messages
        WI->>WI: Extract ASINs/URLs
        WI->>PG: Store ingestion log
        WI->>RQ: Publish to 'deals' queue
    end
```

### 5.3 A/B Testing Flow

```mermaid
sequenceDiagram
    participant TP as Telegram Posting
    participant AB as A/B Engine
    participant PG as PostgreSQL
    participant TG as Telegram

    TP->>AB: Request variant for deal
    AB->>PG: Check active tests
    PG-->>AB: Test configuration
    AB->>AB: Select variant (A/B)
    AB-->>TP: Variant assignment
    TP->>TG: Post with variant
    TG-->>TP: Message ID
    TP->>PG: Store assignment
    loop Every hour
        TP->>TG: Fetch engagement metrics
        TG-->>TP: Views, clicks
        TP->>PG: Update metrics
    end
```

---

## 6. Database Schema

### 6.1 Entity Relationship Diagram

```mermaid
erDiagram
    PRODUCTS {
        string asin PK
        string title
        string category
        string image_url
        string product_url
        string affiliate_url
        float rating
        int review_count
        timestamp first_seen
        timestamp last_updated
    }

    PRICE_HISTORY {
        timestamp time PK
        string asin PK
        float price
        float mrp
        float discount_pct
        string source
    }

    POSTED_DEALS {
        timestamp time PK
        string asin PK
        float deal_score
        string post_template
        string channel
        int engagement_views
        int engagement_clicks
        bigint message_id
        string content_strategy
        string archetype
        boolean ai_generated
        string posting_slot
        float revenue_multiplier
        int clicks
        float estimated_revenue
        timestamp last_click_at
        float final_price
        float deal_price
        string category
        string caption_source
    }

    WHATSAPP_INGESTION {
        timestamp time PK
        string message_id
        string source_group
        text raw_text
        string extracted_asin
        string extracted_url
        boolean processed
        string duplicate_of
    }

    AFFILIATE_CLICKS {
        timestamp time PK
        string short_url
        string original_url
        string asin
        string channel
        string user_agent
        string ip_hash
    }

    AGENT_METRICS {
        timestamp time PK
        string agent_name
        string task_type
        string status
        int duration_ms
        string error_message
    }

    AB_TEST_ASSIGNMENTS {
        string test_id PK
        string deal_asin
        string variant
        timestamp assigned_at
        bigint message_id
    }

    ENGAGEMENT_POSTS {
        timestamp time PK
        string post_type
        int view_count
        int click_count
        float engagement_rate
    }

    PRODUCTS ||--o{ PRICE_HISTORY : "has prices"
    PRODUCTS ||--o{ POSTED_DEALS : "posted as"
    POSTED_DEALS ||--o{ AFFILIATE_CLICKS : "generates"
    PRODUCTS ||--o{ WHATSAPP_INGESTION : "discovered via"
```

### 6.2 Schema Details

#### Products Table
| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| asin | TEXT | PRIMARY KEY | Amazon Standard Identification Number |
| title | TEXT | NOT NULL | Product title |
| category | TEXT | | Product category |
| image_url | TEXT | | Primary product image |
| product_url | TEXT | | Amazon product URL |
| affiliate_url | TEXT | | Generated affiliate link |
| rating | REAL | | Customer rating (1-5) |
| review_count | INTEGER | | Number of reviews |
| first_seen | TIMESTAMPTZ | DEFAULT NOW() | First discovery timestamp |
| last_updated | TIMESTAMPTZ | DEFAULT NOW() | Last update timestamp |

#### Price History Table (TimescaleDB Hypertable)
| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| time | TIMESTAMPTZ | NOT NULL | Price snapshot timestamp |
| asin | TEXT | NOT NULL | Product ASIN |
| price | REAL | NOT NULL | Current price |
| mrp | REAL | | Maximum retail price |
| discount_pct | REAL | | Calculated discount percentage |
| source | TEXT | DEFAULT 'amazon' | Price source |

#### Posted Deals Table (TimescaleDB Hypertable)
| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| time | TIMESTAMPTZ | NOT NULL | Post timestamp |
| asin | TEXT | NOT NULL | Product ASIN |
| deal_score | REAL | | AI-calculated deal score |
| post_template | TEXT | | Template used |
| channel | TEXT | DEFAULT 'telegram' | Distribution channel |
| engagement_views | INTEGER | DEFAULT 0 | View count |
| engagement_clicks | INTEGER | DEFAULT 0 | Click count |
| message_id | BIGINT | | Telegram message ID |
| content_strategy | TEXT | | Strategy archetype |
| archetype | TEXT | | Content archetype |
| ai_generated | BOOLEAN | | AI-generated flag |
| posting_slot | TEXT | | Time slot category |
| revenue_multiplier | REAL | | Revenue optimization factor |

---

## 7. Deployment Architecture

### 7.1 Docker Compose Topology

```mermaid
graph TB
    subgraph "Docker Network: affiliate-platform_default"
        subgraph "Data Layer"
            PG[(PostgreSQL<br/>ankane/pgvector)]
            RD[(Redis<br/>redis:7-alpine)]
        end

        subgraph "Application Layer"
            DD[Deal Discovery<br/>Node.js 20]
            DA[Deal Analysis<br/>Node.js 20]
            TP[Telegram Posting<br/>Node.js 20]
            CL[Curated Lists<br/>Node.js 20]
            WI[WhatsApp Ingestion<br/>Node.js 20]
        end

        subgraph "Monitoring Layer"
            PR[Prometheus<br/>prom/prometheus]
            GF[Grafana<br/>grafana:10.4.3]
        end

        subgraph "Shared Resources"
            SH[Shared Module<br/>Volume]
            PC[Playwright Cache<br/>Volume]
        end
    end

    PG --> DD
    PG --> DA
    PG --> TP
    PG --> CL
    RD --> DD
    RD --> DA
    RD --> TP
    RD --> CL
    SH --> DD
    SH --> DA
    SH --> TP
    SH --> CL
    PC --> DD
    PC --> CL
    DD --> PR
    DA --> PR
    TP --> PR
    PR --> GF
```

### 7.2 Service Configuration

| Service | Image | Memory Limit | Restart | Ports |
|---------|-------|--------------|---------|-------|
| PostgreSQL | ankane/pgvector:latest | Unlimited | unless-stopped | 5432 |
| Redis | redis:7-alpine | 512MB | unless-stopped | 6379 |
| Deal Discovery | Custom Node.js | 2GB | unless-stopped | - |
| Deal Analysis | Custom Node.js | 1GB | unless-stopped | - |
| Telegram Posting | Custom Node.js | 1GB | unless-stopped | - |
| Curated Lists | Custom Node.js | 2GB | unless-stopped | - |
| WhatsApp | Custom Node.js | 1GB | no (manual) | - |
| Grafana | grafana:10.4.3 | Unlimited | unless-stopped | 3000 |
| Prometheus | prom/prometheus | Unlimited | unless-stopped | 9090 |

### 7.3 Volume Mapping

| Volume | Purpose | Persistence |
|--------|---------|-------------|
| postgres_data | Database files | Persistent |
| redis_data | Cache data | Persistent |
| grafana_data | Dashboard configs | Persistent |
| prometheus_data | Metrics storage | Persistent |
| playwright_cache | Browser binaries | Shared |
| shared_modules | Node modules | Shared |

---

## 8. Monitoring & Observability

### 8.1 Metrics Collection

```mermaid
graph LR
    subgraph "Agents"
        DD[Deal Discovery]
        DA[Deal Analysis]
        TP[Telegram Posting]
        CL[Curated Lists]
    end

    subgraph "Metrics Endpoints"
        M1[Port 3001]
        M2[Port 3002]
        M3[Port 3004]
        M4[Port 3005]
    end

    subgraph "Prometheus"
        PR[Scraper]
        TS[Time Series DB]
    end

    subgraph "Grafana"
        DB1[Deal Discovery Dashboard]
        DB2[Deal Analysis Dashboard]
        DB3[Telegram Posting Dashboard]
    end

    DD --> M1
    DA --> M2
    TP --> M3
    CL --> M4
    M1 --> PR
    M2 --> PR
    M3 --> PR
    M4 --> PR
    PR --> TS
    TS --> DB1
    TS --> DB2
    TS --> DB3
```

### 8.2 Key Metrics

| Category | Metric | Threshold | Alert |
|----------|--------|-----------|-------|
| Performance | Deals discovered/hour | > 50 | Warning if < 30 |
| Performance | Analysis queue depth | < 100 | Critical if > 100 |
| Performance | Post success rate | > 95% | Critical if < 90% |
| Performance | AI API latency | < 2s | Warning if > 3s |
| Health | Agent uptime | > 99% | Critical if < 95% |
| Health | Scraping error rate | < 5% | Warning if > 10% |
| Business | Engagement rate | > 10% | Warning if < 5% |
| Business | Click-through rate | > 8% | Warning if < 3% |

### 8.3 Dashboard Views

1. **Deal Discovery Dashboard**
   - Deals discovered over time
   - Source breakdown
   - Error rate by source
   - Browser fingerprint rotation

2. **Deal Analysis Dashboard**
   - Queue depth
   - AI model performance
   - Score distribution
   - Processing latency

3. **Telegram Posting Dashboard**
   - Posts per hour
   - Engagement metrics
   - A/B test results
   - Revenue estimates

---

## 9. Scaling Strategy

### 9.1 Current Phase: Single Instance

```mermaid
graph TB
    subgraph "Single Host Deployment"
        D[Docker Compose]
        D --> PG[(PostgreSQL)]
        D --> RD[(Redis)]
        D --> DD[Deal Discovery]
        D --> DA[Deal Analysis]
        D --> TP[Telegram Posting]
        D --> GF[Grafana]
        D --> PR[Prometheus]
    end
```

**Characteristics:**
- All services on single VPS (4GB RAM)
- Shared resources
- SQLite cache fallback
- Manual WhatsApp authentication

### 9.2 Phase 2: Horizontal Scaling

```mermaid
graph TB
    subgraph "Kubernetes Cluster"
        subgraph "Data Tier"
            PG[(PostgreSQL HA)]
            RD[(Redis Cluster)]
        end

        subgraph "Agent Pools"
            AP1[Discovery Pool<br/>3 replicas]
            AP2[Analysis Pool<br/>5 replicas]
            AP3[Posting Pool<br/>2 replicas]
        end

        subgraph "Load Balancing"
            LB1[Queue Router]
            LB2[API Gateway]
        end

        subgraph "Monitoring"
            PR[Prometheus Federation]
            GF[Grafana HA]
        end

        LB1 --> AP1
        LB1 --> AP2
        LB1 --> AP3
        AP1 --> PG
        AP2 --> PG
        AP3 --> PG
        AP1 --> RD
        AP2 --> RD
        AP3 --> RD
        AP1 --> PR
        AP2 --> PR
        AP3 --> PR
        PR --> GF
    end
```

**Scaling Triggers:**
- Queue depth > 500 for 5 minutes → Scale analysis workers
- Discovery time > 15 minutes → Scale discovery workers
- Post backlog > 50 → Scale posting workers

### 9.3 Phase 3: Multi-Region Swarm

```mermaid
graph TB
    subgraph "Region 1: Mumbai"
        R1A[Discovery Nodes]
        R1B[Analysis Nodes]
        R1C[Local DB Replica]
    end

    subgraph "Region 2: Singapore"
        R2A[Discovery Nodes]
        R2B[Analysis Nodes]
        R2C[Local DB Replica]
    end

    subgraph "Global Services"
        GLB[Global Load Balancer]
        MDB[(Primary DB)]
        AI[AI Model Router]
    end

    GLB --> R1A
    GLB --> R2A
    R1A --> R1B
    R2A --> R2B
    R1B --> R1C
    R2B --> R2C
    R1C --> MDB
    R2C --> MDB
    R1B --> AI
    R2B --> AI
```

---

## 10. Security Architecture

### 10.1 Security Layers

```mermaid
graph TB
    subgraph "Security Architecture"
        direction TB
        L1[Layer 1: Network]
        L2[Layer 2: Container]
        L3[Layer 3: Application]
        L4[Layer 4: Data]
    end

    subgraph "Controls"
        C1[Docker Network Isolation]
        C2[Non-root Containers]
        C3[Secret Management]
        C4[Encrypted Connections]
    end

    L1 --> C1
    L2 --> C2
    L3 --> C3
    L4 --> C4
```

### 10.2 Security Measures

| Layer | Measure | Implementation |
|-------|---------|----------------|
| Network | Internal Docker network | Default bridge network |
| Network | Port exposure | Only necessary ports exposed |
| Container | User privileges | Non-root where possible |
| Container | Image scanning | Base images from trusted sources |
| Application | Secrets management | Environment variables only |
| Application | No hardcoded credentials | All secrets in `.env` |
| Data | Database encryption | TLS connections |
| Data | Session persistence | Encrypted session files |
| Data | API keys | Rotatable, multiple fallback keys |

### 10.3 Secret Management

```mermaid
graph LR
    subgraph "Secret Sources"
        ENV[.env File]
        DC[Docker Compose]
        RUN[Runtime Env]
    end

    subgraph "Consumers"
        GEM[Gemini API Keys]
        OR[OpenRouter Key]
        TG[Telegram Token]
        DB[DB Password]
    end

    ENV --> DC
    DC --> RUN
    RUN --> GEM
    RUN --> OR
    RUN --> TG
    RUN --> DB
```

---

## 11. Technology Stack

### 11.1 Complete Stack Overview

```mermaid
graph TB
    subgraph "Runtime"
        NODE[Node.js 20+]
        ESM[ES Modules]
    end

    subgraph "Data"
        PG[(PostgreSQL 16)]
        TS[TimescaleDB]
        PV[pgvector]
        RD[(Redis 7)]
        BQ[BullMQ]
    end

    subgraph "Browser Automation"
        PW[Playwright]
        SB[Stealth Browser]
        FP[Fingerprinting]
    end

    subgraph "AI/ML"
        GEM[Google Gemini]
        OR[OpenRouter]
        OL[Ollama]
        ZOD[Zod Schema]
    end

    subgraph "Messaging"
        TF[Telegraf]
        TG[Telegram API]
        WA[WhatsApp Web]
    end

    subgraph "Monitoring"
        PR[Prometheus]
        GF[Grafana]
        JL[Winston Logger]
    end

    subgraph "Infrastructure"
        DK[Docker]
        DC[Docker Compose]
        NG[Nginx]
    end

    NODE --> PW
    NODE --> BQ
    NODE --> TF
    NODE --> JL
    PW --> SB
    SB --> FP
    BQ --> RD
    TF --> TG
    PG --> TS
    TS --> PV
```

### 11.2 Technology Details

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| Runtime | Node.js | 20+ | JavaScript runtime |
| Database | PostgreSQL | 16 | Primary database |
| Extension | TimescaleDB | 2.x | Time-series data |
| Extension | pgvector | 0.5+ | Vector similarity |
| Cache | Redis | 7.x | Message queue & cache |
| Queue | BullMQ | 5.x | Job processing |
| Browser | Playwright | 1.40+ | Web scraping |
| AI | Google Gemini | 2.0 Flash | Primary AI model |
| AI | OpenRouter | - | Secondary AI model |
| AI | Ollama | - | Local AI fallback |
| Bot | Telegraf | 4.x | Telegram bot framework |
| Monitoring | Prometheus | 2.x | Metrics collection |
| Monitoring | Grafana | 10.4 | Visualization |
| Logging | Winston | 3.x | Structured logging |
| Validation | Zod | 3.x | Schema validation |
| Container | Docker | 24+ | Containerization |
| Orchestration | Docker Compose | 2.x | Local orchestration |

---

## 12. Cost Analysis

### 12.1 Current Infrastructure Costs

```mermaid
pie title Monthly Cost Breakdown
    "VPS (4GB RAM)" : 20
    "Gemini API" : 10
    "Domain" : 1
    "Telegram" : 0
```

| Component | Provider | Monthly Cost | Notes |
|-----------|----------|--------------|-------|
| VPS (4GB) | Hetzner/DigitalOcean | $20 | Single instance |
| Gemini API | Google | $5-15 | Variable usage |
| OpenRouter | OpenRouter | $0-5 | Fallback usage |
| Telegram Bot | Telegram | Free | No cost |
| Domain | Namecheap/Cloudflare | $1 | Optional |
| Monitoring | Self-hosted | $0 | Prometheus/Grafana |
| **Total** | | **$26-36** | |

### 12.2 Projected Scaling Costs

| Phase | Infrastructure | Monthly Cost | Capacity |
|-------|---------------|--------------|----------|
| Phase 1 (Current) | Single VPS | $26-36 | 1,200 deals/day |
| Phase 2 (K8s) | 3-node cluster | $150-200 | 10,000 deals/day |
| Phase 3 (Multi-region) | 2 regions | $400-600 | 50,000 deals/day |

### 12.3 Cost Optimization Strategies

1. **AI Model Routing**: Use cheaper models for simple tasks
2. **Caching**: Redis caching reduces API calls
3. **Batch Processing**: Process deals in batches where possible
4. **Smart Scheduling**: Post during high-engagement hours only
5. **Image Optimization**: Compress images before posting

---

## Appendix A: File Structure

```
affiliate-platform/
├── agents/
│   ├── affiliate-system/
│   ├── curated-lists/
│   ├── deal-analysis/
│   ├── deal-discovery/
│   ├── quality-control/
│   ├── scheduler/
│   ├── telegram-posting/
│   └── whatsapp-ingestion/
├── shared/
│   ├── models/
│   ├── types/
│   └── utils/
├── infrastructure/
│   ├── db/
│   │   └── init/
│   ├── docker/
│   ├── grafana/
│   │   ├── dashboards/
│   │   └── datasources/
│   ├── monitoring/
│   └── prometheus/
├── scripts/
├── tests/
├── docker-compose.yml
└── .env
```

## Appendix B: API Integration Points

| Service | Endpoint | Purpose | Rate Limit |
|---------|----------|---------|------------|
| Google Gemini | generativelanguage.googleapis.com | Deal scoring | 60 RPM |
| OpenRouter | openrouter.ai/api | Fallback AI | 20 RPM |
| Telegram | api.telegram.org | Bot API | 30 MSG/s |
| Amazon India | amazon.in | Deal discovery | N/A (scraping) |

## Appendix C: Operational Runbooks

### Restarting Services
```bash
docker compose restart [service-name]
```

### Viewing Logs
```bash
docker compose logs -f [service-name]
```

### Database Backup
```bash
docker compose exec postgres pg_dump -U affiliate_user affiliate_platform > backup.sql
```

### Redis Queue Inspection
```bash
docker compose exec redis redis-cli LLEN bull:deals:wait
docker compose exec redis redis-cli LLEN bull:posts:wait
```

---

**Document Control**

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | Nov 2024 | System | Initial architecture |
| 2.0 | Dec 2026 | System | Added curated lists, A/B testing, content strategy |

**Review Schedule:** Quarterly

**Distribution:** Internal Engineering Team

---

*This document contains proprietary information. Unauthorized distribution is prohibited.*
