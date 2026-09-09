// clientIp.ts — the caller's address, from the header the proxy controls.
//
// `request.ip` is Fastify's reading of X-Forwarded-For, and which entry of
// that header can be trusted depends on the proxy in front of the API. On
// Render the chain arrives as
//
//   <whatever the client sent>, <real client>, <hop>, <hop>
//
// so the FIRST entry is forgeable and the number of trailing hops varies —
// no `trustProxy` setting reads it safely. What the edge does control is
// its own header: Cloudflare (which fronts Render) overwrites
// cf-connecting-ip on every request, and the origin is not reachable except
// through it. /health/whoami shows all of this from the outside.
//
// So the address used for rate-limit buckets and audit rows comes from a
// header NAMED IN CONFIGURATION, when the deployment says which one to
// trust, and from request.ip otherwise (local development, tests, a plain
// nginx). Getting this wrong in the permissive direction is how a client
// picks its own rate-limit bucket; ADR 50 records that we did, once.

import type { FastifyRequest } from 'fastify'
import { env } from './env.ts'

export function clientIp(
  request: FastifyRequest,
  trustedHeader: string | undefined = env.CLIENT_IP_HEADER
): string {
  if (trustedHeader) {
    const value = request.headers[trustedHeader.toLowerCase()]
    const first = Array.isArray(value) ? value[0] : value
    if (first) return first.split(',')[0]!.trim()
  }
  return request.ip
}
