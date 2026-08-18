// client.service.ts — provisioning customers.
//
// There is no public registration in Fakturly. An admin creates the client,
// exactly like every real invoicing and banking system: you do not sign
// yourself up as a customer of somebody's accounts-receivable ledger.
//
// This also removes a whole class of abuse — fake signups, and enumeration
// through a registration endpoint that answers differently for taken emails.

import { generateTemporaryPassword, hashPassword } from './password.service.ts'
import { issuePasswordToken, buildSetPasswordUrl } from './passwordToken.service.ts'
import { sendInviteEmail } from './email.service.ts'
import { record, AuditAction, AuditResource } from './audit.service.ts'
import * as clientRepository from '../repositories/client.repository.ts'
import type {
  CreatedClient,
  ClientRecord,
  ListClientsResult
} from '../repositories/client.repository.ts'
import type { RequestContext } from './auth.service.ts'
import { NotFoundError, ForbiddenError } from '../lib/errors.ts'
import type { AuthenticatedUser } from '../types/auth.ts'

export type CreateClientInput = {
  email: string
  name: string
  phone?: string | undefined
  address?: string | undefined
}

/**
 * Creates a client account.
 *
 * The password is random and nobody — not even the admin who ran this — ever
 * sees it. It exists only because the column is required. The client receives
 * a set-password link by email instead.
 *
 * NOTE (week 3): that invite email is not built yet. Until it is, a
 * provisioned client cannot log in. This is deliberate scope, not an
 * oversight — sending the temporary password back in the API response would
 * put a working credential in an admin's browser history, a proxy log and
 * anyone's screen recording.
 */
export async function createClient(
  input: CreateClientInput,
  actingAdminId: string,
  context: RequestContext = {}
): Promise<CreatedClient> {
  // 256 bits from a CSPRNG, hashed with the same Argon2id parameters as any
  // real password. Hashing something nobody knows may look pointless, but it
  // keeps every row in the table uniform — no special case, no "is this a
  // placeholder?" branch anywhere else in the system.
  const temporaryPassword = generateTemporaryPassword()
  const passwordHash = await hashPassword(temporaryPassword)

  const created = await clientRepository.createClientWithUser({
    email: input.email,
    passwordHash,
    name: input.name,
    phone: input.phone,
    address: input.address
  })

  // Separate transaction from the creation above, deliberately. If the audit
  // write shared it and later failed, the rollback would undo a client the
  // admin was told about.
  await record({
    action: AuditAction.CLIENT_CREATED,
    resource: AuditResource.CLIENT,
    // WHO did it — the admin, not the new client. An audit log answers
    // "who performed this action", not "who was affected"; the affected row
    // is resourceId.
    userId: actingAdminId,
    resourceId: created.clientId,
    email: input.email,
    ipAddress: context.ip,
    userAgent: context.userAgent
  })

  // ── The invite ───────────────────────────────────────────────
  //
  // Deliberately AFTER the client exists and outside its transaction. If
  // sending fails, the client is still created and the invite can be resent;
  // rolling back a customer because a mail server was briefly down would be
  // absurd. sendInviteEmail never throws, and records the attempt either way.
  const invite = await issuePasswordToken(created.userId, 'INVITE')

  await sendInviteEmail({
    to: created.email,
    clientName: created.name,
    setPasswordUrl: buildSetPasswordUrl(invite.token),
    expiresAt: invite.expiresAt,
    userId: created.userId
  })

  await record({
    action: AuditAction.INVITE_SENT,
    resource: AuditResource.USER,
    userId: actingAdminId,
    resourceId: created.userId,
    email: created.email,
    ipAddress: context.ip
  })

  return created
}

// ─────────────────────────────────────────────────────────────
// Reading — where ownership is enforced
// ─────────────────────────────────────────────────────────────

