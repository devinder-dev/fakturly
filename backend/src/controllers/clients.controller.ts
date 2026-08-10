// clients.controller.ts — HTTP for client provisioning.

import type { FastifyReply, FastifyRequest } from 'fastify'
import { createClientSchema } from '../validators/auth.validator.ts'
import * as clientService from '../services/client.service.ts'
import { UnauthenticatedError } from '../lib/errors.ts'

export async function createClient(request: FastifyRequest, reply: FastifyReply) {
  // The schema has no `role` field at all, so an attacker adding
  // "role": "ADMIN" to the body gets it silently stripped — Zod drops unknown
  // keys. Privilege escalation is not blocked by a check here; it is
  // structurally impossible.
  const input = createClientSchema.parse(request.body)

  // authenticate + authorize('ADMIN') already ran on this route.
  const admin = request.authUser
  if (!admin) throw new UnauthenticatedError()

  const created = await clientService.createClient(input, admin.id, {
    ip: request.ip,
    userAgent: request.headers['user-agent']?.slice(0, 500)
  })

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
