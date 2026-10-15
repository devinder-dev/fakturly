-- When a login's owner last chose a password (ADR 56, phase 2 review).
--
-- A customer login provisioned by a seller is NOT activated until its owner
-- redeems the invite: until then its password is random and nobody knows it.
-- When a second seller adds the same customer, that difference decides the
-- email: an activated login is told "log in as usual"; a pending one gets a
-- fresh invite, because "as usual" means nothing to someone who never chose
-- a password. The fact is recorded here rather than inferred at runtime: the
-- demo seed sets passwords without any token, and token rows may one day be
-- pruned.

ALTER TABLE "User" ADD COLUMN "passwordSetAt" TIMESTAMP(3);

-- Backfill, once — from the AUDIT LOG, not from PasswordToken.
--
-- A "used" token does not prove a password was chosen: issuing a new invite
-- or a reset marks every outstanding token used WITHOUT redeeming it
-- (invalidateAllForUser). A customer who was re-invited, or asked for a
-- reset, but never set a password would look activated. Every real
-- redemption writes PASSWORD_SET or PASSWORD_RESET to the audit log, which
-- is never deleted; the latest is when the password was last chosen.
-- Failing that, a successful login proves the owner knew a password (the
-- demo's seeded customer has no token at all): the first one stands in.
-- This only READS the audit log.
UPDATE "User" u
SET "passwordSetAt" = COALESCE(chosen."at", proven."at")
FROM "User" target
LEFT JOIN (
  SELECT "userId", max("createdAt") AS "at"
  FROM "AuditLog"
  WHERE "action" IN ('PASSWORD_SET', 'PASSWORD_RESET') AND "userId" IS NOT NULL
  GROUP BY "userId"
) chosen ON chosen."userId" = target.id
LEFT JOIN (
  SELECT "userId", min("createdAt") AS "at"
  FROM "AuditLog"
  WHERE "action" = 'LOGIN_SUCCESS' AND "userId" IS NOT NULL
  GROUP BY "userId"
) proven ON proven."userId" = target.id
WHERE target.id = u.id
  AND COALESCE(chosen."at", proven."at") IS NOT NULL;

-- Staff: every ADMIN was created by the seed script with a password its
-- operator chose, so it counts as set from the start.
UPDATE "User"
SET "passwordSetAt" = "createdAt"
WHERE "role" = 'ADMIN' AND "passwordSetAt" IS NULL;
