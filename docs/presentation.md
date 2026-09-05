# Presenting Fakturly

A script for showing the project in an interview or a portfolio review, in
about ten minutes. Each section has what to show, what to say, and the
question it usually provokes.

The audience is an economy or fintech company. They will not be impressed by
React; they will be impressed by a ledger that balances and a credit note that
follows bokföringslagen. Lead with the domain, let the engineering support it.

---

## 0. The one-sentence version

> "Fakturly is an invoicing system built the way a financial system has to be
> built: money is integers, history is never rewritten, and a sent invoice is
> corrected with a credit note rather than an edit. I built it to understand
> *why* those rules exist, and every decision is written down with the
> alternative I rejected."

If you only get thirty seconds, that is the thirty seconds.

---

## 1. Open the landing page, log in as admin (1 min)

**Show:** the landing page, the two demo buttons, the dashboard.

**Say:** the demo accounts are published on purpose, and the whole dataset is
rebuilt every night by the same code that creates real invoices. The dashboard
figures come from the ledger, not from a cached total — there is no second
copy of the truth to drift.

**Likely question:** *"What happens if someone breaks the demo?"* — The reset
is the only code in the repository that deletes a ledger row. It refuses to
run in production without an explicit flag, it deletes everything or nothing,
and it lives outside the layered architecture so nothing can import it by
accident. (ADR 36.)

## 2. Open an overdue invoice (2 min)

**Show:** an OVERDUE invoice. Point at the totals box: net, VAT, interest,
reminder fee, total due. Scroll to the ledger.

**Say:** every figure on this screen traces to a row in the ledger. The
interest is one row per nightly run, calculated under räntelagen — reference
rate plus eight points, per day — not a flat penalty, because a flat penalty
that was never agreed is unenforceable. The ledger rows sum to exactly what is
outstanding; that sum is computed on screen from the rows, not read from a
column.

**Then click PDF.** The document has everything mervärdesskattelagen requires:
the number from the unbroken series, org and VAT numbers, VAT per rate,
*Godkänd för F-skatt*, and an OCR reference with a Luhn check digit — the
customer's bank rejects a typo before the money leaves.

**Likely question:** *"Why öre?"* — Because 0.1 + 0.2 is not 0.3 in floating
point, and an invoicing system that loses an öre on every line loses real
money at month end. Integers are exact. Conversion to kronor happens once, at
the display edge, and the formatted string is never parsed back.

## 3. Credit it (2 min)

**Show:** press *Kreditera*, read the confirmation text, confirm. You land on
the credit note. Click back to the original.

**Say:** a sent invoice cannot be edited — not "should not", cannot: there is
no endpoint. The lawful correction is a new document with the next number in
the same series, mirroring every line with a negated quantity. The original
moves to CREDITED and its ledger gains rows that bring it to zero: minus the
gross, minus the interest, minus the fee. Nothing was deleted; the history of
"we invoiced, then we credited" is all there.

**Likely question:** *"What about a paid invoice?"* — That is a refund: money
moving the other way, a Stripe call, its own ledger rows. The transition table
refuses it rather than half-doing it. It is the next natural extension, and
ADR 40 says so. Honest scope beats a feature that is wrong in the edge case.

## 4. Reports (1 min)

**Show:** Rapporter → Kundreskontra. Change the date. Then Momsrapport, then
the SIE download.

**Say:** the aging report takes an *as-of* date as an argument, so an
auditor's "how did the receivables look at year end" is a normal call. The VAT
report is what goes in the boxes on the return; credit notes reduce it. The
SIE file is the format every Swedish accounting system imports — each ledger
row becomes a balanced verification on the BAS chart, and the exporter throws
if one does not balance. It is encoded in CP437 because the 1990s standard
says so and every importer still expects it.

**Likely question:** *"Why semicolons in the CSV?"* — Because a Swedish Excel
uses the comma as the decimal separator and would split every amount in two.
Also: a leading tab before `=` so a customer-typed description cannot execute
as a formula. Small things; they are the difference between a file an
accountant opens and one they send back.

## 5. The audit log and the API docs (1 min)

**Show:** Logg. Filter to LOGIN_FAILED or CREDIT_NOTE_ISSUED. Then open
`/docs` on the API.

**Say:** every security-relevant action, in its own transaction so a rollback
cannot erase it, with no endpoint anywhere that updates or deletes an entry.
The API reference is generated from the same Zod schemas that validate
requests, and a test fails the build if a route is added without a docs entry.

## 6. The engineering, briefly (2 min)

Only if asked, or if the audience is technical. Pick two:

- **Layers.** Route → controller → service → repository. Services take plain
  arguments and never see a request, which is why the nightly overdue job
  and the demo seed can call the same code the API does.
- **Idempotency.** Stripe delivers at least once. Three layers: the event id
  is claimed *before* the work, the status guard is in the WHERE clause, and
  unknown events return 200 so Stripe stops retrying.
- **Auth.** Argon2id, NIST password rules, breach checking with k-anonymity,
  refresh-token rotation with family revocation on reuse, a Redis denylist so
  logout is real, and every auth failure identical in text and in time.
- **Tests.** 410 backend tests against a real Postgres and Redis, frontend
  unit tests, and one Playwright test that goes from a blank form to PAID
  through the webhook. CI runs all of it, builds the Docker image, and fails
  on a committed secret.

## 7. What I would do next

Have an answer ready; it shows the scope was chosen, not run out of.

1. Partial credit notes and refunds of paid invoices (the two gaps ADR 40 names)
2. Move the workers to their own process — the code already allows it
3. BankID login for the client portal
4. Multi-company: the seller details are configuration today, a table tomorrow

---

## If the demo is down

Render's free tier sleeps after fifteen minutes and takes a minute to wake.
Open the landing page before the meeting. If it will not come up, the
screenshots in `docs/screenshots/` and the PDF in the README show everything
above; the ledger screenshot alone carries the credit-note story.

## Numbers worth having in your head

| | |
|---|---|
| Backend tests | 410, against real Postgres and Redis |
| Architecture decisions | 46, each with the rejected alternative |
| Floats in money code | 0 |
| Lines that delete a ledger row outside the demo reset | 0 |
| Layers of webhook idempotency | 3 |
| Reminder fees per debt | 1, enforced by the database |
