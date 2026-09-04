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

## 22. VAT lives on the line item, not the invoice

**Context:** The original schema had no VAT anywhere, which meant it could not
produce a legally valid Swedish invoice.

**Decision:** Each `InvoiceItem` carries its own `vatRate`, plus stored
`netOre`, `vatOre` and `grossOre`. The invoice stores `netTotalOre`,
`vatTotalOre` and `grossTotalOre`.

**Why per line:** one invoice legitimately mixes rates — consulting at 25% and
a printed book at 6% on the same document. A single rate per invoice would
have needed a second migration the first time that happened.

**Why rates are basis points** (`2500` = 25.00%): the same reason money is öre.
`0.25` has no exact binary representation, and a VAT rate multiplied by an
amount is exactly where that error would land.

**Why the amounts are stored, not computed on read:** an invoice is a financial
record. What it said when it was issued must not change because a calculation
was later corrected.

---

## 23. VAT is rounded per line, then summed

**Decision:** Round each line's VAT to whole öre, then add those up. Not: sum
the net and apply VAT once.

**Why:** the two genuinely differ. Three lines of 33 öre at 25% give **24 öre**
per-line and **25 öre** total-first. Per-line is what the printed invoice
shows — each row displays its own VAT, and those displayed figures must add up
to the stated total, or the document visibly does not sum.

Skatteverket permits either method. It does not permit switching between them.

---

## 24. Rounding is half away from zero

**Decision:** `roundOre` rounds `0.5` up and `-0.5` down. Not `Math.round`.

**Why:** `Math.round(-0.5)` is `0` — it rounds half toward positive infinity.
That asymmetry means a credit note would fail to cancel its original invoice by
one öre. The result is a ledger that will not balance, discovered months later,
with no obvious cause.

Tested directly: `roundOre(-x) === -roundOre(x)`, and a credit note cancels its
original to exactly zero.

---

## 25. Invoice numbers are allocated server-side from a per-year counter

**Context:** Bokföringslagen requires invoice numbers to form an unbroken
series. The point is that a deleted invoice cannot be hidden: if `2026-0007` is
missing, that absence is visible and must be explained.

**Decision:** A single `INSERT … ON CONFLICT DO UPDATE … RETURNING` against an
`InvoiceNumberSeries` row. The caller never supplies a number.

**Rejected — read then write:** between reading 7 and writing 8, another request
reads 7 too. Both write 8. Two invoices, one number. It only appears under
load, which for an invoicing system means month end.

**Rejected — `SELECT … FOR UPDATE` inside the invoice transaction:** it would
hold the lock until the whole invoice commits, serialising every invoice
creation in the system behind one row.

**Accepted cost:** because allocation runs in its own transaction, a later
failure leaves a number unused. A gap is explainable; a duplicate is not.

Verified with 50 parallel allocations producing an unbroken 1–50.

---

## 26. The ledger entry is written on send, not on creation

*Discovered by a failing test, 2026-08-14.*

**Context:** Deleting a DRAFT invoice failed on a foreign key — the
`INVOICE_CREATED` transaction row pointed at it.

**Rejected fix:** `onDelete: Cascade` on `Transaction`. It would have made the
test pass and made ledger rows deletable, quietly destroying the append-only
guarantee in decision 2.

**Decision:** A DRAFT writes no ledger row. `markSent` updates the status and
writes the entry in one transaction.

**Why:** a draft is not a financial event. Nobody has been invoiced, nothing is
owed, and it can still be deleted. The ledger records the moment the invoice
*becomes* a financial document — which is when it is sent, and from which point
it can never be edited or deleted.

Both facts must land together: an invoice marked SENT without its ledger row
means money is owed and the ledger does not know.

---

## 27. A sent invoice is frozen; only drafts can be deleted

**Decision:** `DRAFT → SENT → PAID | OVERDUE`, encoded as a lookup table rather
than a chain of conditionals. DRAFT is the only deletable state.

**Why a table:** the rules can be read at a glance, and adding a status cannot
silently create a path nobody considered.

**Why frozen:** once sent, a copy exists outside our system and Swedish
bookkeeping law treats it as a financial record. A correction is a credit note,
never an edit. A deleted sent invoice would leave a hole in the numbered series
that somebody has to account for.

**Concurrency:** the expected status sits in the `WHERE` clause rather than
being checked beforehand, so two admins clicking "send" simultaneously cannot
both succeed. Verified that a refused second send writes no second ledger row.

---

## 28. Ownership checks answer 404, never 403

**Decision:** A client requesting a row belonging to someone else gets the same
response as one requesting a row that never existed.

**Why:** 403 means "this exists, and it is not yours". Walk a range of ids and
every 403 is a real record — the customer base, enumerated, without ever seeing
a single row.

