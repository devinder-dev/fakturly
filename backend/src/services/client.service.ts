// client.service.ts — provisioning customers.
//
// There is no public registration in Fakturly. An admin creates the client,
// exactly like every real invoicing and banking system: you do not sign
// yourself up as a customer of somebody's accounts-receivable ledger.
//
// This also removes a whole class of abuse — fake signups, and enumeration
// through a registration endpoint that answers differently for taken emails.

import { generateTemporaryPassword, hashPassword } from './password.service.ts'
import { record, AuditAction, AuditResource } from './audit.service.ts'
import * as clientRepository from '../repositories/client.repository.ts'
import type { CreatedClient } from '../repositories/client.repository.ts'
import type { RequestContext } from './auth.service.ts'

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

  return created
}
