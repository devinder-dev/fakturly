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
// through it. ADR 50 records how this was measured from the outside.
//
// So the address used for rate-limit buckets and audit rows comes from a
// header NAMED IN CONFIGURATION, when the deployment says which one to
// trust, and from request.ip otherwise (local development, tests, a plain
// nginx). Getting this wrong in the permissive direction is how a client
// picks its own rate-limit bucket; ADR 50 records that we did, once.

import { isIP } from 'node:net'
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

    // The deployment says which header to trust, and it is missing: the
    // request did not come through the edge that sets it. Do NOT fall back
    // to request.ip — with trustProxy on, that is read from X-Forwarded-For,
    // which the client writes. The TCP peer cannot be forged; at worst every
    // such request shares the proxy's bucket, which fails safe.
    return request.socket?.remoteAddress ?? request.ip
  }
  return request.ip
}

/**
 * The rate-limit bucket for an address.
 *
 * IPv4: the address itself. IPv6: its /64 network. An ordinary IPv6
 * subscriber is handed a whole /64 — 2^64 addresses — so keying on the full
 * address gives an attacker a fresh bucket for every request. The /64 is the
 * smallest block one customer controls, which makes it the unit to count.
 *
 * Only for rate-limit keys. Audit rows keep the full address, because an
 * investigator wants exactly what was seen.
 */
export function rateLimitKey(ip: string): string {
  // ::ffff:198.51.100.7 is an IPv4 client seen through an IPv6 socket. It
  // must land in the same bucket as 198.51.100.7, not in a /64 shared with
  // every other IPv4 client.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)
  if (mapped) return mapped[1]!

  if (isIP(ip) !== 6) return ip
  return `${ipv6Groups(ip).slice(0, 4).join(':')}::/64`
}

/** The eight 16-bit groups of an IPv6 address, expanded and lower-case. */
function ipv6Groups(ip: string): string[] {
  // Drop a zone id (fe80::1%eth0) — it names a local interface, not a host.
  const address = ip.split('%')[0]!.toLowerCase()

  const [head = '', tail] = address.split('::')
  const headParts = head ? head.split(':') : []
  const tailParts = tail ? tail.split(':') : []

  // An embedded IPv4 in the last position (64:ff9b::198.51.100.7) fills
  // two groups. It can only sit at the end, so the /64 prefix is unaffected.
  const width = (parts: string[]) => parts.reduce((n, p) => n + (p.includes('.') ? 2 : 1), 0)
  const zeros = tail === undefined ? [] : Array(8 - width(headParts) - width(tailParts)).fill('0')

  // parseInt then toString: '0db8' and 'db8' are the same group and must
  // produce the same key.
  return [...headParts, ...zeros, ...tailParts].map((group) =>
    group.includes('.') ? group : parseInt(group, 16).toString(16)
  )
}
