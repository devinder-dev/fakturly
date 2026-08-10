// auditLog.repository.ts — writes to the audit log. Only ever inserts.
//
// There is no update and no delete in this file, and there never will be.
// An audit log that can be edited is not evidence. Swedish bookkeeping law
// requires these records to be retained, and the whole value of the table is
// that a row, once written, is permanent.

import { prisma } from '../lib/prisma.ts'

export type AuditEntry = {
  /** Null when the acting user is unknown — e.g. a login for an email that does not exist. */
  userId?: string | null | undefined
  /** What was attempted, when no user matched. This is how credential stuffing becomes visible. */
  email?: string | null | undefined
  action: string
  resource: string
  resourceId?: string | null | undefined
  ipAddress?: string | null | undefined
  userAgent?: string | null | undefined
}

/**
 * Inserts one audit row.
 *
 * Note that this uses the global prisma client and NOT an interactive
 * transaction, and it deliberately accepts no transaction client as an
 * argument. That is a design decision, not an omission:
 *
 * If an audit write shared a transaction with the operation it records, a
 * rollback would erase the evidence that anything was attempted. For a failed
 * login that is exactly backwards — the rollback deletes precisely the record
 * you need. Keeping this outside means the log survives whatever happens to
 * the business operation.
 */
export async function createAuditEntry(entry: AuditEntry): Promise<void> {
  await prisma.auditLog.create({
    data: {
      userId: entry.userId ?? null,
      email: entry.email ?? null,
      action: entry.action,
      resource: entry.resource,
      resourceId: entry.resourceId ?? null,
      ipAddress: entry.ipAddress ?? null,
      userAgent: entry.userAgent ?? null
    }
  })
}
