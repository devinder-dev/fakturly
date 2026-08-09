# Fakturly — Architecture Decision Record

Why the system is built the way it is. Each entry records the decision, the
reasoning, and what was rejected — because in six months the rejected option
will look tempting again and the reason it lost will have been forgotten.

Format: **Context → Decision → Why → Rejected alternative**

---

## 1. Money is stored as integers in öre

**Context:** Invoices, line items, late fees and payments all carry amounts.

**Decision:** Every money value is an `Int` counting öre (1 SEK = 100 öre),
named so the unit is unmistakable: `amountOre`, `unitPriceOre`, `lateFeeOre`.

**Why:** Floating-point numbers cannot represent most decimal fractions
exactly. `0.1 + 0.2 === 0.30000000000000004`. Over thousands of invoices those
errors accumulate into real money that does not reconcile. Integers are exact.

**Rejected:** `Float`/`Decimal` columns. Postgres `NUMERIC` would be exact, but
JavaScript has no native decimal type, so values would still pass through
`Number` somewhere in the stack and lose precision. Integers avoid the problem
in every layer at once.

**Consequence:** conversion happens only at the display edge —
`(ore / 100).toFixed(2) + ' SEK'`. Never in business logic.

---

## 2. Financial history is append-only

**Context:** Invoices change status, gain late fees, and get paid.

**Decision:** `Transaction` and `AuditLog` rows are never updated or deleted.
Invoices are never deleted either — only their `status` changes. A correction
is a **new** row with a negative amount and type `ADJUSTMENT`.

**Why:** An auditor must be able to reconstruct what the system believed at any
point in time. If a row can be edited, history is not evidence. This is also a
legal requirement for accounting records in Sweden.

**Rejected:** Updating rows in place with an `updatedAt` timestamp. Simpler,
but it destroys the audit trail — you can see that something changed, never
what it was before.

---

## 3. Money operations are atomic

**Decision:** Any change to an invoice's balance and its corresponding
`Transaction` row happen inside one `prisma.$transaction`.

**Why:** A payment recorded without its transaction row is corrupt data — the
invoice says paid, the ledger disagrees, and nothing reconciles. Both rows
land or neither does.

---

## 4. Layered architecture: route → controller → service → repository

**Decision:** Each layer may only call the one below it. Services take plain
arguments and return plain data — they never receive `request` or `reply`.

**Why:** The overdue-invoice job runs from a BullMQ worker and a cron trigger,
where no HTTP request exists. A service coupled to `request` simply cannot be
called from there. Keeping services HTTP-agnostic is what makes the same
business logic reusable from an API route, a background job, and a test.

**Rejected:** Logic in route handlers. Faster to write, impossible to reuse,
and untestable without spinning up an HTTP server.

---

## 5. Bun + Fastify + Prisma 7 on PostgreSQL

**Decision:** Bun as runtime, Fastify 5 as framework, Prisma 7 as ORM.

**Why:** Relational data (clients → invoices → line items → transactions) fits
Postgres naturally. Prisma gives type-safe queries and versioned migrations.
Fastify is fast, has real plugin encapsulation, and was already familiar.

**Note on Prisma 7:** the Rust query engine is gone. The application now
supplies the database driver (`pg`) wrapped in a *driver adapter*. This is why
`pg` and `@prisma/adapter-pg` are dependencies, and why the connection URL
lives in `prisma.config.ts` rather than `schema.prisma`.

---

## 6. Shared resources registered through `fastify-plugin`

**Decision:** `app.prisma` and `app.redis` are decorated inside plugins wrapped
in `fp()`.

**Why:** Fastify encapsulates plugins by default — anything a plugin registers
is invisible to its parent. Without `fp()`, `app.decorate('prisma', ...)` is
scoped to that plugin only and routes fail with "prisma is not defined". `fp()`
explicitly breaks encapsulation so the decoration applies app-wide.

**Also:** one `PrismaClient` per process, never per request. A client owns a
connection pool; one per request would exhaust Postgres's connection limit.

---

## 7. Environment variables validated at boot (fail fast)

