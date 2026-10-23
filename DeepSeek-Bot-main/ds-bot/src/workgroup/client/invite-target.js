// Which kind of account an invite is for, from one field.
//
// Its own module because it is the only part of the invite row that can be tested without a DOM or
// React: the row itself is a component, and a test that imported it would need the client bundle.
//
// Hub user ids are minted as `usr_…` (hub/src/db), so the prefix is unambiguous. Everything else is
// sent as a phone number, including something that is obviously neither: the Hub's own refusal is a
// better sentence than a client-side guess ("no account matches that person" is about a phone, an id
// that does not exist has its own answer).
export function inviteTarget(value) {
  const text = String(value ?? '').trim()
  if (text === '') return {}
  if (text.startsWith('usr_')) return { hubUserId: text }
  return { phone: text }
}
