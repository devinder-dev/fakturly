// seed.ts — creates the first ADMIN.
//
// This exists because of a deliberate design choice: there is no public
// registration, and the only route that creates users requires an existing
// ADMIN to call it. That is a chicken-and-egg problem on a fresh database,
// and a seed script is the correct way to break it — not a hidden endpoint,
// not a special "first user becomes admin" rule that stays exploitable
// forever after.
//
// Run:  bun run seed
//
// Reads ADMIN_ORG_NUMBER, ADMIN_EMAIL and ADMIN_PASSWORD from the
// environment. The password is never hardcoded and never printed.
//
// Every user belongs to an organization, so the organization must exist
// first — create it with `bun run org:create`. The admin is attached to it by
// its organisationsnummer, which a human knows, rather than our internal id.

import 'dotenv/config'
import { prisma } from '../src/lib/prisma.ts'
import { hashPassword } from '../src/services/password.service.ts'
import { assertPasswordNotBreached } from '../src/services/password.service.ts'
import { newPasswordSchema, emailSchema } from '../src/validators/auth.validator.ts'
import { orgNumberSchema } from '../src/validators/organization.validator.ts'
import { findOrganizationByOrgNumber } from '../src/repositories/organization.repository.ts'
import { record, AuditAction, AuditResource } from '../src/services/audit.service.ts'

async function main() {
  const rawOrgNumber = process.env.ADMIN_ORG_NUMBER
  const rawEmail = process.env.ADMIN_EMAIL
  const rawPassword = process.env.ADMIN_PASSWORD

  if (!rawOrgNumber || !rawEmail || !rawPassword) {
    console.error(
      'Missing ADMIN_ORG_NUMBER, ADMIN_EMAIL or ADMIN_PASSWORD.\n\n' +
        'Run it like this (note the leading space, which keeps the password\n' +
        'out of your shell history in bash/zsh):\n\n' +
        '  ADMIN_ORG_NUMBER=559123-4561 ADMIN_EMAIL=admin@fakturly.se ADMIN_PASSWORD="a long passphrase" bun run seed\n\n' +
        'The organization must exist first: create it with bun run org:create\n' +
        '(usage at the top of prisma/create-organization.ts).\n'
    )
    process.exit(1)
  }

  // Normalised the same way org:create stored it, so "5591234561" finds
  // the organization saved as "559123-4561".
  const orgNumber = orgNumberSchema.parse(rawOrgNumber)
  const organization = await findOrganizationByOrgNumber(orgNumber)
  if (!organization) {
    // The number is not echoed — it can be a personnummer (ADR 56).
    console.error('No organization with that organisationsnummer. Run bun run org:create first.')
    process.exit(1)
  }

  // The seed goes through exactly the same validation as any other password.
  // A weak admin password is worse than a weak customer password, so this is
  // the last place to make an exception.
  const email = emailSchema.parse(rawEmail)
  const password = newPasswordSchema.parse(rawPassword)
  await assertPasswordNotBreached(password)

  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) {
    // Role FIRST. A customer login has no organization at all (ADR 56), so
    // comparing organizations first would report "another organization" for
    // what is really a customer — the wrong reason. And "nothing to do" would
    // leave the operator thinking an admin exists. The seed never PROMOTES
    // anyone: turning a customer's login into an admin is a privilege
    // escalation, and must never happen as a side effect of a setup script.
    if (existing.role !== 'ADMIN') {
      console.error(`${email} already exists as ${existing.role}, not ADMIN. Nothing was changed.`)
      process.exit(1)
    }
    // Re-running for the same org is harmless. For a DIFFERENT org it is not:
    // emails are unique across all organizations, so "nothing to do" would
    // leave the operator believing the new tenant has its admin when it
    // has none.
    if (existing.organizationId !== organization.id) {
      console.error(`${email} already belongs to another organization. Use a different email.`)
      process.exit(1)
    }
    console.log(`Admin ${email} already exists in ${organization.name}. Nothing to do.`)
    return
  }

  const admin = await prisma.user.create({
    data: {
      email,
      password: await hashPassword(password),
      // The ONLY place in the codebase where role is set to ADMIN. Nothing
      // reachable over HTTP can produce one.
      role: 'ADMIN',
      organizationId: organization.id,
      // The operator chose this password: the login is active from the start.
      passwordSetAt: new Date()
    },
    select: { id: true, email: true, role: true }
  })

  // Every ADMIN that exists was made here, so this row is the complete answer
  // to "where did this admin come from?". userId is null: no user of the
  // system did it, an operator with server access did. resourceId is the new
  // admin; the email is left out, since the id already identifies them.
  await record({
    action: AuditAction.ADMIN_CREATED,
    resource: AuditResource.USER,
    userId: null,
    organizationId: organization.id,
    resourceId: admin.id
  })

  console.log(`Created ${admin.role}: ${admin.email} (${admin.id})`)
  console.log(`  in ${organization.name} (${organization.id})`)
  console.log('The password was not stored anywhere in plain text.')
}

main()
  .catch((error) => {
    console.error('Seed failed:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
