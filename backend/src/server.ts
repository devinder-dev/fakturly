// server.ts — startpunkt. Bygger appen och startar den (lyssnar på en port).
// All app-konfiguration bor i app.ts; här sköter vi bara uppstarten
// och den kontrollerade nedstängningen.

import { buildApp } from './app.ts'
import { env } from './lib/env.ts'

const app = buildApp()

// try/catch så att vi loggar tydligt om uppstarten misslyckas.
try {
  // 0.0.0.0 = lyssna på alla nätverksinterface. Krävs i Docker —
  // med 'localhost' skulle servern bara nås inifrån containern.
  await app.listen({ port: env.PORT, host: '0.0.0.0' })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}

// ── Graceful shutdown ────────────────────────────────────────────
// Utan detta dödas processen direkt vid Ctrl+C eller `docker stop`:
// pågående requests avbryts mitt i, och databasanslutningar lämnas
// hängande. I ett betalsystem vill vi ALDRIG avbryta en transaktion.
//
// SIGINT  = Ctrl+C i terminalen
// SIGTERM = docker stop / Railway / Render ber processen avsluta
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    app.log.info(`${signal} mottagen — stänger ner...`)
    // app.close() väntar in pågående requests och kör sedan alla
    // onClose-hooks (prisma.$disconnect, redis.quit).
    await app.close()
    process.exit(0)
  })
}
