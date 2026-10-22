// Formatting shared by the host and the client half of the Hub account page.
//
// The Hub already returns only a masked number, so this is not a security boundary — it is the
// one place the mask's shape is defined, so the host and the settings page cannot disagree about
// what "signed in as +86****8000" looks like.
export const maskPhone = (value) => {
  const text = String(value ?? '')
  // Already masked by the Hub: keep it, so a mask is never double-masked into nonsense.
  if (text.includes('*')) return text
  return text.length < 8 ? '****' : `${text.slice(0, 3)}****${text.slice(-4)}`
}

// The account page shows a status line per situation. One function, so every caller agrees on
// what "signed in but the Hub is down" is called.
export const sessionLabel = ({ loggedIn, unreachable, switching }) => {
  if (switching === true) return 'Switching account…'
  if (loggedIn && unreachable === true) return 'Signed in. The Hub is not reachable right now.'
  if (loggedIn) return 'Signed in'
  if (unreachable === true) return 'Not signed in. The Hub is not reachable.'
  return 'Not signed in'
}