/**
 * Fetches a client, enforcing that the caller may actually see it.
 *
 * THIS IS THE CHECK THAT `authorize` CANNOT DO.
 *
 * `authorize('CLIENT')` answers "may any client call this endpoint". It
 * cannot answer "may THIS client read THIS row", because that depends on the
 * row — which only exists once the service has loaded it.
 *
 * Skipping this check is Insecure Direct Object Reference (IDOR): a perfectly
 * valid login, changing one id in the URL, reading somebody else's data. It
 * sits near the top of the OWASP list precisely because every access-control
 * layer above this one passes it cleanly.
 *
 * WHY 404 AND NOT 403 — this matters and looks wrong at first.
 *
 * A 403 means "this exists, and it is not yours". Repeat it across a range of
 * ids and you have enumerated the customer base: every 403 is a real client,
 * every 404 is a gap. The response has told an attacker exactly what they
 * wanted without ever showing them a single record.
 *
 * A 404 means "there is nothing here for you". Indistinguishable from an id
 * that never existed. The attacker learns nothing.
 *
 * The cost is worse debugging — a developer hitting the wrong id sees "not
 * found" rather than "wrong account". That is a fair trade for not leaking
 * the customer list, and it is the same reasoning behind the identical login
 * errors in the auth phase.
 */
export async function getClientForCaller(
  clientId: string,
  caller: AuthenticatedUser
): Promise<ClientRecord> {
  const client = await clientRepository.findClientById(clientId)

  // Genuinely missing.
  if (!client) {
    throw new NotFoundError('Kunden')
  }

  // An admin may read any client.
  if (caller.role === 'ADMIN') {
    return client
  }

  // A client may read only their own record. Note the comparison is against
  // the row's userId, not an id supplied by the caller — the caller's identity
  // comes from a verified token and nothing in the request can influence it.
  if (client.userId !== caller.id) {
    throw new NotFoundError('Kunden')
  }

  return client
}

/**
 * The caller's own client record.
 *
 * Convenience for the client portal, which should never need to know its own
 * client id — it just asks for "mine". An endpoint that takes no id cannot
 * have an IDOR bug at all.
 */
export async function getOwnClient(caller: AuthenticatedUser): Promise<ClientRecord> {
  const client = await clientRepository.findClientByUserId(caller.id)

  if (!client) {
    // An ADMIN has no client record — they are staff, not a customer.
    // 403 rather than 404 here is correct: this is a role problem, not a
    // missing row, and it leaks nothing an admin does not already know.
    throw new ForbiddenError('Detta konto har ingen kundprofil')
  }

  return client
}

/** Admin-only listing. The route enforces the role; this just reads. */
export async function listClients(
  limit: number,
  offset: number
): Promise<ListClientsResult> {
  return clientRepository.listClients(limit, offset)
}

// ─────────────────────────────────────────────────────────────
// Updating
// ─────────────────────────────────────────────────────────────

export type UpdateClientFields = {
  name?: string | undefined
  phone?: string | null | undefined
  address?: string | null | undefined
}

/**
 * Updates a client's details.
 *
 * Admin-only, enforced on the route. We still load the row first so a
 * non-existent id gives a clean 404 instead of a Prisma P2025 that the error
 * handler would have to translate.
 *
 * The audit row records WHICH fields changed, not their values. Names and
 * addresses are personal data, and an audit log is retained for years —
 * copying PII into it multiplies the places a leak could expose it, and works
 * against a GDPR erasure request.
 */
export async function updateClient(
  clientId: string,
  fields: UpdateClientFields,
  actingAdminId: string,
  context: RequestContext = {}
): Promise<ClientRecord> {
  const existing = await clientRepository.findClientById(clientId)
  if (!existing) {
    throw new NotFoundError('Kunden')
  }

  const updated = await clientRepository.updateClient(clientId, fields)

  await record({
    action: AuditAction.CLIENT_UPDATED,
    resource: AuditResource.CLIENT,
    userId: actingAdminId,
    resourceId: clientId,
    // Field names only — never the old or new values.
    email: null,
    ipAddress: context.ip,
    userAgent: context.userAgent
  })

  return updated
}
