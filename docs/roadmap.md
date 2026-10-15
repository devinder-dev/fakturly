# Roadmap — from single-company demo to Swedish invoicing SaaS

Fakturly today is a complete invoicing system for **one** company: invoices,
VAT, credit notes, late interest under räntelagen, reminder fees, Stripe
payments, SIE export, an append-only ledger and an audit log.

This roadmap adds what a real Swedish invoicing product needs next, in an
order chosen so every feature is built on the right foundation the first time.

Decided 2026-10-04. Status updated 2026-10-15.

## Status

| Wave | Status |
|---|---|
| 0 | Done — in review |
| 1 A — Multi-tenancy | In progress: phases 1–2 of 6 done (organizations; scoped writes and single-row reads) |
| 1 B — Standalone libraries | In progress: phases 1–2 of 4 done (personnummer + reverse OCR; TOTP + encrypted secrets) |
| 2–5 | Not started |

Every phase so far has also had an independent code review; its findings are
fixed in a separate commit before the next phase starts.

---

## Principles

- **Multi-tenancy comes first.** Every later feature is built tenant-scoped from
  day one, instead of being retrofitted.
- **Two parallel streams per wave.** One stream changes the core; the other
  builds something that does not touch the same files. Each stream works on its
  own branch, database, Redis index and ports, so their tests cannot interfere.
- **One phase = one commit = one review.** Every phase ends with a full-flow
  test and a walkthrough before the next one starts.
- The existing rules still hold: money in integer öre, an append-only ledger and
  audit log, layered architecture, a test for every bug.

## Decisions

| Question | Decision |
|---|---|
| When does multi-tenancy happen? | First, as the foundation |
| How many streams at once? | Two |
| BankID scope | Login for clients and admins; an admin links a personnummer to an existing user. Signing is out of scope |
| A customer who buys from several companies | **One login, one customer record per company.** Staff belong to exactly one company. Adding a customer answers the same whether the address is new or already known, so one company can't probe another's customers |
| Draft invoices | Hidden from the customer portal — a draft hasn't been issued |
| Samordningsnummer without a real date | Accepted — Skatteverket issues them, and rejecting them would lock real people out of BankID |
| AI | Last wave, once the whole domain is in place |

---

## Waves

| Wave | Stream A (core) | Stream B (parallel) |
|---|---|---|
| 0 | Fix the email worker (reminders were never sent) | — |
| 1 | **Multi-tenancy** | **Standalone libraries**: personnummer, reverse OCR, TOTP, encrypted secrets, BgMax parser, BankID client |
| 2 | **Payments v2**: partial and manual payments, Bankgiro import, review queue | **Login security**: TOTP for admins, BankID for everyone |
| 3 | Stripe refunds, recurring invoices | API keys, outbound webhooks |
| 4 | EU customers (VIES, reverse charge, EUR), Peppol e-invoices | Fortnox sync |
| 5 | AI layer: invoice autofill, payment-match suggestions | — |

ADR numbers are reserved per stream so parallel branches never collide:
wave 1 = 56 (A) and 57–59 (B), wave 2 = 60–64 (A) and 65–69 (B).

---

## Wave 0 — fix before building

The email worker was created without the queue's Redis key prefix, so it
listened on keys nothing wrote to: overdue notices and reminders were queued
and never sent. One-line fix, plus a regression test that uses the real queue
and the real worker on both ends.

## Wave 1

### A — Multi-tenancy (ADR 56)

- An `Organization` holds the seller's details (name, org number, VAT number,
  bankgiro, F-skatt, payment terms), replacing the single company configured in env.
- `organizationId` on users, clients, invoices and ledger rows. Composite
  foreign keys make a cross-tenant invoice or ledger row impossible at the
  database level.
- Every repository function takes the organization first; the few deliberate
  cross-tenant reads (the nightly overdue job, the Stripe webhook lookup) are
  named `…Unscoped` so they are easy to audit.
- One invoice-number series **per organization** — bokföringslagen wants an
  unbroken series per business.
