# Fakturly

An invoicing and payments system for small businesses, built to the standards
a real financial application is held to — not tutorial standards.

Every design decision is written down with its reasoning and the alternative
that was rejected: **[docs/architecture-decisions.md](docs/architecture-decisions.md)**

> 🚧 **Work in progress.** The backend foundation and authentication layer are
> being built. See [Status](#status) for exactly what works today.

---

## Why this project exists

Most invoicing tutorials store money as a float, delete records on request, and
call `bcrypt.compare` on a user that may not exist. All three are bugs that
matter in production: floats lose money, deleted ledger rows break audits, and
the third leaks your customer list through response timing.

Fakturly is an attempt to do it properly and to understand *why* each rule
exists.

## What it does

**Admin portal** — create clients, issue invoices, track payments, read audit logs
**Client portal** — view own invoices, payment status, download PDF

**Automated** — late fees on overdue invoices, Stripe payment reconciliation via
webhook, email reminders, all with idempotency so a retried webhook never
charges twice.

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Bun |
| API | Fastify 5 + TypeScript (strict) |
| Database | PostgreSQL 16 + Prisma 7 |
| Cache / queue | Redis 7 |
| Auth | Argon2id, JWT access tokens, rotating refresh tokens |
| Payments | Stripe |
| Email | Resend |
| Jobs | BullMQ + node-cron |
| Frontend | React + Vite + Tailwind |

## Principles the code actually follows

**Money is never a float.** Every amount is an integer count of *öre*
(1 SEK = 100 öre), named so the unit is unmistakable: `amountOre`,
`unitPriceOre`, `lateFeeOre`. `0.1 + 0.2 !== 0.3`, and over thousands of
invoices that stops being trivia.

**Financial history is append-only.** `Transaction` and `AuditLog` rows are
never updated or deleted. A correction is a *new* row with a negative amount.
If a row can be edited, history is not evidence.

**Auth failures are indistinguishable.** Wrong password, unknown email, and
locked account return the same status, the same message, and take the same
amount of time. Anything else enumerates the customer list.

**Layers are strict.** `route → controller → service → repository → prisma`.
Services take plain arguments and never touch `request`, so the same logic runs
from an HTTP route, a background job, or a test.

## Security

- **Argon2id** password hashing (OWASP 2024 params: 19 MiB, t=2, p=1) — memory-hard,
  and no silent 72-byte truncation like bcrypt
- **NIST SP 800-63B** password policy — length over complexity, no composition
  rules, no forced rotation, Unicode-normalised
- **Breach checking** against ~1 billion leaked passwords via the HaveIBeenPwned
  k-anonymity API — only 5 characters of a hash ever leave the server
- **Two-layer rate limiting** in Redis — per IP for brute force, per account for
  distributed attacks, counted even for addresses that don't exist so timing
  reveals nothing
- **Progressive delays** before lockout, because pure lockout lets anyone lock
  you out of your own account on purpose
- **Refresh token rotation** with reuse detection — replaying a rotated token
  revokes the entire token family
- Tokens stored as SHA-256, never in plain text
- Zod validation on every input; `role` is never read from a request body

## Status

**Working today**

- [x] Docker: PostgreSQL 16 + Redis 7 with health checks
- [x] Fastify app with fail-fast env validation, graceful shutdown
- [x] Prisma schema: users, clients, invoices, immutable transactions, audit logs
- [x] Liveness and readiness endpoints
- [x] Typed domain errors + one central error handler (no stack traces or
      database messages ever reach a client)
- [x] Input validation and breach checking
- [x] Two-layer rate limiting

**In progress**

- [ ] Password hashing service, login, refresh, logout
- [ ] Auth middleware and role checks
- [ ] Audit logging

**Planned** — client and invoice CRUD · Stripe · background jobs · React frontend · deploy

## Running locally

Requires [Bun](https://bun.sh) and Docker.

```bash
git clone https://github.com/devinder-dev/fakturly.git
cd fakturly

docker compose up -d           # PostgreSQL + Redis

cd backend
cp .env.example .env           # then fill in the values
bun install
bunx prisma migrate deploy
bun run dev                    # http://localhost:3000
```

Check it came up:

```bash
curl localhost:3000/health/ready
# {"status":"ready","database":"up","redis":"up"}
```

| Script | Does |
|---|---|
| `bun run dev` | Dev server with watch |
| `bun run start` | Run once |
| `bun run typecheck` | `tsc --noEmit` |

## Project layout

```
backend/
├── prisma/          schema + migrations
└── src/
    ├── lib/         env, prisma, redis, errors, external clients
    ├── plugins/     Fastify plugins (db, cache, errors, rate limit)
    ├── validators/  Zod schemas
    ├── services/    business logic — no HTTP knowledge
    ├── routes/      URLs and middleware
    └── types/       shared TypeScript types
docs/
└── architecture-decisions.md
```

## About

Built by **Devinder Singh**, Fullstack Developer (YH) student at
Chas Academy, Stockholm — as a study in doing financial software correctly.

The [architecture decision record](docs/architecture-decisions.md) is the most
interesting file in the repo if you want to know *why* anything is the way it is.
