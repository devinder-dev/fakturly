// demo.routes.ts — the one endpoint that exists only in demo mode.

import type { FastifyInstance } from 'fastify'
import * as demoController from '../controllers/demo.controller.ts'
import { env } from '../lib/env.ts'

export default async function demoRoutes(app: FastifyInstance) {
  /**
   * GET /demo — the public demo accounts.
   *
   * Registered only when DEMO_MODE is on. Not "returns 404 when off" — the
   * route does not exist at all, so there is no code path in a real
   * deployment that could ever hand out credentials, however it is called.
   *
   * Public and unauthenticated on purpose: its whole job is to tell a
   * stranger how to log in.
   */
  if (!env.DEMO_MODE) return

  app.get('/demo', demoController.getDemoAccounts)
}