**It matters more for invoices than for clients:** numbers are sequential by
law, so confirming that `2026-0007` exists reveals how many invoices the
business has issued this year. That is commercially sensitive on its own.

**Related:** list endpoints scope the QUERY, not the results. Filtering after
fetching means another client's rows were already read into memory, and one
forgotten filter later they are in a response.

**Cost:** worse debugging. A developer hitting the wrong id sees "not found"
rather than "wrong account". The same trade as the identical login errors in
decision 21.

---

## 29. Late fees follow räntelagen, not a flat percentage

*Changed 2026-08-14. The original plan was 10% of the invoice.*

**Decision:** Dröjsmålsränta at referensränta + 8 percentage points, annual,
accruing per day from the due date. Räntelagen (1975:635) § 6.

**Why the flat percentage was wrong:** it does not grow with the delay. The
same 1 250 kr whether the customer is one day late or two years. That is a
**penalty**, not interest — and a penalty clause never contractually agreed is
generally unenforceable. It also under-charges the debtor who is a year late
and over-charges the one who is a day late.

30 days late is 102,74 kr on a 12 500 kr invoice. 400 days is 1 369,86 kr.

**The reference rate lives in `money.ts` with the date it was last checked**,
because the Riksbank changes it twice a year. A hardcoded rate with no
provenance is worse than one you can verify.

---

## 30. Interest accrues; each accrual is its own ledger row

**Decision:** The daily job charges only the **increment** since the last run,
and writes a `LATE_FEE_ADDED` row for it.

**Why not the total each run:** the job runs daily. Charging the full accrued
interest every time would compound it into nonsense within a week.

**Why one row per accrual:** the rows sum exactly to the fee shown on the
invoice, so the figure is explainable line by line. A customer who sees a
number that changed without explanation disputes it; one who can read where it
came from usually pays it. Verified by asserting the sum.

---

## 31. `runOverdueCheck` takes the clock as an argument

**Decision:** `runOverdueCheck(now: Date)` rather than reading `new Date()`
internally.

**Why:** it is the difference between "what happens 400 days late" being a
one-line test and being a test nobody can write. A job whose behaviour depends
on a hidden clock can only be tested by waiting or by mocking time globally,
and neither produces a test anyone trusts.

---

## 32. cron enqueues; BullMQ executes

**Decision:** node-cron only adds a job to a queue. BullMQ owns execution,
with retries, backoff and a record of every attempt.

**Why not cron alone:** a job that throws is simply gone. No retry, no record,
no way to know. "Late fees silently stopped being applied" is a revenue
problem nobody notices for a month.

**Scheduled at 02:00 Europe/Stockholm**, not midnight: interest is counted in
whole days from the due date, so a run landing on the wrong side of midnight
charges a day too many or too few.

---

## 33. BullMQ gets its own Redis connection

**Decision:** A separate connection with `maxRetriesPerRequest: null`.

**Why:** workers BLOCK — BullMQ waits for jobs with blocking commands that
occupy the connection entirely. Sharing the app's connection would stall every
rate-limit check behind an idle worker. And the two have opposite needs: a
request should fail fast, a worker should wait through a blip.

**Related gotcha, found by a smoke test:** BullMQ rejects a colon in a queue
name, because it builds its own keys as `prefix:queueName:...`. Namespacing
goes in `prefix`. The failure is at construction, at runtime — and because our
queues are created lazily, 287 tests passed while the server could not boot.

---

## 34. Three layers of webhook idempotency

**Context:** Stripe guarantees *at least once* delivery and retries for days.

**Decision:**

1. `ProcessedWebhookEvent` claims Stripe's event id as a primary key. One
   INSERT; a conflict means we have seen it. **Atomic** — a SELECT-then-INSERT
   would let two simultaneous retries both find no row and both proceed.
2. `markPaid` matches only `SENT` or `OVERDUE`, so the same payment arriving
   as a *different* event still cannot be applied twice.
3. Unhandled event types return 200, so Stripe stops retrying things we will
   never act on.

Layers 1 and 2 are genuinely separate: the same payment can arrive as two
events, and the same event can be delivered twice.

**The claim happens before the work.** Recording afterwards would let a crash
in between turn the retry into a double payment.

Verified with five concurrent deliveries of one event producing exactly one
`PAYMENT_RECEIVED` row.

---

## 35. External providers sit behind a stub-capable boundary

**Decision:** `lib/mailer.ts` and `lib/stripe.ts` each have a real path and a
stub path behind one interface. Nothing above `lib/` knows which is active.

**Why:** the whole payment and email flow can be built and tested without an
account, and turning on the real thing is a configuration change rather than a
code change.

**The stubs are not no-ops.** The Stripe stub signs and verifies with the same
HMAC-SHA256 scheme Stripe uses, so the signature path — including rejection of
a forged one — is genuinely exercised. A stub that accepted anything would
leave the most important check in the payment flow untested until production.