- Staff belong to one organization; a customer has one login and a customer
  record per seller, and sees every seller's invoices in one portal. A database
  constraint enforces the difference.
- Seller details are **copied onto an invoice when it is sent**, so editing the
  company address never changes an invoice that was already issued.
- A cross-tenant test suite: an admin of company B gets the same 404 for company
  A's data as for data that doesn't exist — and a guard fails CI if a new route
  has no such test.
- Phases: organizations and the token claim → tenant columns and scoped writes →
  scoped reports and dashboard → seller details from the organization → settings
  page → demo with two companies.

### B — Standalone libraries (ADRs 57–59)

Pure code with no database, verified against the primary specifications:

- **Personnummer and organisationsnummer** validation (Skatteverket SKV 704/709),
  and a keyed HMAC so a personnummer can be looked up without being stored.
- **Reverse OCR**: from a payment reference back to the invoice number.
- **TOTP** (RFC 6238), tested against the RFC's own vectors, with replay protection.
- **Encrypted secrets at rest**: AES-256-GCM with versioned keys for rotation.
- **BgMax parser** for Bankgirot's incoming-payment files, tested against
  Bankgirot's own example files.
- **BankID** Relying Party API v6 client with mutual TLS, the animated QR code,
  and a stub that behaves like the real service for the demo.

## Wave 2

### A — Payments v2 (ADRs 60–64)

- Payments become rows of their own (Stripe, Bankgiro, manual), each
  idempotent. An invoice's paid amount is derived from the ledger.
- **Partial payments**, and late interest calculated on what is actually still owed.
- **Overpayments are recorded, never rejected** — money that arrived is a fact.
- **Bankgiro import**: upload a BgMax file; payments are matched to invoices by
  OCR reference; anything that doesn't match goes to a review queue. Importing
  the same file twice changes nothing.
- An admin page for imports, the review queue and manual matching.

### B — Login security (ADRs 65–69)

- **TOTP two-factor login** for admins, with recovery codes. Admins without it
  are guided to set it up, never locked out.
- **BankID login** for clients and admins, with the animated QR code and "open
  BankID on this device".
- The strength of a session (password, password + TOTP, BankID) travels with the
  session, so admin-only actions can require it.

## Wave 3

- **A — Refunds and recurring invoices.** Full or partial refunds of paid
  invoices through Stripe, booked as a credit note plus a refund in the ledger.
  Recurring invoices generated by a scheduled job, never twice for the same period.
- **B — API keys and outbound webhooks.** Organization-scoped API keys, stored
  hashed. Webhooks delivered through a transactional outbox, signed like
  Stripe's, retried with backoff, with protection against requests to internal
  addresses.

## Wave 4

- **A — EU customers and Peppol.** VAT-number check against VIES, reverse
  charge, EUR invoices at Riksbanken's rate on the issue date, and Peppol BIS
  Billing 3.0 export (required when invoicing the Swedish public sector).
- **B — Fortnox sync.** OAuth2 from the client side, tokens encrypted at rest,
  invoices synced through the wave-3 outbox.

## Wave 5 — AI layer

- **Invoice autofill**: paste text or upload a document; the client, lines, VAT
  and due date are proposed as a **draft** that a person always reviews before
  sending.
- **Payment-match suggestions** for Bankgiro payments that didn't match on their own.
- Designed around: what data leaves the server, documents treated as data and
  never as instructions, every field validated before use, and a test set to
  measure accuracy.

---

## How each wave is verified

- Backend: typecheck and the full test suite; frontend: build and unit tests;
  Playwright end-to-end where the wave adds a user flow.
- A full-flow test in the browser at the end of every phase.
- A security scan at the checkpoints that matter: authorization changes, file
  upload, login flows, outbound requests, OAuth callbacks.
- CI green on `main` after both streams of a wave have merged.

## Not scheduled yet

- A platform-admin UI for creating organizations (wave 1 uses a script)
- A dashboard for background jobs
- Security headers and CI hardening
