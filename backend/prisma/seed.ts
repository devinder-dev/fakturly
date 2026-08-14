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
// Reads ADMIN_EMAIL and ADMIN_PASSWORD from the environment. The password is
// never hardcoded and never printed.

import 'dotenv/config'
import { prisma } from '../src/lib/prisma.ts'
import { hashPassword } from '../src/services/password.service.ts'
import { assertPasswordNotBreached } from '../src/services/password.service.ts'
import { newPasswordSchema, emailSchema } from '../src/validators/auth.validator.ts'

async function main() {
  const rawEmail = process.env.ADMIN_EMAIL
  const rawPassword = process.env.ADMIN_PASSWORD

  if (!rawEmail || !rawPassword) {
    console.error(
      'Missing ADMIN_EMAIL or ADMIN_PASSWORD.\n\n' +
        'Run it like this (note the leading space, which keeps the password\n' +
        'out of your shell history in bash/zsh):\n\n' +
        '  ADMIN_EMAIL=admin@fakturly.se ADMIN_PASSWORD="a long passphrase" bun run seed\n'
    )
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
    console.log(`Admin ${email} already exists (${existing.role}). Nothing to do.`)
    return
  }

  const admin = await prisma.user.create({
    data: {
      email,
      password: await hashPassword(password),
      // The ONLY place in the codebase where role is set to ADMIN. Nothing
      // reachable over HTTP can produce one.
      role: 'ADMIN'
    },
    select: { id: true, email: true, role: true }
  })

  console.log(`Created ${admin.role}: ${admin.email} (${admin.id})`)
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
