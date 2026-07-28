// server.ts — startpunkt. Bygger appen och startar den (lyssnar på en port).
// All app-konfiguration bor i app.ts; här sköter vi bara uppstarten.

import { buildApp } from './app.ts'

const app = buildApp()

// Läs port från miljövariabler, med säkert standardvärde.
const port = Number(process.env.PORT) || 3000
const host = '0.0.0.0'

// try/catch så att vi loggar tydligt om uppstarten misslyckas.
try {
  await app.listen({ port, host })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
