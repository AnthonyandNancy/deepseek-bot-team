// The workgroup client's own API call. A separate route from the original client's
// (`src/client/api.js` posts to `api/bot`); this one posts to `api/workgroup`, so a
// workgroup request can never be mistaken for an original-team request (P0-18).
const ROUTE = 'api/workgroup'

// Refusals are shown to the user where they acted; anything else is reported.
const REFUSALS = new Set(['bot/refused', 'bot/invalid', 'bot/read-only', 'bot/not-found'])

export const callWorkgroup = async (endpoint, payload, signal) => {
  let response
  try {
    // Document-relative so the Web UI keeps working under a mounted base path.
    response = await fetch(ROUTE, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, payload: payload ?? null }),
      signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw Object.assign(new Error('Could not reach DSH. Check that it is still running.'), { code: 'NETWORK', cause: error })
  }
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { code: `HTTP_${response.status}` })
  const result = await response.json()
  if (!result.ok) {
    const code = result.error?.code ?? 'bot/error'
    const error = Object.assign(new Error(result.error?.message ?? 'Request failed'), { code })
    error.refusal = REFUSALS.has(code)
    throw error
  }
  return result.value
}