**Production cannot run on stubs:** `env.ts` refuses to boot without the real
keys when `NODE_ENV=production`. A convenience that can ship by accident is
not a convenience.

---

## 36. The demo environment is disposable, and one file may delete ledger rows

**Context:** a public showcase needs data a stranger can log in and break,
and it needs to be intact again the next morning.

**Decision:** `src/demo/seed.ts` wipes every table and rebuilds a dataset.
It is the only code in the repository that deletes a `Transaction` or an
`AuditLog` row.

**Why it is safe:**

1. It refuses to run in production unless `DEMO_MODE=true` is set explicitly.
2. It deletes everything or nothing — there is no "remove this invoice" path
   that a later feature could quietly reuse.
3. It lives in its own folder, outside the layered architecture, so nothing
   in `services/` or `repositories/` can import it by accident.
4. The nightly reset worker and the `GET /demo` route are constructed only
   when the flag is on. In a real deployment they do not exist, rather than
   existing and refusing.

**The data is produced by the real code paths.** Invoices go through
`invoice.service`, payments through the same repository function the Stripe
webhook uses, and overdue interest comes from running the actual nightly job
against a past date. Only timestamps are then moved into the past. A seed that
inserted rows directly would drift from the real rules the first time a rule
changed.

**Rejected:** a `?demo=1` flag on the frontend with hardcoded credentials.
The API decides whether it is a demo; the frontend asks `GET /demo` and shows
the buttons only if it answers. One source of truth, and no credentials in a
JavaScript bundle that is not in demo mode.

---

## 37. The dashboard reads the ledger, not the invoices

**Decision:** "invoiced this month" and "received this month" are sums over
`Transaction` rows by date. "Outstanding" and "overdue" are sums over
`Invoice` by status.

**Why:** the two questions are different. What is owed *now* is current state,
and the invoice table holds it. What *happened* in March is an event with a
date, and the ledger is the record of events. Reading "received" from
`Invoice.paidAt` gives the same answer today and a different one the day a
payment is corrected — the ledger keeps the original row and adds an
adjustment; `paidAt` just changes.

**The one raw query:** Prisma's `groupBy` cannot truncate a timestamp to its
month, so the monthly series is a `$queryRaw` tagged template with
`date_trunc('month', "createdAt" AT TIME ZONE 'Europe/Stockholm')`. Tagged
template, so the date is a bound parameter; the time zone conversion, because
an invoice sent at 00:30 on the 1st in Stockholm is still the 31st in UTC and
would land in the wrong month.

**Nothing is stored.** A dashboard that caches its own totals is a second copy
of the truth, and two copies drift.

---

## 38. PDFs are rendered on request, never stored

**Decision:** `GET /invoices/:id/pdf` renders the document from the invoice
row every time, with `@react-pdf/renderer`, behind the same ownership check as
the JSON endpoint.

**Why render, not store:** the invoice row *is* the record. A stored file is a
second copy that can disagree with it. A sent invoice is frozen, so
regenerating always yields the same document; a draft or an overdue invoice
changes, and a cached file would show yesterday's amount.

**Why React for a PDF:** the library describes a document as components laid
out with flexbox. The alternative, pdfkit, is a pen: every label at an x/y
coordinate, and a table is a page of arithmetic. For a document whose layout
must not break when a description wraps, flexbox wins. React in the backend
exists for this one purpose and touches no DOM.

**What the document must contain** is decided by mervärdesskattelagen, not by
taste: invoice number from the unbroken series, issue date, seller's
organisation and VAT numbers, both parties' names and addresses, the taxable
amount and VAT *per rate*, and the words *Godkänd för F-skatt*. The late-fee
terms are printed because the reminder fee may only be charged if the invoice
said so in advance.

**The OCR reference** is derived from the invoice number — digits, a length
digit, a Luhn check digit — the scheme Bankgirot uses, so a customer's bank
rejects a mistyped reference before the money leaves. Derived on every render
rather than stored, so it cannot disagree with itself.

---

## 39. The frontend forgets where you were after a deliberate logout

**Context:** the route guard remembers the path an unauthenticated visitor was
heading to, so that login can send them back. Good for an expired session or a
deep link from an email.

**Decision:** after the user presses "log out", the guard drops that memory.

**Why:** the next person to log in on that browser may be someone else, and
"return to the invoice the previous user was reading" is not a feature. It was
found by the smoke test: logging out as the admin and in as a client landed the
client on the admin's last invoice — harmless because the API scopes by owner,
but wrong. `AuthProvider` exposes `hasLoggedOut`; the guard consults it.

---

## 40. A sent invoice is corrected by a credit note, never edited

**Context:** an invoice went out with the wrong amount. Every CRUD tutorial
answers with an edit form; bokföringslagen does not allow it.

