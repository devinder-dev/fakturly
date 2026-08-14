<div align="center">

# Fakturly

**An invoicing and payments system, built to the standards a real financial application is held to.**

Not a CRUD tutorial — every decision is documented with its reasoning and the alternative that was rejected.

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.3-000000?logo=bun&logoColor=white)](https://bun.sh)
[![Fastify](https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white)](https://fastify.dev)
[![Prisma](https://img.shields.io/badge/Prisma-7-2D3748?logo=prisma&logoColor=white)](https://www.prisma.io)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![Redis](https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white)](https://redis.io)
[![CI](https://github.com/devinder-dev/fakturly/actions/workflows/ci.yml/badge.svg)](https://github.com/devinder-dev/fakturly/actions/workflows/ci.yml)

**[📐 Architecture Decision Record](docs/architecture-decisions.md)** · **[📖 Auth walkthrough](docs/auth-phase-walkthrough.md)** · **[🔌 Integrations](docs/integrations.md)**

</div>

---

> [!NOTE]
> **Actively being built.** Auth and invoicing are done and tested — an admin
> can provision a customer, issue a VAT-correct invoice, and the customer sees
> only their own, Stripe payments settle invoices, and overdue interest
> accrues nightly. The frontend is next. See
> **[Status](#-status)** — no feature is claimed here before it runs.

## Why this exists

Most invoicing tutorials get three things wrong that matter enormously in production:

```ts
amount: 99.99                          // floats lose money
await prisma.invoice.delete({ ... })   // deleted ledger rows break audits
if (!user) return res.status(404)      // leaks your entire customer list
```

Fakturly is an attempt to get these right — and to understand *why* each rule
exists. All 28 decisions, and the alternative rejected for each, are in
[`docs/architecture-decisions.md`](docs/architecture-decisions.md).

## How it works

The flow below is what's actually implemented today — admin login through
invoice creation. Payment collection is the next piece being built.

```mermaid
sequenceDiagram
    actor Admin
    actor Client
    participant API as Fastify API
    participant DB as PostgreSQL
    participant Redis
    participant Resend

    Admin->>API: POST /auth/login
    API->>Redis: rate limit + lockout check
    API->>DB: verify Argon2id hash (constant-time either way)
    API-->>Admin: access token (15 min) + refresh token (rotating)

    Admin->>API: POST /clients
    API->>DB: create User + Client in one transaction
    API->>Resend: send set-password invite link
    API->>DB: AuditLog entry

    Admin->>API: POST /invoices
    API->>DB: reserve next invoice number (concurrency-safe series)
    API->>DB: create Invoice + line items — VAT per line, exact öre math
    API->>DB: AuditLog entry

    Client->>API: GET /invoices
    API->>DB: ownership check — a client only ever sees their own
    API-->>Client: invoice list

    Note over API,DB: Stripe payment + webhook + automatic late fees — next up
```

## Architecture

```mermaid
flowchart TD
    Client["React SPA<br/>(admin + client portal)"] -->|HTTPS| RL

    subgraph API["Fastify API"]
        direction TB
        RL["Rate limiter<br/><i>per IP + per account</i>"] --> V["Zod validation"]
        V --> R["Routes"]
        R --> MW["authenticate → authorize"]
        MW --> C["Controllers"]
        C --> S["Services<br/><i>business rules, no HTTP</i>"]
        S --> Repo["Repositories<br/><i>queries only</i>"]
    end

    Repo --> PG[("PostgreSQL<br/>invoices · ledger · audit")]
    S --> Redis[("Redis<br/>rate limits · denylist · queue")]
    Redis --> W["BullMQ workers<br/><i>late fees · emails</i>"]
    W --> Repo
    Stripe["Stripe webhook"] -->|signed| R
```

**Each layer may only call the one below it.** Services take plain arguments
and never touch `request` — which is what lets the (upcoming) overdue-invoice
job reuse the exact same business logic from a BullMQ worker, where no HTTP
request exists.

## 📊 Status

| Component | State |
|---|---|
| Docker: PostgreSQL 16 + Redis 7, health-checked | ✅ |
| Fastify app, fail-fast env validation, graceful shutdown | ✅ |
| Prisma schema — users, clients, invoices, immutable ledger, audit log | ✅ |
| Input validation, breach checking, two-layer rate limiting | ✅ |
| Argon2id hashing, login / refresh / logout with token rotation + theft detection | ✅ |
| `authenticate` / `authorize` middleware, Redis denylist, audit logging | ✅ |
| Admin seed + atomic client provisioning | ✅ |
| Client CRUD with ownership (IDOR) checks | ✅ |
| VAT per line item, mixed rates, exact öre arithmetic | ✅ |
| Invoice numbering — unbroken series, concurrency-safe | ✅ |
| Invoice creation, reads, send, immutable ledger | ✅ |
| CI: typecheck, migrations, full suite on every push | ✅ |
| Set-password invite email, single-use expiring tokens | ✅ |
| Stripe Checkout + webhook, three layers of idempotency | ✅ |
| Statutory late fees (räntelagen), daily accrual | ✅ |
| BullMQ workers + cron scheduler, retries and backoff | ✅ |
| React frontend, PDF invoices | ⏳ next |

**312 tests / 657 assertions** pass across 17 suites, zero failures, in CI
against a real PostgreSQL and Redis on every push — including a measured
timing-attack defence, a forced transaction rollback leaving neither row, a
refresh-token replay triggering family-wide revocation, and 50 concurrent
invoice numbers forming an unbroken series.

```bash
cd backend && bun test
```

## Quick start

Requires [Bun](https://bun.sh) and Docker.

```bash
git clone https://github.com/devinder-dev/fakturly.git
cd fakturly

docker compose up -d              # PostgreSQL + Redis

cd backend
cp .env.example .env              # then fill in the values
bun install
bunx prisma migrate deploy
bun run dev                       # http://localhost:3000
```

```bash
curl localhost:3000/health/ready
# {"status":"ready","database":"up","redis":"up"}
```

<details>
<summary><b>The reasoning behind the code</b> — four principles it actually follows (click)</summary>

### 1. Money is never a float

Every amount is an integer count of *öre* (1 SEK = 100 öre), named so the unit
is unmistakable: `amountOre`, `unitPriceOre`, `lateFeeOre`. Conversion happens
only at the display edge, never in business logic.

```ts
amount: 9999   // 99.99 SEK, exact, always — never 99.99 as a float
```

### 2. Financial history is append-only

`Transaction` and `AuditLog` rows are never updated or deleted. A correction
is a **new** row with a negative amount — if a row can be edited, history is
not evidence.

```ts
await prisma.transaction.create({
  type: 'ADJUSTMENT',
  amountOre: -500,
  description: 'Rättelse för faktura #123'
})
```

### 3. Every auth failure looks identical

Wrong password, unknown email, and locked account return the same status, the
same message, and take the same amount of time — enforced *structurally*, so
no future refactor can accidentally reintroduce the leak.

### 4. Errors never leak internals

Prisma's own message is `Unique constraint failed on the fields: (email)` —
returning that confirms an address is registered. One central handler logs
everything and returns the minimum:

```jsonc
{ "error": { "code": "CONFLICT", "message": "Resursen kunde inte skapas", "requestId": "req-42" } }
```

</details>

<details>
<summary><b>Security controls</b> (click)</summary>

| Control | Implementation |
|---|---|
| **Password hashing** | Argon2id, OWASP 2024 params (19 MiB, t=2, p=1) — memory-hard, no bcrypt 72-byte truncation |
| **Password policy** | NIST SP 800-63B — length over complexity, no composition rules, no forced rotation, NFKC-normalised |
| **Breach checking** | HaveIBeenPwned k-anonymity — only 5 characters of a SHA-1 hash ever leave the server |
| **Rate limiting** | Two layers in Redis: per IP (brute force) and per account (distributed attacks) |
| **Anti-enumeration** | Attempts counted for addresses that *don't exist*, so response timing reveals nothing |
| **Lockout** | Progressive delays first (0 → 100ms → 400ms → 1.6s), because pure lockout lets anyone lock you out of your own account |
| **Token rotation** | Refresh token reuse revokes the entire token family — replay means it was stolen |
| **Token storage** | SHA-256 for refresh tokens, Argon2id for passwords: *match the hash to the entropy of the input* |
| **Input validation** | Zod on every route; `role` is never read from a request body |
| **Log redaction** | Passwords, `Authorization` and `Cookie` headers can never reach a log line |

**Why breach checking beats complexity rules:** "must contain uppercase, a
number and a symbol" reliably produces `Password1!` — it *reduces* real
entropy by pushing everyone into the same predictable pattern. Checking
against ~1 billion known-breached passwords catches far more real attacks,
without the password ever leaving the server:

```
SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
                    └─5─┘
send only "5BAA6"  →  HIBP returns ~800 candidate suffixes  →  match locally
```

HIBP sees a prefix matching hundreds of passwords — it cannot tell which one
was ours. In testing, `password` came back with **52,372,427** hits.

</details>

<details>
<summary><b>Tech stack & repository layout</b> (click)</summary>

| Layer | Choice | Why not the alternative |
|---|---|---|
| Runtime | **Bun** | Faster startup and a built-in test runner vs Node |
| API | **Fastify 5** | Real plugin encapsulation; faster than Express |
| Language | **TypeScript** (strict, no `any`) | Catches errors before runtime |
| Database | **PostgreSQL 16** | Relational data fits invoices naturally |
| ORM | **Prisma 7** | Type-safe queries and versioned migrations |
| Cache / queue | **Redis 7** | Revocable sessions and reliable job queues |
| Hashing | **Argon2id** | Memory-hard; bcrypt is memory-cheap and truncates at 72 bytes |
| Validation | **Zod** | Schema and TypeScript type from one definition |
| Payments | **Stripe** | Webhooks with idempotency |
| Jobs | **BullMQ** + node-cron | Retries and visibility; bare cron loses failed jobs |

Full reasoning for each: [`docs/architecture-decisions.md`](docs/architecture-decisions.md)

```
backend/
├── prisma/              schema + migrations
└── src/
    ├── lib/             env · prisma · redis · errors · external clients
    ├── plugins/         Fastify plugins (db, cache, errors, rate limit)
    ├── validators/      Zod schemas
    ├── services/        business logic — no HTTP knowledge
    ├── routes/          URLs and middleware
    └── types/           shared TypeScript types
docs/
└── architecture-decisions.md
```

| Script | Does |
|---|---|
| `bun run dev` | Dev server with watch mode |
| `bun run start` | Run once |
| `bun run typecheck` | `tsc --noEmit` |

</details>

---

<div align="center">

**Devinder Singh** · Fullstack Developer (YH) student at Chas Academy, Stockholm

Built as a study in doing financial software correctly.

</div>
