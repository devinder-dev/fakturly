// reports.controller.ts — HTTP for the reports.
//
// Each report answers JSON by default and a file when ?format=csv. The
// service produces both; this file only decides the headers.

import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  agingQuerySchema,
  vatQuerySchema,
  sieQuerySchema
} from '../validators/report.validator.ts'
import * as reportService from '../services/report.service.ts'
import { formatOre } from '../lib/money.ts'
import { UnauthenticatedError } from '../lib/errors.ts'

/**
 * A downloadable file. `attachment` so the browser saves rather than shows,
 * and `no-store` because a report is a snapshot of a moment.
 */
function sendFile(reply: FastifyReply, filename: string, contentType: string, body: string | Buffer) {
  return reply
    .code(200)
    .type(contentType)
    .header('content-disposition', `attachment; filename="${filename}"`)
    .header('cache-control', 'no-store')
    .send(body)
}

export async function aging(request: FastifyRequest, reply: FastifyReply) {
  const query = agingQuerySchema.parse(request.query)
  const report = await reportService.agingReport(query.asOf)

  if (query.format === 'csv') {
    const stamp = report.asOf.toISOString().slice(0, 10)
    return sendFile(reply, `kundreskontra-${stamp}.csv`, 'text/csv; charset=utf-8', reportService.agingReportCsv(report))
  }

  return reply.code(200).send({
    report: {
      ...report,
      buckets: reportService.AGING_BUCKETS.map((b) => ({ key: b.key, label: b.label })),
      formatted: { total: formatOre(report.totals.totalOre) }
    }
  })
}

export async function vat(request: FastifyRequest, reply: FastifyReply) {
  const query = vatQuerySchema.parse(request.query)
  const report = await reportService.vatReport(query.from, query.to)

  if (query.format === 'csv') {
    const from = query.from.toISOString().slice(0, 10)
    const to = query.to.toISOString().slice(0, 10)
    return sendFile(reply, `momsrapport-${from}-${to}.csv`, 'text/csv; charset=utf-8', reportService.vatReportCsv(report))
  }

  return reply.code(200).send({
    report: {
      ...report,
      formatted: {
        net: formatOre(report.totals.netOre),
        vat: formatOre(report.totals.vatOre)
      }
    }
  })
}

export async function sie(request: FastifyRequest, reply: FastifyReply) {
  const query = sieQuerySchema.parse(request.query)
  const caller = request.authUser
  if (!caller) throw new UnauthenticatedError()

  const file = await reportService.sieExport(query.year, caller.id, {
    ip: request.ip,
    userAgent: request.headers['user-agent']?.slice(0, 500)
  })

  // application/octet-stream rather than text: the bytes are CP437, and a
  // text type would invite the browser to decode them as UTF-8.
  return sendFile(reply, file.filename, 'application/octet-stream', file.bytes)
}
