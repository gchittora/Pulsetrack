# PulseTrack

A high-throughput, real-time analytics ingestion platform built as a hands-on system design project. PulseTrack is designed to accept, queue, process, and store large volumes of user events from third-party applications via a simple API.

---

## Overview

PulseTrack follows an event-driven microservices architecture. A client SDK (or direct HTTP call) sends analytics events to a public-facing ingestion endpoint. The system authenticates the request, rate limits it, pushes it to a Redis Stream queue, and returns a `202 Accepted` immediately. Background worker processes then asynchronously consume the queue and write events durably to MongoDB. A separate query service exposes analytical endpoints (with Redis caching) for dashboard consumption.

This project is intentionally built without managed cloud services: every component — PostgreSQL, MongoDB, Redis, MinIO, and Nginx — runs as a Docker container so the architecture can be understood, inspected, and reasoned about directly.

---

## Architecture

```
Client
  |
  | POST /api/events/ingest
  v
Nginx (Port 80) — API Gateway + Load Balancer
  |
  |--- /api/auth/*    ---> Auth Service      (Node.js, Port 3001, PostgreSQL)
  |--- /api/events/*  ---> Ingestion Service (Node.js, Port 3002, x3 replicas)
  |--- /api/query/*   ---> Query Service     (Node.js, Port 3003, MongoDB + Redis Cache)
                                        |
                              Redis Stream (events:raw)
                                        |
                              Worker Service (x2 replicas)
                                        |
                                    MongoDB
```

**Data flow in detail:**

1. A client sends a `POST /api/events/ingest` with an API key and event payload.
2. Nginx routes the request round-robin across 3 Ingestion Service instances.
3. The Ingestion Service validates the API key (cached in Redis), applies a sliding-window rate limit (1000 req/s globally), validates the event schema, and pushes to the `events:raw` Redis Stream.
4. It immediately returns `202 Accepted` to the client — the job is done from the client's perspective.
5. Two Worker Service replicas consume the stream using a Redis Consumer Group (`pulse_workers`), ensuring each event is processed exactly once.
6. Workers batch events (up to 50) and insert them into MongoDB. The `XACK` acknowledgment is only sent after MongoDB confirms the write — guaranteeing zero data loss on crash.
7. The Query Service exposes aggregation endpoints backed by MongoDB pipelines, with a 10-second Redis cache layer to avoid hammering the database on repeated dashboard loads.

---

## Services

### Auth Service (`services/auth`)
- **Port:** 3001 (internal only, access via Nginx)
- **Database:** PostgreSQL
- **Responsibilities:** User registration, login, JWT issuance, project management, and API key generation.
- **Endpoints:**
  - `POST /api/auth/register`
  - `POST /api/auth/login`
  - `POST /api/auth/projects`
  - `GET /api/auth/projects`
  - `POST /api/auth/projects/:id/keys`

### Ingestion Service (`services/ingestion`)
- **Port:** 3002 (3 replicas: `ingestion_1`, `ingestion_2`, `ingestion_3`)
- **Database:** Redis (rate limiting + stream publishing)
- **Responsibilities:** API key validation, rate limiting, event schema validation, writing to Redis Streams.
- **Endpoints:**
  - `POST /api/events/ingest`

**Required request body:**
```json
{
  "event": "page_view",
  "user_id": "user_abc123",
  "properties": {
    "url": "/dashboard",
    "browser": "Chrome"
  }
}
```

**Required headers:**
```
x-api-key: pk_your_api_key_here
Content-Type: application/json
```

### Worker Service (`services/worker`)
- **Replicas:** 2 (via Docker Compose scaling)
- **Consumes:** Redis Stream `events:raw`, Consumer Group `pulse_workers`
- **Writes to:** MongoDB (`pulsetrack.events`)
- **Responsibilities:** Exactly-once event consumption using Redis Consumer Groups, synchronous batch writes to MongoDB (batch size 50), graceful shutdown.

### Query Service (`services/query`)
- **Port:** 3003 (internal only, access via Nginx)
- **Databases:** MongoDB (aggregations), Redis (response cache)
- **Auth:** JWT Bearer Token (same secret as Auth Service — stateless verification)
- **Endpoints:**
  - `GET /api/query/metrics/overview` — Total event count and unique user count
  - `GET /api/query/events/list` — 100 most recent events
  - `GET /api/query/events/breakdown` — Event counts grouped by event name

---

## Infrastructure

