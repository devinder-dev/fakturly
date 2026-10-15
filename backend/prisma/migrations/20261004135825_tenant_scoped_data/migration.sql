-- Tenant-scoped data (ADR 56, phase 2).
--
-- Every row of a company's data gets the organization it belongs to, and the
-- database is taught to refuse a row that mixes two organizations. Generated
-- by `prisma migrate diff`, then hand-edited into expand -> backfill ->
-- contract: Prisma's version added every column NOT NULL at once, which
-- fails on any database that has data. Runs as one transaction.
--
-- The backfill UPDATEs on "Transaction" and "AuditLog" below are the only
-- updates ever run on those tables (append-only, ADR 2). They fill in a
-- column that did not exist when the rows were written; no recorded fact
-- changes.

ALTER TYPE "EmailType" ADD VALUE 'CUSTOMER_ADDED';

-- ── 1. The placeholder organization from the previous migration ─────────
-- It was inserted with 559123-4567 / SE559123456701, which fail the Luhn
-- check digit. An applied migration must not be edited (its checksum is
-- recorded), so the row is corrected here. Guarded: a database where that
-- number already belongs to another organization keeps the old value
-- rather than failing on the unique index. The bankgiro 123-4567 is left
-- as it is: invalid on purpose, so a demo payment can never reach a real
-- account (ADR 56).
UPDATE "Organization"
SET "orgNumber" = '559123-4561',
    "vatNumber" = CASE WHEN "vatNumber" = 'SE559123456701' THEN 'SE559123456101' ELSE "vatNumber" END
WHERE "id" = 'org_default'
  AND "orgNumber" = '559123-4567'
  AND NOT EXISTS (SELECT 1 FROM "Organization" WHERE "orgNumber" = '559123-4561');

-- The canonical stored form, enforced below the validator: a raw-SQL insert
-- cannot store "5591234561" next to "559123-4561" and dodge the unique index.
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_orgNumber_format"
  CHECK ("orgNumber" ~ '^[0-9]{6}-[0-9]{4}$');

-- ── 2. Drop what is being replaced ──────────────────────────────────────
-- Plain foreign keys give way to composite ones; global uniques to
-- per-organization ones.
ALTER TABLE "Invoice" DROP CONSTRAINT "Invoice_clientId_fkey";
ALTER TABLE "Transaction" DROP CONSTRAINT "Transaction_invoiceId_fkey";
ALTER TABLE "User" DROP CONSTRAINT "User_organizationId_fkey";
DROP INDEX "Client_userId_key";
DROP INDEX "Invoice_invoiceNumber_key";
ALTER TABLE "InvoiceNumberSeries" DROP CONSTRAINT "InvoiceNumberSeries_pkey";

-- ── 3. Expand: the columns, nullable for now ────────────────────────────
ALTER TABLE "Client" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "InvoiceNumberSeries" ADD COLUMN "organizationId" TEXT;

-- ── 4. Backfill, parent before child ────────────────────────────────────
-- Until now every login carried an organization (previous migration), so a
-- customer record belongs to its login's organization. Must run BEFORE
-- step 5 clears that column on customer logins.
UPDATE "Client" c SET "organizationId" = u."organizationId"
FROM "User" u WHERE u.id = c."userId";

UPDATE "Invoice" i SET "organizationId" = c."organizationId"
FROM "Client" c WHERE c.id = i."clientId";

UPDATE "Transaction" t SET "organizationId" = i."organizationId"
FROM "Invoice" i WHERE i.id = t."invoiceId";

-- Audit rows: from the acting user first — STAFF only. A customer's own
-- events (logging in, setting a password) belong to no organization, which
-- is exactly how they are written from now on (step 5 takes customer logins
-- out of their organization). Filing them under the seller here would show
-- that seller's admin a customer's activity it was never meant to see.
-- Then from the record the event was about, for system events with no user
-- (the overdue job, Stripe, the operator scripts). What matches nothing — a
-- failed login for an unknown address — stays NULL, which is the truth.
UPDATE "AuditLog" a SET "organizationId" = u."organizationId"
FROM "User" u
WHERE u.id = a."userId" AND u."role" = 'ADMIN' AND a."organizationId" IS NULL;

UPDATE "AuditLog" a SET "organizationId" = i."organizationId"
FROM "Invoice" i WHERE a."resource" = 'Invoice' AND i.id = a."resourceId" AND a."organizationId" IS NULL;

UPDATE "AuditLog" a SET "organizationId" = c."organizationId"
FROM "Client" c WHERE a."resource" = 'Client' AND c.id = a."resourceId" AND a."organizationId" IS NULL;

