// 邀请收件箱：入口在侧栏搜索按钮旁边，且真的能接受/拒绝。
//
// 用户指定：「在图中的搜索图标隔壁新增收信箱，用于接受邀请的 CURD」，按 G4 做。
// 这是 G4 的交付缺口，不是新功能：`g4/NEXT-INSTRUCTION.md` §2 把「群成员/邀请」列进 G4，
// §3 的端点清单里就有 `POST /v1/invites/:id/accept`，T08 就是「成员邀请」的验收用例。
// G5 是跨用户任务委派与审批（同意卡片），与「入群同意」不是一回事。
//
// 之前的实际缺陷：收件箱组件存在，但挂在 `WG_PANEL_KEY` 那个面板里，而全仓没有任何导航
// 指向该面板。于是邀请能到 Hub、能到本机，却没有任何地方显示——同事被邀请了却看不见。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')

test('the invitation entry is mounted in the sidebar header, beside Search', () => {
  const sidebar = read('../src/client/sidebar.js')
  // The header row is where a person looks: Search, then New, then collapse.
  const header = sidebar.slice(sidebar.indexOf("className: 'bt-side-top'"), sidebar.indexOf('bt-side-collapse'))
  assert.match(header, /h\(InviteInboxSlot\)/, 'the inbox is mounted in the header row')
  // Beside Search: the inbox comes before the Search button, and both are in the same row.
  const inboxAt = header.indexOf('h(InviteInboxSlot)')
  const searchAt = header.indexOf("t('Search')")
  assert.ok(inboxAt !== -1 && searchAt !== -1, 'both the inbox and Search are in the header')
  assert.ok(inboxAt < searchAt, 'the inbox sits next to the search icon, as the user asked')
  // The collapsed rail keeps it too: an invitation must be reachable in either layout.
  const rail = sidebar.slice(sidebar.indexOf('bt-side bt-rail'))
  assert.match(rail, /h\(InviteInboxSlot\)/, 'and in the collapsed rail')
})

test('the inbox is a real list a person can answer, not a dead badge', () => {
  const inbox = read('../src/workgroup/client/inbox.js')
  // Read: the list comes from the host's own endpoint.
  assert.match(inbox, /callWorkgroup\('group-invites'\)/)
  // Answer: accept and decline both go through the endpoint the Hub owns the row for.
  assert.match(inbox, /callWorkgroup\('answer-invite', \{ inviteId: invite\.inviteId, accept \}\)/)
  // Both verbs are offered per row, with their own labels.
  assert.match(inbox, /t\('Join'\)/)
  assert.match(inbox, /t\('Decline'\)/)
  // A row names the group and who invited; an invitation with no group name still reads as one.
  assert.match(inbox, /labelOf/)
  assert.match(inbox, /invitedByPhoneMasked/)
  // An empty inbox says so rather than rendering nothing.
  assert.match(inbox, /t\('No invitations\.'\)/)
})

test('accepting an invitation teaches the rest of the client about the new group', () => {
  const sidebar = read('../src/client/sidebar.js')
  const slot = sidebar.slice(sidebar.indexOf('function InviteInboxSlot'), sidebar.indexOf('function InviteInboxSlot') + 900)
  // A joined group has to appear in the list without a reload; the workgroup store is what the
  // sidebar rows come from, so it is refreshed on every answer.
  assert.match(slot, /onChanged: \(\) => \{ void refreshWorkgroups\(\) \}/,
    'a joined group must reach the workgroup store, or the row never appears')
})

test('the header badge counts pending invitations, and is reachable at all', () => {
  const inbox = read('../src/workgroup/client/inbox.js')
  // The count is what tells somebody an invitation is waiting without opening the list.
  assert.match(inbox, /export function InviteInboxButton/)
  assert.match(inbox, /'data-invites': String\(count\)/)
  assert.match(inbox, /Invitations \(\{count\}\)/)
  // Its styles ship with the shell, so the button is not an unstyled glyph before the panel opens.
  const index = read('../src/client/index.js')
  assert.match(index, /INBOX_CSS/, 'the inbox stylesheet is installed with the shell')
})
