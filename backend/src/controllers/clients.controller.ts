// clients.controller.ts — HTTP for client endpoints.

import type { FastifyReply, FastifyRequest } from 'fastify'
import { createClientSchema } from '../validators/auth.validator.ts'
import {
  idParamSchema,
  listQuerySchema,
  updateClientSchema
} from '../validators/client.validator.ts'
import * as clientService from '../services/client.service.ts'
import { UnauthenticatedError } from '../lib/errors.ts'
import type { ClientRecord } from '../repositories/client.repository.ts'
import type { AuthenticatedUser } from '../types/auth.ts'

/**
 * Shapes a client for the API.
 *
 * Explicit rather than returning the row directly, so a column added to the
 * model later — an internal note, a credit rating — is not exposed the moment
 * it exists. Adding a field to a response should be a decision, not a
 * side effect.
 */
function toPublicClient(client: ClientRecord) {
  return {
    id: client.id,
    name: client.name,
    email: client.email,
    phone: client.phone,
    address: client.address,
    createdAt: client.createdAt
  }
}

function requireCaller(request: FastifyRequest): AuthenticatedUser {
  const caller = request.authUser
  if (!caller) throw new UnauthenticatedError()
  return caller
}

function requestContext(request: FastifyRequest) {
  return {
    ip: request.ip,
    userAgent: request.headers['user-agent']?.slice(0, 500)
  }
}

// ─────────────────────────────────────────────────────────────

export async function createClient(request: FastifyRequest, reply: FastifyReply) {
  // The schema has no `role` field at all, so an attacker adding
  // "role": "ADMIN" to the body gets it silently stripped — Zod drops unknown
  // keys. Privilege escalation is not blocked by a check here; it is
  // structurally impossible.
  const input = createClientSchema.parse(request.body)
  const admin = requireCaller(request)

  const created = await clientService.createClient(
    input,
    admin.id,
    requestContext(request)
  )

  // 201 Created, and deliberately no temporary password in the response.
  return reply.code(201).send({
    client: {
      id: created.clientId,
      userId: created.userId,
      email: created.email,
      name: created.name
    }
  })
}

export async function listClients(request: FastifyRequest, reply: FastifyReply) {
  const { limit, offset } = listQuerySchema.parse(request.query)

  const { clients, total } = await clientService.listClients(limit, offset)

  return reply.code(200).send({
    clients: clients.map(toPublicClient),
    pagination: { total, limit, offset }
  })
}

/**
 * GET /clients/:id
 *
 * Reachable by both roles. The service decides whether this caller may see
 * this particular row, and answers 404 rather than 403 when they may not —
 * see getClientForCaller for why.
 */
export async function getClient(request: FastifyRequest, reply: FastifyReply) {
  const { id } = idParamSchema.parse(request.params)
  const caller = requireCaller(request)

  const client = await clientService.getClientForCaller(id, caller)

  return reply.code(200).send({ client: toPublicClient(client) })
}

/**
 * GET /clients/me
 *
 * Takes no id at all, which is the point: an endpoint with no id cannot have
 * an IDOR bug. The client portal should use this rather than looking up its
 * own id and passing it back.
 */
export async function getOwnClient(request: FastifyRequest, reply: FastifyReply) {
  const caller = requireCaller(request)
  const client = await clientService.getOwnClient(caller)

  return reply.code(200).send({ client: toPublicClient(client) })
}

export async function updateClient(request: FastifyRequest, reply: FastifyReply) {
  const { id } = idParamSchema.parse(request.params)
  const fields = updateClientSchema.parse(request.body)
  const admin = requireCaller(request)

  const updated = await clientService.updateClient(
    id,
    fields,
    admin.id,
    requestContext(request)
  )

  return reply.code(200).send({ client: toPublicClient(updated) })
}
