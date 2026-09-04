// auditLog.repository.ts — the audit log. Inserts and reads; never anything else.
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

// ─────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────

export type AuditLogRow = {
  id: string
  action: string
  resource: string
  resourceId: string | null
  /** The acting user's email, looked up now — the row stores only the id. */
  actorEmail: string | null
  /** The email that was attempted, for events with no user (failed logins). */
  email: string | null
  ipAddress: string | null
  userAgent: string | null
  createdAt: Date
}

export type AuditLogFilter = {
  limit: number
  offset: number
  action?: string | undefined
  resourceId?: string | undefined
  userId?: string | undefined
}

export type AuditLogPage = {
  entries: AuditLogRow[]
  total: number
}

/**
 * A page of the log, newest first.
 *
 * Every filter maps onto an index the schema already has: [action,
 * createdAt], [userId, createdAt]. resourceId is not indexed — "everything
 * that happened to this invoice" is a rare, human-driven query and the table
 * is scanned for it. Worth an index the day it is not rare.
 */
export async function findAuditEntries(filter: AuditLogFilter): Promise<AuditLogPage> {
  const where = {
    ...(filter.action ? { action: filter.action } : {}),
    ...(filter.resourceId ? { resourceId: filter.resourceId } : {}),
    ...(filter.userId ? { userId: filter.userId } : {})
  }

  const [rows, total] = await prisma.$transaction([
    prisma.auditLog.findMany({
      where,
      select: {
        id: true,
        action: true,
        resource: true,
        resourceId: true,
        email: true,
        ipAddress: true,
        userAgent: true,
        createdAt: true,
        user: { select: { email: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: filter.limit,
      skip: filter.offset
    }),
    prisma.auditLog.count({ where })
  ])

  return {
    entries: rows.map((row) => ({
      id: row.id,
      action: row.action,
      resource: row.resource,
      resourceId: row.resourceId,
      actorEmail: row.user?.email ?? null,
      email: row.email,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      createdAt: row.createdAt
    })),
    total
  }
}
