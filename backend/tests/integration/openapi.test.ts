// openapi.test.ts — the API reference cannot drift from the API.
//
// The document is hand-assembled (see src/docs/openapi.ts for why), which
// makes one failure mode likely: a route added without a docs entry. This
// file reads the routes Fastify actually registered and compares them with
// the document in both directions.

import { describe, test, expect, beforeAll } from 'bun:test'
import type { FastifyInstance } from 'fastify'
import { buildTestApp } from '../helpers.ts'
import { buildOpenApiDocument } from '../../src/docs/openapi.ts'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildTestApp()
})

/** Routes we deliberately leave out of the reference. */
const UNDOCUMENTED = new Set(['GET /docs', 'GET /docs/openapi.json'])

/**
 * Parses `printRoutes({ commonPrefix: false })`, which draws a tree:
 *
 *   ├── /invoices (POST, GET, HEAD)
 *   │   └── /:id (GET, HEAD, DELETE)
 *   │       ├── /pdf (GET, HEAD)
 *
 * Each line is a path segment at a depth given by its indentation; the full
 * path is the segments of its ancestors joined. HEAD and OPTIONS are
 * Fastify's own additions and are dropped.
 */
function registeredRoutes(): Set<string> {
  const lines = app.printRoutes({ commonPrefix: false }).split('\n').filter(Boolean)
  const stack: string[] = []
  const routes = new Set<string>()

  for (const line of lines) {
    const match = line.match(/^([│ ]*)(?:├── |└── )(\S+)(?: \(([^)]+)\))?/)
    if (!match) continue

    const depth = Math.floor(match[1]!.length / 4)
    const segment = match[2]!
    const methods = match[3]?.split(', ') ?? []

    stack.length = depth
    stack.push(segment)

    const path = stack.join('').replace(/\/:(\w+)/g, '/{$1}')
    for (const method of methods) {
      if (method === 'HEAD' || method === 'OPTIONS') continue
      routes.add(`${method} ${path}`)
    }
  }

  return routes
}

function documentedRoutes(): Set<string> {
  const document = buildOpenApiDocument()
  const routes = new Set<string>()
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const method of Object.keys(methods)) {
      routes.add(`${method.toUpperCase()} ${path}`)
    }
  }
  return routes
}

describe('the OpenAPI document', () => {
  test('🔑 documents every registered route', () => {
    const registered = registeredRoutes()
    const documented = documentedRoutes()

    const missing = [...registered].filter((r) => !documented.has(r) && !UNDOCUMENTED.has(r) && !r.startsWith('OPTIONS'))
    expect(missing).toEqual([])
    // A new route without a docs entry fails here, not in a reviewer's browser.
  })

  test('🔑 documents no route that does not exist', () => {
    const registered = registeredRoutes()
    const stale = [...documentedRoutes()].filter((r) => !registered.has(r))
    expect(stale).toEqual([])
  })

  test('the parser sees the routes we know exist', () => {
    const registered = registeredRoutes()
    expect(registered.has('POST /auth/login')).toBe(true)
    expect(registered.has('GET /invoices/{id}/pdf')).toBe(true)
    expect(registered.has('POST /invoices/{id}/credit-note')).toBe(true)
    expect(registered.size).toBeGreaterThan(20)
  })

  test('request bodies come from the Zod schemas', () => {
    const document = buildOpenApiDocument()
    const create = document.paths['/invoices']!.post as { requestBody: { content: Record<string, { schema: Record<string, unknown> }> } }
    const schema = create.requestBody.content['application/json']!.schema
    const properties = schema.properties as Record<string, Record<string, unknown>>

    expect(Object.keys(properties).sort()).toEqual(['clientId', 'dueDate', 'items'])
    expect(properties.dueDate!.format).toBe('date-time')
    // The 200-line cap and the VAT rate rule are documented because they are
    // in the validator, not because someone remembered to write them down.
    expect(properties.items!.maxItems).toBe(200)
  })

  test('is served at /docs/openapi.json and rendered at /docs', async () => {
    const json = await app.inject({ method: 'GET', url: '/docs/openapi.json' })
    expect(json.statusCode).toBe(200)
    expect(json.json().openapi).toBe('3.0.3')
    expect(json.json().info.title).toBe('Fakturly API')

    const html = await app.inject({ method: 'GET', url: '/docs' })
    expect(html.statusCode).toBe(200)
    expect(html.headers['content-type']).toContain('text/html')
    expect(html.body).toContain('swagger-ui')
  })

  test('every documented path parameter is {id}', () => {
    for (const path of Object.keys(buildOpenApiDocument().paths)) {
      const params = path.match(/\{(\w+)\}/g) ?? []
      for (const param of params) expect(param).toBe('{id}')
    }
  })
})
