// setup.ts — global test setup, preloaded via bunfig.toml.
//
// WHY THIS EXISTS:
//
// Prisma and Redis are module-level singletons — one connection pool for the
// whole process, which is correct for a server. Bun runs every test file in
// ONE process, so all files share those singletons.
//
// That means a test file must never call app.close(). Doing so runs the
// plugins' onClose hooks, which call prisma.$disconnect() and redis.quit() —
// tearing down the shared connections for every file that has not run yet.
// The symptom is a confusing "Connection is closed" in a file that passes
// perfectly well on its own.
//
// So: individual tests leave the app open, and this file closes the
// connections exactly once, after everything has finished.

import { afterAll } from 'bun:test'
import { prisma } from '../src/lib/prisma.ts'
import { redis } from '../src/lib/redis.ts'

afterAll(async () => {
  await prisma.$disconnect()
  // quit() waits for in-flight commands; disconnect() would drop them.
  await redis.quit()
})
