// server.ts — entry point. Builds the app and starts it (listens on a port).
// All app configuration lives in app.ts; this file only handles startup and
// controlled shutdown.

import { buildApp } from './app.ts'
import { env } from './lib/env.ts'

// await: buildApp finishes loading plugins before declaring routes,
// otherwise routes get registered before the plugins' hooks exist.
const app = await buildApp()

// try/catch so we log clearly if startup fails.
try {
  // 0.0.0.0 = listen on all network interfaces. Required in Docker —
  // with 'localhost' the server would only be reachable inside the container.
  await app.listen({ port: env.PORT, host: '0.0.0.0' })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}

// ── Graceful shutdown ────────────────────────────────────────────
// Without this the process is killed instantly on Ctrl+C or `docker stop`:
// in-flight requests are cut off mid-way and database connections are left
// hanging. In a payment system we must NEVER abort a transaction halfway.
//
// SIGINT  = Ctrl+C in the terminal
// SIGTERM = docker stop / Railway / Render asking the process to exit
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    app.log.info(`${signal} received — shutting down...`)
    // app.close() waits for in-flight requests, then runs every onClose
    // hook (prisma.$disconnect, redis.quit).
    await app.close()
    process.exit(0)
  })
}