**Decision:** `lib/env.ts` validates all env vars with Zod at startup and calls
`process.exit(1)` on failure. Nothing reads `process.env` directly afterwards.

**Why:** Without it, a missing `JWT_SECRET` lets the app boot happily and
crash later — possibly in production, mid-payment. A crash at startup is a good
crash: it happens in front of whoever just deployed.

---

## 8. Liveness and readiness are separate endpoints

**Decision:** `/health` reports the process is alive. `/health/ready` verifies
Postgres and Redis actually respond, returning 503 if not.

**Why:** They answer different questions. A load balancer should stop sending
traffic to an instance whose database is down (`ready` fails) without killing
and restarting it (`live` still passes).

---

## 9. Graceful shutdown on SIGINT/SIGTERM

**Decision:** `app.close()` drains in-flight requests and runs `onClose` hooks
before the process exits.

**Why:** In a payment system a request killed mid-transaction can leave
inconsistent state. `docker stop` and every hosting platform send SIGTERM
first — honouring it is the difference between a clean stop and corruption.

---

## 10. Argon2id for passwords — not bcrypt

*Decided 2026-08-03, superseding an earlier bcrypt cost-12 plan.*

**Decision:** `@node-rs/argon2` with OWASP 2024 parameters —
`memoryCost: 19456` (19 MiB), `timeCost: 2`, `parallelism: 1`.

**Why:** Argon2id is **memory-hard**. Cracking rigs get their advantage from
massive parallelism, and GPUs/ASICs have limited fast memory per core — forcing
19 MiB per hash attempt removes most of that advantage. bcrypt is CPU-hard but
memory-cheap, so it parallelises far better for an attacker.

Argon2id also has no length trap. **bcrypt silently truncates at 72 bytes** — a
100-character passphrase quietly loses its last 28 characters, with no error.

**Rejected:** bcrypt cost 12 (still OWASP-acceptable, widely deployed, but
strictly weaker here); `Bun.password` (built in, but would tie auth code to the
Bun runtime); the `argon2` npm package (needs a node-gyp compile step, whereas
`@node-rs/argon2` ships prebuilt binaries).

---

## 11. Password policy follows NIST SP 800-63B

**Decision:** Minimum 12 characters. Maximum 128 (a DoS guard, not policy).
**No** composition rules. **No** forced rotation. Unicode normalized to NFKC.
Checked against known-breached passwords.

**Why:** This is the opposite of conventional wisdom, and the conventional
wisdom is wrong. "Must contain uppercase, number and symbol" reliably produces
`Password1!` — it *reduces* real entropy by pushing everyone into the same
predictable patterns. Forced rotation produces `Summer2026` → `Summer2027`.
Length and breach-checking catch far more real attacks than complexity ever did.

NFKC normalization matters because the same passphrase typed on different
devices can produce different byte sequences — and would then hash differently,
locking the user out of their own account.

---

## 12. Breach checking via HaveIBeenPwned k-anonymity

**Decision:** On password set/change, send the **first 5 characters** of the
password's SHA-1 hash to the HIBP range API, receive ~800 candidate suffixes,
and match locally.

**Why:** It checks against roughly a billion real breached passwords without
the password — or even its full hash — ever leaving our server. HIBP never
receives enough information to identify which password was checked.

**Failure mode:** if the API is unreachable we fail *open* (allow the password).
Rejecting logins because a third-party service is down would be worse.

---

## 13. No public registration — admin provisions users

*Decided 2026-08-03.*

**Decision:** There is no `POST /auth/register`. An admin creates the `User`
and `Client` rows together in one transaction. The first ADMIN comes from a
seed script.

**Why:** Two reasons. Structurally, `Client.userId` is required and unique — a
self-registered user would have no `Client` record and a broken portal.
Practically, this is how every real invoicing and banking system works: you do
not sign yourself up as a customer of an accounts-receivable ledger. It also
removes an entire class of abuse (fake signups, enumeration on register).

**Rejected:** Public registration with a forced `CLIENT` role. Easier to test,
but leaves the missing-`Client`-record problem unsolved.

---

## 14. Access + refresh tokens with rotation and theft detection

