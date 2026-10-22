// The HTTP surface: read the body, resolve the route, call the handler, shape the response.
//
// Three things this layer guarantees, so no handler has to remember them:
//   * a body is parsed once, capped, and never logged;
//   * a `HubError` becomes `{ error: { code, message } }` with its status, and anything else
//     becomes a 500 whose body says nothing about the internals (the detail goes to the log);
//   * in plaintext mode a request from anywhere but this machine is refused before the
//     handler runs, so the local-only exception cannot be bypassed by one forgotten check.
import { HubError, notFound } from './errors.js'
import { isLoopback } from './config.js'

// Enough for a public key and a password; small enough that a body cannot be used to make
// the Hub allocate.
export const MAX_BODY_BYTES = 64 * 1024

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = []
  let size = 0
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      reject(new HubError(413, 'hub/body-too-large', 'The request body is too large.'))
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  req.on('error', reject)
})

function parseJson(text) {
  if (text.length === 0) return {}
  try {
    const value = JSON.parse(text)
    // A JSON body must be an object: an array or a bare string here means the caller and the
    // Hub disagree about the protocol, which is worth a 400 rather than a confusing 500.
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    throw new HubError(400, 'hub/invalid-json', 'The request body must be JSON.')
  }
}

const json = (status, body, headers = {}) => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  body: JSON.stringify(body),
})

export function createHttpHandler({ router, logger, allowInsecureLoopbackOnly, now = () => Date.now() }) {
  return async function handle(req, res) {
    const startedAt = now()
    const url = req.url ?? '/'
    const path = url.split('?')[0]
    const ip = req.socket?.remoteAddress ?? 'unknown'
    let status = 500

    const finish = (response) => {
      status = response.status
      res.writeHead(response.status, response.headers)
      // HEAD promises no body; the headers still describe what a GET would have returned.
      res.end(req.method === 'HEAD' ? undefined : response.body)
    }

    try {
      // The local-only exception is checked here, on every request, rather than at startup:
      // a listener can end up reachable from elsewhere (a reverse proxy, a container bridge)
      // and the startup check would not know.
      if (allowInsecureLoopbackOnly && !isLoopback(ip)) {
        throw new HubError(403, 'hub/plaintext-refused', 'This Hub is running without TLS and only accepts requests from this machine.')
      }

      const route = router.resolve(req.method, path)
      if (route === undefined) throw notFound('hub/not-found', 'No such endpoint.')
      if (route.methodMismatch === true) throw new HubError(405, 'hub/method-not-allowed', `${req.method} is not allowed on ${path}.`)

      const raw = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req)
      const body = parseJson(raw)
      const result = await route.handler({
        params: route.params,
        body,
        req,
        ip,
        headers: req.headers,
      })
      finish(result === undefined ? json(204, null) : result.status === undefined ? json(200, result) : result)
    } catch (error) {
      if (error instanceof HubError) {
        finish({ status: error.status, headers: { 'content-type': 'application/json; charset=utf-8', ...error.headers }, body: JSON.stringify({ error: { code: error.code, message: error.message } }) })
      } else {
        // The handler's own bug. Logged with its stack, answered without it.
        logger.error('http.unhandled', { method: req.method, path, error })
        finish({ status: 500, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ error: { code: 'hub/internal', message: 'The Hub failed to handle this request.' } }) })
      }
    } finally {
      // Path only: the query string is where a token would be if a client ever put one there.
      logger.info('http.request', { method: req.method, path, status, durationMs: now() - startedAt })
    }
  }
}

// A handler's plain return value becomes a 200. Two cases need a different status, so they
// say so explicitly rather than the HTTP layer guessing from the body's shape.
export const created = value => json(201, value)
export const noContent = () => json(204, null)

export { json }
