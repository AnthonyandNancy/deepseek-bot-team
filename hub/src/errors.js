// One error type for every refusal the Hub sends back. The HTTP layer turns it into
// `{ error: { code, message } }` and the status it carries; anything else that escapes a
// handler is a Hub bug and becomes a 500 with no internal detail in the body.
export class HubError extends Error {
  constructor(status, code, message, headers) {
    super(message)
    this.name = 'HubError'
    this.status = status
    this.code = code
    this.headers = headers
  }
}

export const badRequest = (code, message) => new HubError(400, code, message)
export const unauthorized = (code = 'auth/invalid-token', message = 'The session is not valid.') => new HubError(401, code, message)
export const forbidden = (code, message) => new HubError(403, code, message)
export const notFound = (code = 'hub/not-found', message = 'Not found.') => new HubError(404, code, message)
export const conflict = (code, message) => new HubError(409, code, message)
export const tooMany = (retryAfterMs, code = 'auth/rate-limited') => new HubError(
  429, code, 'Too many attempts. Try again later.',
  { 'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
)
