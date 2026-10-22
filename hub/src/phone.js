// The phone number is a login name here, not a verified identity (see docs/g3/PLAN.md):
// no SMS is sent, `phone_verified_at` stays NULL, and the number is never returned to a
// caller or written to a log in full.
const E164_DIGITS = /^[1-9]\d{7,14}$/

// Accepts what a person types — spaces, dashes, parentheses, dots — and returns E.164, or
// undefined when it cannot be one. Rejecting a leading 0 keeps a national-format number
// from being silently stored as if it carried a country code.
export function normalizePhone(raw) {
  if (typeof raw !== 'string') return undefined
  const text = raw.replace(/[\s()\-.]/g, '')
  if (!text.startsWith('+')) return undefined
  const digits = text.slice(1)
  return E164_DIGITS.test(digits) ? `+${digits}` : undefined
}

// `+8613800138000` → `+86****8000`: enough for a person to recognise their own number,
// useless to anyone enumerating accounts.
export function maskPhone(e164) {
  const text = String(e164 ?? '')
  return text.length < 8 ? '****' : `${text.slice(0, 3)}****${text.slice(-4)}`
}
