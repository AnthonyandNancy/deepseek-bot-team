// Routing without a framework: a table of `{ method, pattern, handler }`, matched in order.
//
// Patterns carry `:name` segments, which is all the Hub needs and keeps the one dynamic
// route (`/v1/devices/:id/revoke`) readable. A miss returns 404 and a known path under the
// wrong method returns 405 — a framework would do both, and getting them different would
// make a typo look like a missing feature.
export function compile(pattern) {
  const segments = pattern.split('/').filter(segment => segment.length > 0)
  return {
    pattern,
    segments,
    match(path) {
      const parts = path.split('/').filter(segment => segment.length > 0)
      if (parts.length !== segments.length) return undefined
      const params = {}
      for (let at = 0; at < segments.length; at += 1) {
        const expected = segments[at]
        if (expected.startsWith(':')) params[expected.slice(1)] = decodeURIComponent(parts[at])
        else if (expected !== parts[at]) return undefined
      }
      return params
    },
  }
}

const normalizePath = (path) => {
  const withoutQuery = path.split('?')[0]
  return withoutQuery.length > 1 && withoutQuery.endsWith('/') ? withoutQuery.slice(0, -1) : withoutQuery
}

export function createRouter() {
  const routes = []
  // `options` is per-route tuning. Today it carries one thing: `maxBodyBytes`, because an
  // attachment upload is the only endpoint whose body is not a small JSON document.
  const add = (method, pattern, handler, options = {}) => {
    routes.push({ method, ...compile(pattern), handler, ...options })
  }
  return {
    get: (pattern, handler, options) => add('GET', pattern, handler, options),
    post: (pattern, handler, options) => add('POST', pattern, handler, options),
    // Returns `{ handler, params }`, or `{ methodMismatch: true }` when the path exists under
    // another method, or undefined for a genuine 404.
    resolve(method, path) {
      const target = normalizePath(path)
      let pathMatched = false
      for (const route of routes) {
        const params = route.match(target)
        if (params === undefined) continue
        pathMatched = true
        // HEAD follows GET, as it does everywhere; the response body is dropped by the caller.
        if (route.method === method || (method === 'HEAD' && route.method === 'GET')) {
          return { handler: route.handler, params, maxBodyBytes: route.maxBodyBytes }
        }
      }
      return pathMatched ? { methodMismatch: true } : undefined
    },
    get routes() {
      return routes.map(({ method, pattern }) => ({ method, pattern }))
    },
  }
}
