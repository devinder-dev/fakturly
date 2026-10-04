-- Organizations: every user belongs to exactly one (ADR 56, phase 1).
--
-- Hand-edited. Prisma generated `ADD COLUMN "organizationId" TEXT NOT NULL`,
-- which fails on any database that already has users: Postgres cannot invent
-- a value for the existing rows. A DEFAULT would make it pass, but would also
-- stay on the column and quietly file every FUTURE user under that org. So
-- the column goes in nullable, is backfilled, and only then becomes NOT NULL
-- (expand -> backfill -> contract). Prisma runs this file in one transaction:
-- a failure anywhere leaves the database exactly as it was.

-- 1. The tenant table.
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "orgNumber" TEXT NOT NULL,
    "vatNumber" TEXT,
    "address" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "bankgiro" TEXT,
    "fSkatt" BOOLEAN NOT NULL DEFAULT true,
    "paymentTermsDays" INTEGER NOT NULL DEFAULT 30,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Organization_orgNumber_key" ON "Organization"("orgNumber");

-- Every new table: Supabase's Data API must not reach it (ADR 54).
-- tests/integration/rls.test.ts fails if this line is missing.
ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY;

-- 2. Expand: the column, nullable for now.
ALTER TABLE "User" ADD COLUMN "organizationId" TEXT;

-- 3. Backfill. Until now there was exactly one seller, described by
--    env.COMPANY_*. Existing users all worked for it, so they move into one
--    organization standing in for it.
--
--    Inserted ONLY when there are users to adopt it. A fresh database (CI,
--    a new deployment) stays empty instead of gaining a company nobody asked
--    for — the first real one comes from `bun run org:create`.
--
--    A migration cannot read the environment, so the values are env.ts's
--    defaults (what every PDF showed when COMPANY_* was unset). A deployment
--    that had set COMPANY_* corrects them once in the company settings; the
--    demo replaces the row at its next reset.
INSERT INTO "Organization" ("id", "name", "orgNumber", "vatNumber", "address", "email", "bankgiro", "updatedAt")
SELECT 'org_default', 'Fakturly Demo AB', '559123-4567', 'SE559123456701',
       'Sveavägen 1, 111 57 Stockholm', 'faktura@fakturly.se', '123-4567', CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "User");

UPDATE "User" SET "organizationId" = 'org_default' WHERE "organizationId" IS NULL;

-- 4. Contract: from here on a user without an organization cannot exist.
ALTER TABLE "User" ALTER COLUMN "organizationId" SET NOT NULL;

CREATE INDEX "User_organizationId_idx" ON "User"("organizationId");

ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
