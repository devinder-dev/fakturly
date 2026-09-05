// seed-demo.ts — rebuilds the showcase dataset from the command line.
//
// Run:  bun run seed:demo
//
// Everything about WHAT is created lives in src/demo/seed.ts, so the nightly
// reset job and this command produce byte-for-byte the same dataset. This
// file only adds a terminal-friendly summary and a clean exit.
//
// It WIPES the database first. That is the point in the demo and on a
// developer's machine, and exactly why src/demo/seed.ts refuses to run in
// production without DEMO_MODE.

import 'dotenv/config'
import { prisma } from '../src/lib/prisma.ts'
import { redis } from '../src/lib/redis.ts'
import { resetDemoData, DEMO_ACCOUNTS } from '../src/demo/seed.ts'

async function main() {
  const summary = await resetDemoData()

  console.log('Demo dataset ready.\n')
  console.log(`  users     ${summary.users}`)
  console.log(`  clients   ${summary.clients}`)
  console.log(`  documents ${summary.invoices}  (${summary.paid} paid, ${summary.overdue} overdue, ${summary.reminded} reminded, ${summary.credited} credited, ${summary.drafts} draft)`)
  console.log('\nLog in as:')
  console.log(`  ${DEMO_ACCOUNTS.admin.label.padEnd(14)} ${DEMO_ACCOUNTS.admin.email}  /  ${DEMO_ACCOUNTS.admin.password}`)
  console.log(`  ${'Kund'.padEnd(14)} ${DEMO_ACCOUNTS.client.email}  /  ${DEMO_ACCOUNTS.client.password}`)
}

main()
  .catch((error) => {
    console.error('Demo seed failed:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
    await redis.quit()
  })
