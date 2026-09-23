// databaseTls.ts — verified TLS to a database signed by a private CA.
//
// Supabase signs its Postgres certificates with its own root ("Supabase Root
// 2021 CA"), which is not in any system trust store. Encryption alone is not
// enough: without checking the certificate, anyone on the path can pose as
// the database and read every query, password hash and invoice. So we ship
// Supabase's CA (certs/, fingerprint in ADR 53) and verify against it.
//
// The catch: the two things that connect read the URL differently.
//
//   runtime (pg)          `ssl: { ca }` on the pool. An `sslmode` in the URL
//                         REPLACES that object — verified 2026-09-23: CA
//                         passed + `sslmode=require` in the URL = rejected.
//   migrations (Prisma    Ignores the pool; reads TLS from URL parameters.
//   CLI, schema engine)   Verified in the production image against Supabase:
//                           sslmode=require                   no cert check
//                           sslmode=verify-full&sslrootcert=  accepts a WRONG CA
//                           sslaccept=strict&sslcert=<CA>     right CA passes,
//                                                             wrong CA and wrong
//                                                             host are rejected
//                         Only the last one verifies. (On macOS the schema
//                         engine rejects even the right CA; production is Linux.)
//
// So DATABASE_URL stays plain, DATABASE_CA_CERT names the CA file, and this
// module derives the right form for each consumer.
//
// Deliberately does NOT import env.ts: prisma.config.ts uses it too, and
// env.ts demands production secrets the Docker build stage does not have.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** URL parameters that configure TLS, for either consumer. */
const TLS_PARAMS = ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslaccept', 'uselibpqcompat']

/** True if the URL configures TLS itself. */
export function urlHasTlsParams(url: string): boolean {
  const params = new URL(url).searchParams
  return TLS_PARAMS.some((name) => params.has(name))
}

/**
 * Refuse the combination that silently disables verification.
 *
 * A CA file plus TLS parameters in the URL looks belt-and-braces and is the
 * opposite: pg lets the URL win, so the CA is ignored.
 */
export function assertNoTlsConflict(url: string, caPath: string | undefined): void {
  if (caPath && urlHasTlsParams(url)) {
    throw new Error(
      'DATABASE_URL must not contain ssl* parameters when DATABASE_CA_CERT is set — ' +
        'the URL would override the CA and verification would be lost. ' +
        'Remove them; DATABASE_CA_CERT configures TLS.'
    )
  }
}

/** pg pool `ssl` option: verify against our CA, or undefined to let the URL decide. */
export function pgSslOptions(
  url: string,
  caPath: string | undefined
): { ca: string; rejectUnauthorized: true } | undefined {
  assertNoTlsConflict(url, caPath)
  if (!caPath) return undefined
  // rejectUnauthorized is Node's default already; spelled out because this
  // one flag is the whole point of the file. Hostname checking comes with
  // it: pg passes the host as the TLS servername.
  return { ca: readFileSync(resolve(caPath), 'utf8'), rejectUnauthorized: true }
}

/** URL for the Prisma CLI (migrate deploy): TLS verified through URL parameters. */
export function migrationUrl(url: string, caPath: string | undefined): string {
  assertNoTlsConflict(url, caPath)
  if (!caPath) return url

  const withTls = new URL(url)
  withTls.searchParams.set('sslmode', 'require')
  withTls.searchParams.set('sslaccept', 'strict')
  // Absolute: the schema engine resolves relative paths from its own idea
  // of the base directory, not ours.
  withTls.searchParams.set('sslcert', resolve(caPath))
  return withTls.toString()
}
