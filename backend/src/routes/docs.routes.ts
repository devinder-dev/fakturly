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
import { buildOpenApiDocument } from '../docs/openapi.ts'

const SWAGGER_UI_VERSION = '5.17.14'

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Fakturly API</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui.css" />
  <style>body { margin: 0 } .topbar { display: none }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui-bundle.js" crossorigin></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: '/docs/openapi.json',
      dom_id: '#swagger-ui',
      deepLinking: true,
      persistAuthorization: true,
      tryItOutEnabled: true
    })
  </script>
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
    return reply.code(200).type('text/html; charset=utf-8').send(page)
  })
}
