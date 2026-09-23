// rls.test.ts — every table has Row Level Security on.
//
// Supabase exposes `public` over its REST API to anyone with the public
// anon key. The lock-down migration (ADR 54) enables RLS on every table that
// existed then; a table added by a later migration would not get it. This
// test is what makes the next migration author add
//   ALTER TABLE "NewTable" ENABLE ROW LEVEL SECURITY;
// instead of quietly reopening the hole.

import { describe, test, expect } from 'bun:test'
import { prisma } from '../../src/lib/prisma.ts'

describe('row level security', () => {
  test('is enabled on every table in the public schema', async () => {
    const withoutRls = await prisma.$queryRaw<Array<{ table: string }>>`
      SELECT c.relname AS "table"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND NOT c.relrowsecurity
      ORDER BY 1
    `

    expect(withoutRls.map((row) => row.table)).toEqual([])
  })

  test('does not get in the way of the app itself', async () => {
    // RLS with no policies denies everyone who does not bypass it. The app
    // must be one who does (table owner, or BYPASSRLS on Supabase) — if not,
    // every query would silently return zero rows.
    const users = await prisma.user.count()
    expect(users).toBeGreaterThanOrEqual(0)

    const [role] = await prisma.$queryRaw<Array<{ bypasses: boolean }>>`
      SELECT (r.rolbypassrls OR r.rolsuper
              OR EXISTS (SELECT 1 FROM pg_tables t
                         WHERE t.schemaname = 'public' AND t.tablename = 'User'
                           AND t.tableowner = current_user)) AS bypasses
      FROM pg_roles r WHERE r.rolname = current_user
    `
    expect(role?.bypasses).toBe(true)
  })
})
