// The sidebar's selected row, for BOTH kinds of group.
//
// The user's report: 「左侧操作栏，选中工作群，没有[如图一]这种选中的样式」. A local group highlighted
// and a workgroup did not, on the same list, drawn by neighbouring components.
//
// The cause is a half-copied row: `WorkgroupRow` was copied from the original's group row but the
// SELECTED STATE was not, so it never set `aria-current`. The original stylesheet draws selection
// with exactly that attribute (`.bt-row[aria-current=page]{background:var(--bt-active)}`), and the
// reason it holds for a local group is `useSessionRetainInfo(room.id, …)` — the same call the
// local row makes, which the sidebar never passed to the workgroup row at all.
//
// The assertions below are the two halves: the row sets the attribute when it is selected, and the
// sidebar hands it the means to know.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadClientModule } from './client-render.mjs'

const sidebarSource = readFileSync(new URL('../src/client/sidebar.js', import.meta.url), 'utf8')
const rowsSource = readFileSync(new URL('../src/workgroup/client/rows.js', import.meta.url), 'utf8')

const codeOnly = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/)
  .filter(line => !line.trim().startsWith('//'))
  .join('\n')

// Every element in a fake-React tree, depth first.
const walk = (node, out = []) => {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) { for (const child of node) walk(child, out); return out }
  if (typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) walk(child, out)
  return out
}

const renderRow = async ({ selected }) => {
  const { WorkgroupRow } = await loadClientModule(`
    export { WorkgroupRow } from './src/workgroup/client/rows.js'
  `)
  // `useSessionRetainInfo(id, read)` is how a row asks whether its Session is the one on screen. The
  // fake answers the way the real hook does for the selected row and for every other row.
  const useSessionRetainInfo = (id, read) => read({ retainedBy: { mainView: selected ? 1 : 0 } })
  const room = { id: 'wg-1', name: 'You, Chief', members: [{ id: 'a', name: 'Chief', kind: 'localBot' }], createdAt: 1 }
  const tree = WorkgroupRow({
    room,
    roster: { byId: { a: { id: 'a', name: 'Chief' } }, bots: [] },
    actions: {},
    useSessionRetainInfo,
    useUi: () => undefined,
    wide: true,
  })
  return walk(tree).find(node => node.type === 'button')
}

test('a selected workgroup row is marked, exactly as a local group row is', async () => {
  const selected = await renderRow({ selected: true })
  // `aria-current=page` is what `.bt-row[aria-current=page]{background:var(--bt-active)}` paints. A
  // row that omits it is the one visual difference the user reported.
  assert.equal(selected.props['aria-current'], 'page',
    'a selected workgroup must carry the attribute the original stylesheet paints')

  const other = await renderRow({ selected: false })
  assert.equal(other.props['aria-current'], undefined, 'and an unselected one must not')
})

test('the sidebar gives the workgroup row the same "am I selected" source as the local row', () => {
  const code = codeOnly(sidebarSource)
  const call = /h\(WorkgroupRow, \{([^}]*)\}/.exec(code)
  assert.ok(call !== null, 'the sidebar renders WorkgroupRow')
  // `rowProps` is the object the local group row spreads, and it is what carries
  // `useSessionRetainInfo`; a hand-built prop list is what left the workgroup row without it.
  assert.match(call[1], /\.\.\.rowProps/,
    'WorkgroupRow must spread rowProps, as RoomRow does, so it receives useSessionRetainInfo')
  // And the source that variable carries really is the hook: spreading something else would
  // satisfy the line above and still leave the row unable to know it is selected.
  const props = /const rowProps = \{([^}]*)\}/.exec(code)
  assert.ok(props !== null, 'rowProps is defined')
  const usesHook = /useSessionRetainInfo/.test(props[1]) || /useSessionRetainInfo:\s*props\.useSessionRetainInfo/.test(code)
  assert.ok(usesHook, 'rowProps must carry useSessionRetainInfo')
})

test('the selected-row style is the ORIGINAL rule, not a second one for workgroups', () => {
  // A workgroup is drawn with `bt-row`, so it inherits the original rule. A separate
  // `.bt-row-workgroup[data-selected]` rule would be a second way to paint the same fact, and the
  // copy rule is that the original components stay the original components.
  const code = codeOnly(rowsSource)
  assert.doesNotMatch(code, /\[data-selected/, 'no workgroup-only selected style')
  assert.doesNotMatch(code, /aria-current.*background|background.*aria-current/, 'the row does not paint itself')
})
