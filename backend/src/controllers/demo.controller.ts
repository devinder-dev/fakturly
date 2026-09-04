// demo.controller.ts — HTTP for the demo endpoint.

import type { FastifyReply, FastifyRequest } from 'fastify'
import { DEMO_ACCOUNTS } from '../demo/seed.ts'

/**
 * GET /demo
 *
 * Returns the two demo logins. The passwords are in the response body, which
 * is the single deliberate exception to the rule that a password never
 * leaves the server: these are published on the landing page anyway, and the
 * route only exists when DEMO_MODE is on.
 *
 * `Cache-Control: no-store` so no proxy between us and the browser keeps a
 * copy — a habit worth keeping even for public credentials.
 */
export async function getDemoAccounts(_request: FastifyRequest, reply: FastifyReply) {
  return reply
    .code(200)
    .header('cache-control', 'no-store')
    .send({
      accounts: [
        { role: 'ADMIN', ...DEMO_ACCOUNTS.admin },
        { role: 'CLIENT', ...DEMO_ACCOUNTS.client }
      ],
      resetsNightly: true
    })
}
