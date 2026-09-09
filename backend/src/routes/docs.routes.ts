// docs.routes.ts — the API reference.
//
//   GET /docs              Swagger UI, reading the document below
//   GET /docs/openapi.json the OpenAPI 3 document
//
// Public: the document describes the API's shape, which the frontend bundle
// reveals anyway, and it contains no data. What it does reveal is which
// endpoints exist — acceptable for a portfolio API, and something a real
// deployment might put behind the admin role with one line.
//
// Swagger UI is loaded from a CDN rather than bundled: no dependency, no
// build step, and the page is not part of the product.

import type { FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import { buildOpenApiDocument } from '../docs/openapi.ts'

const SWAGGER_UI_VERSION = '5.17.14'

// Subresource integrity: the browser refuses the file unless its hash
// matches. A compromised CDN would otherwise run script on the API's origin —
// where the refresh cookie lives. Recompute when bumping the version:
//   curl -sL <url> | openssl dgst -sha384 -binary | openssl base64 -A
const SRI = {
  css: 'sha384-wxLW6kwyHktdDGr6Pv1zgm/VGJh99lfUbzSn6HNHBENZlCN7W602k9VkGdxuFvPn',
  js: 'sha384-wmyclcVGX/WhUkdkATwhaK1X1JtiNrr2EoYJ+diV3vj4v6OC5yCeSu+yW13SYJep'
}

const INLINE_SCRIPT = `
    window.ui = SwaggerUIBundle({
      url: '/docs/openapi.json',
      dom_id: '#swagger-ui',
      deepLinking: true,
      // Not persisted: a pasted bearer token would otherwise sit in this
      // origin's localStorage for anyone at the same machine to read.
      persistAuthorization: false,
      tryItOutEnabled: true
    })
  `

/** The CSP hash of the inline bootstrap above, computed once at boot. */
const INLINE_SCRIPT_HASH = createHash('sha256').update(INLINE_SCRIPT).digest('base64')

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Fakturly API</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui.css" integrity="${SRI.css}" crossorigin="anonymous" />
  <style>body { margin: 0 } .topbar { display: none }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui-bundle.js" integrity="${SRI.js}" crossorigin="anonymous"></script>
  <script>${INLINE_SCRIPT}</script>
</body>
</html>`

export default async function docsRoutes(app: FastifyInstance) {
  // Built once at boot. The document depends on configuration (DEMO_MODE),
  // never on request data, so there is nothing to recompute per request.
  const document = buildOpenApiDocument()

  app.get('/docs/openapi.json', async (_request, reply) => {
    return reply.code(200).header('cache-control', 'public, max-age=300').send(document)
  })

  app.get('/docs', async (_request, reply) => {
    return reply
      .code(200)
      .type('text/html; charset=utf-8')
      // Only this CDN may supply script and style; the inline bootstrap is
      // allowed by hash of its exact bytes. Anything else is refused.
      .header(
        'content-security-policy',
        "default-src 'self'; script-src https://cdn.jsdelivr.net 'sha256-" + INLINE_SCRIPT_HASH + "'; " +
          "style-src https://cdn.jsdelivr.net 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self' data:"
      )
      .send(page)
  })
}