**Decision:** 15-minute access token (JWT). 30-day refresh token — 256 random
bits, stored as SHA-256 in the `RefreshToken` table, rotated on every use.
All tokens from one login share a `familyId`. Using an already-rotated token
means it was stolen: the entire family is revoked and re-login is forced.

**Why:** A stolen access token is useless within 15 minutes. Rotation means a
stolen *refresh* token is only usable until the legitimate user next refreshes —
at which point the reuse is detected and everything is revoked. Without
rotation, a stolen refresh token grants 30 days of silent access.

**Rejected:** A single long-lived token. Simpler, but a leak means hours of
unrestricted access with no way to detect it.

---

## 15. SHA-256 for refresh tokens, Argon2id for passwords

**Decision:** Different hash algorithms for the two token types — deliberately.

**Why:** *Match the hash to the entropy of the input.* A refresh token is 256
bits from a CSPRNG: there is nothing to guess, so a slow hash adds no security
and makes every refresh expensive. A password is human-chosen and low-entropy:
slowness is the entire defence. Using Argon2id for refresh tokens would be
cargo-cult security; using SHA-256 for passwords would be negligence.

---

## 16. JWT with a Redis `jti` denylist

**Decision:** Each access token carries a unique `jti`. Logout writes that
`jti` to Redis with `TTL = exp - now`. `authenticate` checks the denylist.

**Why:** Pure stateless JWTs cannot be revoked — logout is a lie, the token
stays valid until expiry. The self-expiring TTL is the elegant part: the entry
evicts itself exactly when the token would have expired anyway, so the denylist
never grows unbounded and needs no cleanup job.

**Also:** never put PII in a JWT. It is base64-encoded, not encrypted — anyone
holding the token can read every claim.

---

## 17. `AuditLog.userId` is nullable

*Changed 2026-08-03; it was required in the original schema.*

**Decision:** `userId` is optional, and an `email` column records what was
attempted when no user matched.

**Why:** A failed login for an email that does not exist has no user to
reference. Those are precisely the events that reveal credential stuffing —
someone testing leaked passwords against thousands of addresses. The original
required foreign key made the single most security-relevant event in the system
impossible to record.

---

## 18. Audit logs are written in a separate transaction

**Decision:** The `AuditLog` write never shares a transaction with the business
operation it records, and a failed audit write never fails the user's operation.

**Why:** If they shared a transaction, a rollback would erase the evidence that
anything was attempted. For a failed login that is exactly backwards — the
rollback would delete the record you most need.

---

## 19. Rate limiting is Redis-backed, per IP *and* per account

**Decision:** Counters live in Redis, not process memory. Two layers: per IP,
and per account.

**Why:** In-memory limits reset on every deploy and are per-instance — three
instances means three times the allowed attempts. Per-IP alone misses slow
distributed attacks that rotate addresses; per-account alone misses an attacker
spraying one password across many accounts.

---

## 20. Account lockout — with a known trade-off

**Decision:** Progressive delays first (100ms, 400ms, 1.6s …), then lockout
after 5 failures as a backstop.

**Why the caveat matters:** pure hard lockout is a **self-inflicted denial of
service** — anyone can lock you out of your own account by deliberately failing
five times. Real banks pair lockout with progressive delays and unlock-by-email
rather than relying on lockout alone.

---

## 21. Auth failures return one generic error, in constant time

**Decision:** Every auth failure returns the same message, status and timing:
"Invalid email or password". When no user is found, a **dummy hash verify still
runs**.

**Why:** Distinguishing "no such user" from "wrong password" lets an attacker
enumerate your entire customer list. Timing does the same thing more subtly: if
an unknown email returns in 5 ms and a real one takes 300 ms (the Argon2id
cost), the response time itself is the answer. Running the dummy verify keeps
both paths equally slow.

---

## Open decisions

| Question | Status |
|---|---|
| Swagger/OpenAPI docs for the API? | Undecided |
| Superadmin role above ADMIN? | Undecided |
| BullMQ dashboard for job monitoring? | Undecided |
| Frontend protected-route guards | Deferred to Week 4 |
| 2FA / BankID | Deferred — post-MVP |