**Decision:** `POST /invoices/:id/credit-note` creates a NEW document — type
`CREDIT_NOTE`, the next number in the SAME series, every line mirrored with a
negated quantity — and moves the original to `CREDITED`. Five writes in one
transaction: the status change (guarded by expected status in the WHERE
clause), the new document, a `CREDIT_NOTE_ISSUED` row for minus the gross,
and a write-off row for any interest and any reminder fee.

**Where the ledger rows go — on the original, not the credit note.** The
ledger follows the receivable: the original's rows now sum to exactly zero,
which is the property a customer or auditor checks. The credit note is the
document that explains why. Rows on the credit note instead would leave the
original's ledger claiming money that will never arrive.

**Same number series**, because the law counts credit notes as invoices. A
separate series would leave gaps in the "real" one that someone must explain.

**Not allowed: crediting a PAID invoice.** That is a refund — money moving
back to the customer, with a Stripe call and its own ledger rows. The
transition table refuses it rather than half-doing it. Partial credit notes
are the other natural extension; full credit came first because it has no
ambiguity about interest and fees (everything is written off).

**Consequence found by test:** a credit note is `SENT` with a due date, so the
overdue job had to learn `type: 'INVOICE'`, or every credit note would turn
overdue the next night and accrue negative interest.

---

## 41. The reminder fee is charged once, by the database

**Context:** lag (1981:739) om ersättning för inkassokostnader allows one
reminder fee of 60 kr per debt — and only if the invoice said so in advance.

**Decision:** `POST /invoices/:id/reminder` charges the fee on the first call
and merely re-sends on every later one. The "once" is `reminderFeeOre: 0` in
the UPDATE's WHERE clause, not a check in the service. Two admins pressing the
button at the same instant cannot both charge.

**Separate column from interest** (`reminderFeeOre` beside `lateFeeOre`),
because they are different legal things — interest compensates for time, the
fee for the cost of chasing — and the PDF, the SIE export and the customer
must see them apart. `totalDueOre()` in `lib/money.ts` is the one place the
three parts are added, so no screen can forget one.

**The terms are printed on every invoice** — "påminnelseavgift om 60,00 SEK" —
precisely because the fee is only chargeable if they were.

**The email goes through the queue**, after the fee is committed. A mail
outage must not lose the fee; a retry must not charge it twice.

**Also wired here:** sending an invoice now emails the customer. The function
had existed since week 3 and nothing called it.

---

## 42. Reports are computed, and exported in the formats accountants use

**Decision:** three admin reports, each a pure transformation of repository
reads, each with `asOf` or a period as an argument.

- **Kundreskontra (aging):** open invoices bucketed by days past due, per
  client, amounts including interest and fees. Bucketing in the service, not
  SQL — the set of open invoices is small and the edges are a business rule.
- **Momsrapport:** net and VAT per rate over documents ISSUED in the period
  (`sentAt`, `to` exclusive). `groupBy` in the database. Credit notes are
  negative lines, so they reduce the period exactly as Skatteverket expects.
- **SIE 4:** every ledger row becomes one balanced verification on the BAS
  chart of accounts: invoices as 1510 against 300x/26xx per VAT rate,
  payments 1930/1510, interest 8313, fees 3590. `buildSie` throws on a
  verification that does not balance — better here than in the auditor's
  import.

**CSV is Swedish CSV:** semicolon separator (a comma is the decimal
separator here), UTF-8 BOM (or åäö arrive as Ã¥Ã¤Ã¶), CRLF, and a leading
tab before `=`, `+`, `-`, `@` so a customer-typed description cannot execute
as a formula when opened in Excel.

**SIE is CP437:** the 1990s encoding the specification names and every
importer accepts. Only the Swedish letters need mapping; anything else
non-ASCII becomes a visible `?` rather than a silently wrong byte.

**The SIE export is audited** — a GET with no side effect on our data, but
the moment the ledger leaves the system.

---

## 43. The audit log is readable, and still only ever appended

**Decision:** `GET /audit-log` (admin) pages the log with filters on action,
user and resource. The repository gains a read function beside its one
insert. There is no route, service or repository function that updates or
deletes an entry — the invoice page's "Händelser" panel and the log screen
are views of rows that cannot change.

**Every invoice response carries its ledger** (`ledger[]`), for both roles.
The customer sees where the number came from; a figure with a visible
explanation is disputed less than one that changed overnight.

---

## Open decisions

| Question | Status |
|---|---|
| Swagger/OpenAPI docs for the API? | Undecided |
| Superadmin role above ADMIN? | Undecided |
| BullMQ dashboard for job monitoring? | Undecided |
| Frontend protected-route guards | Deferred to Week 4 |
| 2FA / BankID | Deferred — post-MVP |
