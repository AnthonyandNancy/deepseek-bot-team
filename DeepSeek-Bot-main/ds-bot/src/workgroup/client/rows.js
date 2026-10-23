// One workgroup rendered as a row of the ORIGINAL group list.
//
// Plan §0.9: workgroups are shown only inside Bot, and §8.3: the workgroup UI is the
// original group UI copied over. So a workgroup is not a separate section with its own
// header and its own "+" button — it sits in the same list as the local groups, drawn with
// the same markup (`bt-row`, `RoomAvatar`, `bt-row-body`, `bt-row-title`, `bt-row-preview`).
//
// The one addition is the marker, because a workgroup and a local group can carry exactly
// the same name (`You, Chief, …`): the name alone cannot tell them apart. The marker is a
// word plus a glyph, not a colour, so it survives greyscale and colour blindness, and the
// row's accessible name repeats it.
import { createElement as h } from 'react'
import { RoomAvatar } from '../../client/mark.js'
import { t } from '../../client/i18n.js'

// The chip shown beside a workgroup's name. `wide` false means the collapsed rail, where
// there is no room for a word: a small dot carries the distinction there.
export function WorkgroupBadge({ wide = true }) {
  if (!wide) return h('span', { className: 'bt-wg-dot', 'aria-hidden': true })
  return h('span', { className: 'bt-wg-chip' },
    h('span', { className: 'bt-wg-chip-glyph', 'aria-hidden': true }, '◆'),
    h('span', null, t('Workgroup')))
}

// A workgroup row. `room` is a workgroup from `wg.view()`: members are objects
// (`{id, name, kind}`), whereas the original's are ids — so the id list is adapted before
// it reaches `RoomAvatar`, which is the original component and is left untouched.
export function WorkgroupRow({ room, roster, actions, wide }) {
  const members = room.members ?? []
  const memberIds = members.map(member => member.id)
  const linked = room.linkedLocalName
  const label = [
    t('Workgroup'),
    room.name,
    members.length > 0 ? t('{count} members', { count: members.length }) : '',
    linked ? t('Upgraded from {name}', { name: linked }) : '',
  ].filter(Boolean).join(', ')
  return h('button', {
    type: 'button',
    className: 'bt-row bt-row-workgroup',
    'aria-label': label,
    // The row ellipsises a long name; hovering shows it whole, as a local group does.
    title: room.name,
    'data-workgroup-id': room.id,
    'data-workgroup': 'true',
    onClick: () => actions.openWorkgroup?.(room.id),
    onContextMenu: (event) => {
      event.preventDefault()
      actions.openMenu?.({ kind: 'workgroup', id: room.id, x: event.clientX, y: event.clientY })
    },
  },
  h(RoomAvatar, { room: { members: memberIds }, roster, size: 36 }),
  wide ? h('span', { className: 'bt-row-body' },
    h('span', { className: 'bt-row-name' },
      h('span', { className: 'bt-row-title' }, room.name),
      h(WorkgroupBadge, { wide })),
    // The subtitle carries what tells two same-named groups apart: the members, or where
    // the group came from. Both are facts about this group, not a reset of the clock.
    h('span', { className: 'bt-row-preview' },
      [members.length > 0 ? t('{count} members', { count: members.length }) : '',
        linked ? t('Upgraded from {name}', { name: linked }) : (room.preview ?? '')].filter(Boolean).join(' · ')))
    : h(WorkgroupBadge, { wide }))
}

// The marker's own styles. Installed with the shell group, so it is present exactly when
// the original sidebar is.
//
// The invite row's layout lives here rather than in WG_CSS because of where the row is drawn: it
// sits in the group-settings drawer, while WG_CSS is installed by the panel from inside the panel's
// own module. A row whose styles arrive only with a different surface renders as an unstyled column
// of text — which is what happened, and why the field squeezed the hint to two characters per line.
// This stylesheet is installed with the shell, so the drawer always has it.
export const WORKGROUP_ROW_CSS = `
.bt-row-workgroup .bt-row-name{display:flex;align-items:center;gap:6px;min-width:0}
.bt-wg-chip{flex:none;display:inline-flex;align-items:center;gap:3px;height:17px;padding:0 5px;border-radius:5px;border:.5px solid var(--bt-line-2);background:var(--bt-tag-bg);color:var(--bt-tag-ink);font-size:10px;line-height:1;font-weight:500;white-space:nowrap;letter-spacing:0}
.bt-wg-chip-glyph{font-size:9px;opacity:.75}
.bt-rail .bt-row-workgroup{position:relative}
.bt-wg-dot{position:absolute;right:6px;bottom:6px;width:5px;height:5px;border-radius:50%;background:var(--bt-ink-2);box-shadow:0 0 0 1.5px var(--bt-sidebar)}
/* The invite row. Stacked, because it holds two things a person reads (label, hint) and two they act
   on (a field, a button); the two-column row it borrowed first gave the field all the room and left
   the sentence three characters wide. The input keeps a minimum so a long id stays readable, and the
   hint wraps instead of being clipped. */
.bt-wg-invset{gap:8px}
.bt-wg-invset-field{display:flex;align-items:center;gap:8px;width:100%;min-width:0}
.bt-wg-invset-field>.bt-input{flex:1 1 auto;min-width:0;height:32px}
.bt-wg-invset-field>.bt-soft{flex:none}
.bt-wg-invset-reason,.bt-wg-invset-note{overflow-wrap:anywhere}
`