UPDATE "AuditLog" a SET "organizationId" = o.id
FROM "Organization" o WHERE a."resource" = 'Organization' AND o.id = a."resourceId" AND a."organizationId" IS NULL;

UPDATE "AuditLog" a SET "organizationId" = u."organizationId"
FROM "User" u WHERE a."action" = 'ADMIN_CREATED' AND u.id = a."resourceId" AND a."organizationId" IS NULL;

-- Number series: until now one counter per year for everyone. Every
-- organization that issued numbers in a year continues from that year's
-- counter — never below it, so no number is ever issued twice. A year whose
-- invoices are all gone (deleted drafts only) keeps its counter with the
-- oldest organization. With no organization at all there can be no
-- invoices either, and the orphaned counter is dropped.
INSERT INTO "InvoiceNumberSeries" ("organizationId", "year", "lastNumber")
SELECT DISTINCT i."organizationId", s."year", s."lastNumber"
FROM "InvoiceNumberSeries" s
JOIN "Invoice" i ON i."invoiceNumber" LIKE s."year"::text || '-%'
WHERE s."organizationId" IS NULL;

UPDATE "InvoiceNumberSeries" s
SET "organizationId" = (SELECT id FROM "Organization" ORDER BY "createdAt", id LIMIT 1)
WHERE s."organizationId" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "InvoiceNumberSeries" t
    WHERE t."year" = s."year" AND t."organizationId" IS NOT NULL
  );

DELETE FROM "InvoiceNumberSeries" WHERE "organizationId" IS NULL;

-- ── 5. Customer logins leave their organization ─────────────────────────
-- Staff belong to exactly one organization; a customer login to none — it
-- reaches each seller through a Client row. The CHECK makes both halves of
-- that rule hold for every row, now and later.
ALTER TABLE "User" ALTER COLUMN "organizationId" DROP NOT NULL;
UPDATE "User" SET "organizationId" = NULL WHERE "role" = 'CLIENT';
ALTER TABLE "User" ADD CONSTRAINT "User_organization_matches_role"
  CHECK (("role" = 'ADMIN') = ("organizationId" IS NOT NULL));

-- ── 6. Contract ─────────────────────────────────────────────────────────
ALTER TABLE "Client" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Invoice" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Transaction" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "InvoiceNumberSeries" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "InvoiceNumberSeries" ADD CONSTRAINT "InvoiceNumberSeries_pkey" PRIMARY KEY ("organizationId", "year");

-- ── 7. Keys and indexes ─────────────────────────────────────────────────
-- The (id, organizationId) uniques come FIRST: a composite foreign key can
-- only reference a column pair that is unique.
CREATE UNIQUE INDEX "Client_id_organizationId_key" ON "Client"("id", "organizationId");
CREATE UNIQUE INDEX "Invoice_id_organizationId_key" ON "Invoice"("id", "organizationId");

CREATE UNIQUE INDEX "Client_organizationId_email_key" ON "Client"("organizationId", "email");
CREATE UNIQUE INDEX "Client_organizationId_userId_key" ON "Client"("organizationId", "userId");
CREATE UNIQUE INDEX "Invoice_organizationId_invoiceNumber_key" ON "Invoice"("organizationId", "invoiceNumber");

CREATE INDEX "Client_organizationId_createdAt_idx" ON "Client"("organizationId", "createdAt");
CREATE INDEX "Client_userId_idx" ON "Client"("userId");
CREATE INDEX "Invoice_organizationId_createdAt_idx" ON "Invoice"("organizationId", "createdAt");
CREATE INDEX "Transaction_organizationId_createdAt_idx" ON "Transaction"("organizationId", "createdAt");
CREATE INDEX "AuditLog_organizationId_createdAt_idx" ON "AuditLog"("organizationId", "createdAt");

-- ── 8. Foreign keys ─────────────────────────────────────────────────────
-- The composite ones are the point of this migration: an invoice cannot
-- reference another organization's client, nor a ledger row another
-- organization's invoice. ON UPDATE RESTRICT everywhere: the pair a row
-- points at may never be rewritten underneath it, and no change to an
-- organization may cascade into the ledger or the audit log (append-only).
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_clientId_organizationId_fkey"
  FOREIGN KEY ("clientId", "organizationId") REFERENCES "Client"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_invoiceId_organizationId_fkey"
  FOREIGN KEY ("invoiceId", "organizationId") REFERENCES "Invoice"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "Client" ADD CONSTRAINT "Client_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "InvoiceNumberSeries" ADD CONSTRAINT "InvoiceNumberSeries_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
