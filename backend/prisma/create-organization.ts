// create-organization.ts — creates a tenant (an organization) from the command line.
//
// Run:
//   bun run org:create --name "Bergström Konsult AB" --org-number 556677-8899 \
//     --address "Storgatan 1, 111 22 Stockholm" --email faktura@bergstrom.se \
//     [--vat-number SE556677889901] [--bankgiro 5050-1055] \
//     [--payment-terms-days 30] [--no-f-skatt]
//
// Then give it its first admin:
//   ADMIN_ORG_NUMBER=556677-8899 ADMIN_EMAIL=... ADMIN_PASSWORD="..." bun run seed
//
// Why a CLI and not an endpoint: creating a tenant is an operator decision.
// An HTTP route for it would need a role ABOVE admin to guard it, and every
// such role is one more thing an attacker can aim for. A command on the
// server is guarded by having access to the server.
//
// The input goes through the same Zod schema and the same service as any
// other write, so the CLI cannot create an organization the app would reject.

import 'dotenv/config'
import { parseArgs } from 'node:util'
import { ZodError } from 'zod'
import { prisma } from '../src/lib/prisma.ts'
import { createOrganizationSchema } from '../src/validators/organization.validator.ts'
import { createOrganization } from '../src/services/organization.service.ts'
import { AppError } from '../src/lib/errors.ts'

async function main() {
  const { values } = parseArgs({
    options: {
      name: { type: 'string' },
      'org-number': { type: 'string' },
      'vat-number': { type: 'string' },
      address: { type: 'string' },
      email: { type: 'string' },
      bankgiro: { type: 'string' },
      'payment-terms-days': { type: 'string' },
      'no-f-skatt': { type: 'boolean', default: false }
    },
    // Unknown flags are an error, not ignored: a typo like --vat-nummer
    // would otherwise create a company without the VAT number you meant.
    strict: true
  })

  const termsDays = values['payment-terms-days']

  const input = createOrganizationSchema.parse({
    name: values.name,
    orgNumber: values['org-number'],
    vatNumber: values['vat-number'],
    address: values.address,
    email: values.email,
    bankgiro: values.bankgiro,
    fSkatt: !values['no-f-skatt'],
    // Digits only before converting: Number('') is 0, so an empty value
    // would otherwise slip through as "due on receipt". NaN fails the schema.
    ...(termsDays !== undefined
      ? { paymentTermsDays: /^\d+$/.test(termsDays) ? Number(termsDays) : Number.NaN }
      : {})
  })

  const organization = await createOrganization(input)

  console.log(`Created organization ${organization.name} (${organization.orgNumber})`)
  console.log(`  id  ${organization.id}`)
  console.log('\nNext, its first admin:')
  console.log(
    `  ADMIN_ORG_NUMBER=${organization.orgNumber} ADMIN_EMAIL=... ADMIN_PASSWORD="..." bun run seed`
  )
}

main()
  .catch((error) => {
    if (error instanceof ZodError) {
      console.error('Invalid input:')
      for (const issue of error.issues) {
        console.error(`  ${issue.path.join('.') || '(input)'}: ${issue.message}`)
      }
    } else if (error instanceof AppError) {
      console.error(error.message)
    } else {
      console.error('Failed:', error instanceof Error ? error.message : error)
    }
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
