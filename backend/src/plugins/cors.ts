// plugins/cors.ts — which origins the browser may call this API from.
//
// CORS is enforced by the BROWSER, not by us. It does not stop curl, a
// script, or an attacker's server — those never ask permission. What it stops
// is a malicious *website* making requests from a victim's browser using that
// victim's cookies.
//
// So this is not "the API's access control". Authentication and authorisation
// are still what protect the data. CORS narrows one specific attack surface.

import fp from 'fastify-plugin'
import cors from '@fastify/cors'
import type { FastifyInstance } from 'fastify'
import { env, isProduction } from '../lib/env.ts'

async function corsPlugin(app: FastifyInstance) {
  /**
   * An explicit allowlist. Never `origin: true`.
   *
   * `origin: true` reflects whatever Origin the request carried, which with
   * `credentials: true` means ANY website can call this API using a logged-in
   * visitor's cookies. That combination is the single most common serious
   * CORS mistake, and browsers reject `origin: '*'` with credentials for
   * exactly that reason — but they happily accept a reflected origin, because
   * they cannot tell it was reflected rather than chosen.
   */
  const allowedOrigins = new Set<string>([env.FRONTEND_URL])

  // Vite serves on 5173 but will pick another port if it is taken, and 127.0.0.1
  // and localhost are different origins to a browser. Development only — in
  // production the allowlist is exactly FRONTEND_URL.
  if (!isProduction) {
    allowedOrigins.add('http://localhost:5173')
    allowedOrigins.add('http://127.0.0.1:5173')
  }

  await app.register(cors, {
    /**
     * A function rather than an array, so a request with NO Origin header is
     * allowed through. Same-origin requests, curl and server-to-server calls
     * send no Origin — rejecting them would break the health checks and every
     * test that uses app.inject().
     */
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true)
        return
      }

      // Refuse rather than throw: a rejected origin should get a clean CORS
      // failure in the browser, not a 500 in our logs for every scan.
      callback(null, false)
    },

    /**
     * Required for the refresh cookie to be sent at all.
     *
     * Without this the browser silently omits cookies on cross-origin
     * requests, and /auth/refresh would always 401 — with no error anywhere
     * to explain why. The frontend must also set `credentials: 'include'`;
     * both sides have to agree or the cookie is dropped.
     */
    credentials: true,

    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization'],

    /**
     * How long a browser may cache the preflight OPTIONS response.
     *
     * Every non-simple request (anything with an Authorization header, which
     * is all of ours) triggers a preflight first. Without this, that is two
     * round trips for every single API call.
     */
    maxAge: 86_400
  })
}

export default fp(corsPlugin, { name: 'cors' })
