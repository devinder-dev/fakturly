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
import { sendInviteEmail, sendCustomerAddedEmail } from './email.service.ts'
import { record, AuditAction, AuditResource } from './audit.service.ts'
import * as clientRepository from '../repositories/client.repository.ts'
import type { ClientRecord, ListClientsResult } from '../repositories/client.repository.ts'
import type { RequestContext } from './auth.service.ts'
import { env } from '../lib/env.ts'
import { NotFoundError, ForbiddenError } from '../lib/errors.ts'
import type { Actor, AuthenticatedUser } from '../types/auth.ts'

export type CreateClientInput = {
  email: string
  name: string
  phone?: string | undefined
  address?: string | undefined
}

/** What the admin is told. Deliberately the same whatever happened to the
 *  login — see createClient. */
export type CreatedClient = {
  clientId: string
  email: string
  name: string
}

/**
 * Adds a customer to the admin's organization.
 *
 * ONE LOGIN, ONE RECORD PER SELLER (ADR 56). If the email has no login yet, one
 * is created and the person gets an invite to set a password. If it already
 * has one — they buy from another seller too — that login gets a customer
 * record here as well, and an email saying so; or, if its owner never set a
 * password, a fresh invite. Either way the admin sees the SAME 201 with the
 * same fields.
 *
 * That sameness is the security property. A response that differed — a 409
 * "email taken", or even the login's id, whose cuid starts with a timestamp
 * that would read as "older than now" — would tell this organization's admin
 * that the address is someone else's customer. Across tenants, that is a
 * leak; and with a 409, one seller could block another from adding the same
 * customer by getting there first.
 *
 * The new login's password is random and nobody — not even the admin who ran
 * this — ever sees it. It exists only because the column is required.
 * Sending it back in the response was rejected: it would put a working
 * credential in an admin's browser history and a proxy log. It is hashed even
 * when an existing login makes it unused, so both paths cost the same.
 */
export async function createClient(
  input: CreateClientInput,
  actor: Actor,
  context: RequestContext = {}
): Promise<CreatedClient> {
  // 256 bits from a CSPRNG, hashed with the same Argon2id parameters as any
  // real password — so every row in the table is uniform, with no "is this a
  // placeholder?" branch anywhere else in the system.
  const passwordHash = await hashPassword(generateTemporaryPassword())

  // The customer joins the ADMIN's organization, which comes from the
  // admin's verified token. The request body has no field that could pick a
  // different one.
  const created = await clientRepository.provisionClient(actor.organizationId, {
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
    userId: actor.userId,
    organizationId: actor.organizationId,
    resourceId: created.clientId,
    email: input.email,
    ipAddress: context.ip,
    userAgent: context.userAgent
  })

  // ── Telling the person ───────────────────────────────────────
  //
  // Deliberately AFTER the client exists and outside its transaction. If
  // sending fails, the client is still created and the email can be resent;
  // rolling back a customer because a mail server was briefly down would be
  // absurd. The email functions never throw, and log the attempt either way.
  if (created.login === 'created' || created.login === 'existing-pending') {
    // A pending login gets an invite exactly like a new one. Its earlier
    // invite may have expired, and "log in as usual" would strand someone
    // who never chose a password. issuePasswordToken invalidates any
    // earlier link first, so only the newest one works.
    const invite = await issuePasswordToken(created.userId, 'INVITE')

    await sendInviteEmail({
      to: created.email,
      clientName: created.name,
      setPasswordUrl: buildSetPasswordUrl(invite.token),
      expiresAt: invite.expiresAt,
      userId: created.userId
    })

    // Filed under NO organization, on purpose. The invite concerns the
    // LOGIN, which belongs to none (ADR 56) — and filed under this
    // organization, it would be the one row in this admin's audit trail that
    // appears only when the address was brand new: the same "did they
    // already exist?" leak the identical 201 exists to prevent.
    await record({
      action: AuditAction.INVITE_SENT,
      resource: AuditResource.USER,
      userId: actor.userId,
      organizationId: null,
      resourceId: created.userId,
      email: created.email,
      ipAddress: context.ip
    })
  } else {
    // Exactly ONE email in every branch, so the request does the same work
    // whatever the address already was: response time cannot tell them
    // apart either. (What remains — the invite's token write — is a few
    // milliseconds against an email send's hundreds; ADR 56.)
    //
    // A staff login elsewhere gets the same news without the portal link:
    // one login has one role, so it cannot open the customer portal, and
    // pointing it there would only mislead. Its invoices arrive by email,
    // as anyone's do.
    await sendCustomerAddedEmail({
      to: created.email,
      clientName: created.name,
      organizationName: created.organizationName,
      loginUrl: created.login === 'existing-client' ? `${env.FRONTEND_URL}/login` : null,
      userId: created.userId
    })
  }

  return { clientId: created.clientId, email: created.email, name: created.name }
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
  // The ownership rule lives IN THE QUERY, for both roles: an admin's query
  // is limited to their organization, a customer's to their own login. A
  // row that is someone else's is simply not found — never loaded, then
  // filtered. Note neither scope comes from the request: both come from the
  // verified token, and nothing a caller sends can influence them.
  const client =
    caller.role === 'ADMIN'
      ? await clientRepository.findClientById(caller.organizationId, clientId)
      : await clientRepository.findClientOfUser(caller.id, clientId)

  // Missing, another organization's, another customer's: one answer.
  if (!client) {
    throw new NotFoundError('Kunden')
  }

  return client
}

/**
 * The caller's own customer records — one per seller they buy from.
 *
 * Convenience for the client portal, which should never need to know its own
 * client ids — it just asks for "mine". An endpoint that takes no id cannot
 * have an IDOR bug at all.
 */
export async function getOwnClients(caller: AuthenticatedUser): Promise<ClientRecord[]> {
  if (caller.role === 'ADMIN') {
    // Staff, not a customer. 403 rather than 404 here is correct: this is a
    // role problem, not a missing row, and it leaks nothing an admin does
    // not already know.
    throw new ForbiddenError('Detta konto har ingen kundprofil')
  }

  return clientRepository.findClientsOfUser(caller.id)
}

/** The admin's own organization's customers. The route enforces the role. */
export async function listClients(
  actor: Actor,
  limit: number,
  offset: number
): Promise<ListClientsResult> {
  return clientRepository.listClients(actor.organizationId, limit, offset)
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
 * Admin-only, enforced on the route, and limited to the admin's own
 * organization by the query itself.
 *
 * The audit row records WHICH fields changed, not their values. Names and
 * addresses are personal data, and an audit log is retained for years —
 * copying PII into it multiplies the places a leak could expose it, and works
 * against a GDPR erasure request.
 */
export async function updateClient(
  clientId: string,
  fields: UpdateClientFields,
  actor: Actor,
  context: RequestContext = {}
): Promise<ClientRecord> {
  // One scoped statement: no row here — missing or another organization's —
  // updates nothing and answers 404.
  const updated = await clientRepository.updateClient(actor.organizationId, clientId, fields)
  if (!updated) {
    throw new NotFoundError('Kunden')
  }

  await record({
    action: AuditAction.CLIENT_UPDATED,
    resource: AuditResource.CLIENT,
    userId: actor.userId,
    organizationId: actor.organizationId,
    resourceId: clientId,
    // Field names only — never the old or new values.
    email: null,
    ipAddress: context.ip,
    userAgent: context.userAgent
  })

  return updated
}