| Container          | Image              | Purpose                          | Host Port     |
|--------------------|--------------------|----------------------------------|---------------|
| `pulse_nginx`      | `nginx:alpine`     | API gateway and load balancer    | 80            |
| `pulse_postgres`   | `postgres:16`      | Auth service user/project data   | 5433          |
| `pulse_mongodb`    | `mongo:7`          | Durable event storage            | 27017         |
| `pulse_redis`      | `redis:7`          | Stream queue, rate limiter, cache| 6379          |
| `pulse_minio`      | `minio/minio`      | S3-compatible blob storage       | 9000, 9001    |
| `pulse_auth`       | (built locally)    | Auth microservice                | —             |
| `pulse_ingestion_*`| (built locally)    | Ingestion microservice (x3)      | —             |
| `pulse_query`      | (built locally)    | Query microservice               | —             |
| `worker-1/2`       | (built locally)    | Background event processor (x2)  | —             |

---

## Getting Started

### Prerequisites

- Docker Desktop installed and running
- Port 80 free on your host machine (Nginx)

### Start the stack

```bash
docker compose up -d --build
```

### Verify all containers are healthy

```bash
docker compose ps
```

### Register a user and get started

```bash
# 1. Register
curl -X POST http://localhost/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "yourpassword"}'

# 2. Login and copy the token from the response
curl -X POST http://localhost/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "yourpassword"}'

# 3. Create a project (use the token from above)
curl -X POST http://localhost/api/auth/projects \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{"name": "My App"}'

# 4. Generate an API key for the project
curl -X POST http://localhost/api/auth/projects/YOUR_PROJECT_ID/keys \
  -H "Authorization: Bearer YOUR_JWT"

# 5. Send an event
curl -X POST http://localhost/api/events/ingest \
  -H "x-api-key: pk_YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"event": "page_view", "user_id": "user_123", "properties": {"url": "/home"}}'
```

### View worker activity in real time

```bash
docker compose logs -f worker
```

### Query stored events

All query endpoints require a valid JWT Bearer token.

```bash
curl http://localhost/api/query/metrics/overview \
  -H "Authorization: Bearer YOUR_JWT"
```

### Check event count directly in MongoDB

```bash
docker compose exec mongodb mongosh \
  -u pulse_admin -p pulse_secret \
  --authenticationDatabase admin \
  --eval "db.getSiblingDB('pulsetrack').events.countDocuments({})"
```

---

## Phase Progress

| Phase | Description                         | Status       |
|-------|-------------------------------------|--------------|
| 1     | Foundation — Auth, DBs, Nginx       | Complete     |
| 2     | Event Ingestion Pipeline            | Complete     |
| 3     | Background Workers (DB Worker)      | In Progress  |
| 4     | Query Service API                   | In Progress  |
| 5     | Blob Storage and Reports (MinIO)    | Not started  |
| 6     | Load Testing and Observability      | Not started  |

---

## Design Decisions

**Why Redis Streams over a message broker like Kafka or RabbitMQ?**
Redis was already in the stack for caching and rate limiting. For the expected load (thousands of events per second from a single cluster), Redis Streams provides exactly-once delivery via Consumer Groups, persistence, and replay — without the operational cost of a separate Kafka cluster.

**Why 202 Accepted instead of 200 OK on ingest?**
The ingestion endpoint's job is only to validate and queue the event. The actual database write happens asynchronously in the worker. Returning `202` correctly signals to the caller that the work has been accepted but not yet completed.

**Why is the Worker's XACK sent after the MongoDB write and not before?**
If the worker crashed after `XACK` but before the database write, the event would be permanently lost. By acknowledging after a successful write, the worst case is a duplicate event (which can be deduplicated) rather than a lost one.

**Why does the Query Service not talk to the Auth Service to validate tokens?**
Both services share the same `JWT_SECRET`. The Query Service verifies the token's cryptographic signature locally without any network call. This is the standard stateless JWT pattern — it keeps the services decoupled and avoids a single point of failure.

---

## Environment Variables

Key variables used across services (set via `docker-compose.yml`):

| Variable          | Used By           | Description                              |
|-------------------|-------------------|------------------------------------------|
| `JWT_SECRET`      | Auth, Query       | Shared secret for JWT signing/verifying  |
| `PG_HOST`         | Auth              | PostgreSQL hostname (Docker service name)|
| `REDIS_HOST`      | Ingestion, Worker, Query | Redis hostname                    |
| `MONGO_HOST`      | Worker, Query     | MongoDB hostname                         |
| `MONGO_USER`      | Worker, Query     | MongoDB username                         |
| `MONGO_PASSWORD`  | Worker, Query     | MongoDB password                         |
| `PORT`            | All services      | Internal Express server port             |
