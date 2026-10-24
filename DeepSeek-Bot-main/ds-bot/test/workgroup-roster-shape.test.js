// What the group components receive for a WORKGROUP.
//
// A workgroup is a group chat, so it is indexed in `roomsById` beside the local groups and drawn by
// the original group components. Those components were written for a LOCAL team and they all read a
// member the same way: `room.members` is a list of *ids*, and each id is looked up in `roster.byId`.
//
// A workgroup's members are not local Bots — the Hub describes one as a person (`usr_…`) or as
// somebody else's Bot endpoint (`ep_…`) — so those ids are keys no lookup could answer. The
// adaptation has to make them answer, and it has to happen HERE, in the one place that bridges the
// two shapes.
//
// It did not, and the effects were visible on screen at the same time:
//   * 「4 位成员」 from the header (it reads `room.members.length`)
//   * 「成员 · 0」 below it (it maps the ids through `byId` and drops every miss)
//   * 「无管理员」 (the admin is an id too)
//   * a BLACK GUMDROP for the group face — `lookOf(undefined)` is exactly a black gumdrop, so a face
//     that renders black is the proof that nothing resolved.
//
// The tempting shortcut is to pass the member records through `room.members` instead. That does not
// work: `RoomAvatar` and `GroupSettingsForm` do `roster.byId[id]`, and an object used as a key
// becomes `"[object Object]"`, which resolves to nothing — the same black gumdrop, from the other
// direction. The ids must stay ids; it is `byId` that has to answer for them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { indexRoster, groupRooms } from '../src/client/sources.js'

// A roster as the host sends it: the Hub's own member rows, with names.
const hubRoom = {
  id: 's-room-1',
  name: 'You, Chief, 路人甲A',
  adminId: 'usr_owner',
  members: [
    { id: 'ep_a', kind: 'remoteBot', name: '路人甲A', endpointId: 'ep_a', role: 'member' },
    { id: 'ep_b', kind: 'remoteBot', name: 'Chief', endpointId: 'ep_b', role: 'member' },
    { id: 'usr_owner', kind: 'user', name: '+86****2222', hubUserId: 'usr_owner', role: 'owner' },
  ],
  hubWorkgroupId: 'wg_1',
}

const workgroupRoster = () => indexRoster({ bots: [], rooms: [], agents: [] }, [hubRoom])

test('a workgroup hands the group components the same member shape a local group does', () => {
  // The shape matters more than it looks: every original component assumes ids here, so a record
  // would be used as an object key. Ids keep the copied components working unchanged.
  const [room] = groupRooms([hubRoom])
  assert.deepEqual(room.members, ['ep_a', 'ep_b', 'usr_owner'])
  // The admin is exposed under the name the original components read.
  assert.equal(room.admin, 'usr_owner')
  // Still marked as a workgroup, which is what routes it to the copied settings form.
  assert.equal(room.workgroup, true)
})

test('every member id a workgroup hands out resolves through byId', () => {
  // This is the assertion that failed on screen. The ids are handed to components that look them up,
  // so a list of ids nobody indexed is a list that renders as nothing — at the same time as the
  // header above it counts the very same members.
  const roster = workgroupRoster()
  const room = roster.roomsById['s-room-1']
  assert.equal(room.members.length, 3)
  const drawn = room.members.map(id => roster.byId[id]).filter(Boolean)
  assert.deepEqual(drawn.map(member => member.name), ['路人甲A', 'Chief', '+86****2222'])
  // A mark needs an id to derive a shape and a colour from; without one it draws the black fallback,
  // which is exactly how this bug looked.
  for (const member of drawn) {
    assert.ok(member.id !== undefined, 'a drawn member needs an id')
    assert.equal(typeof member.id, 'string')
  }
  // The admin resolves too, or the subtitle reads "No admin" for a group that has one.
  assert.equal(roster.byId[room.admin]?.name, '+86****2222')
})

test('indexing a workgroup member never turns it into a Bot of this team', () => {
  // The members go into `byId` because that is the lookup, but `bots` drives the Bots list, the
  // roster count, the "@" menu and everything that iterates the team. A remote person is not one.
  const roster = workgroupRoster()
  assert.deepEqual(roster.bots, [])
  // And a local Bot wins a collision, so precedence does not depend on Hub ids being distinct.
  const shared = indexRoster({ bots: [{ id: 'ep_a', name: 'Local Chief' }], rooms: [], agents: [] }, [hubRoom])
  assert.equal(shared.byId.ep_a.name, 'Local Chief')
})

test('a local group is untouched by any of this', () => {
  // The regression guard: local groups take member ids and have always resolved them through `byId`.
  // Whatever the workgroup path grows, a local room must keep exactly the shape it had.
  const local = { id: 'r1', name: '本地群', members: ['a', 'b'], admin: 'a', named: true }
  const roster = indexRoster({
    bots: [{ id: 'a', name: 'Chief' }, { id: 'b', name: 'Writer' }],
    rooms: [local],
    agents: [],
  }, [])
  const room = roster.roomsById.r1
  assert.deepEqual(room.members, ['a', 'b'])
  assert.equal(room.workgroup, undefined, 'a local room must not be marked as a workgroup')
  assert.deepEqual(room.members.map(id => roster.byId[id].name), ['Chief', 'Writer'])
})

test('the components that draw a group resolve members by id, and are left untouched', () => {
  // The fix belongs in the adaptation layer, not in the copied components: they are the original
  // text and must keep reading `room.members` as ids. This pins that, so a later "fix" cannot move
  // the lookup into them and break local groups at the same time.
  const mark = readFileSync(new URL('../src/client/mark.js', import.meta.url), 'utf8')
  assert.match(mark, /const members = room\.members\.map\(id => roster\.byId\[id\]\)\.filter\(Boolean\)/,
    'RoomAvatar reads members as ids; the adaptation layer owes it resolvable ids')
  const settings = readFileSync(new URL('../src/client/group-settings.js', import.meta.url), 'utf8')
  assert.match(settings, /const members = room\.members\.map\(id => roster\.byId\[id\]\)\.filter\(Boolean\)/)
})

test('a member that is one of this team\u2019s Bots is drawn as that Bot, not as a stray', () => {
  // THE AVATAR BUG. The member record on the wire is thin: `{id, kind, name}`. `lookOf()` derives a
  // character's shape and colour from the id, and a workgroup member's id is the Hub's `ep_…`, so
  // every member of a workgroup wore a shape and colour derived from an endpoint id — visually a
  // random Bot, never the one in the sidebar. The sidebar and this pane showed the same Bot in two
  // different characters, which is what the user reported.
  //
  // `applyRoster` records `botId` for a member it recognised as this machine's own Bot, and the
  // adaptation resolves that member to the BOT's own record — the one carrying `color` and `avatar`.
  const bot = { id: 'a', name: 'Chief', role: 'Boss', color: '#e8722c', avatar: { shape: 'whale' } }
  const roster = indexRoster({ bots: [bot], rooms: [], agents: [] }, [{
    id: 's-room-1',
    name: 'G',
    adminId: 'ep_a',
    members: [
      { id: 'ep_a', kind: 'localBot', botId: 'a', name: 'Chief', role: 'member' },
      { id: 'usr_o', kind: 'user', name: '+86****2222', role: 'owner' },
    ],
  }])
  const drawn = roster.byId['ep_a']
  // The same object the sidebar draws, so the two surfaces cannot disagree about a Bot's character.
  assert.equal(drawn, roster.bots[0], 'the member IS the Bot record')
  assert.equal(drawn.color, '#e8722c', 'its own colour, not one derived from the endpoint id')
  assert.deepEqual(drawn.avatar, { shape: 'whale' }, 'its own character')
  // A person has no local Bot to resolve to, and still resolves to the member record.
  assert.equal(roster.byId['usr_o'].name, '+86****2222')
})

test('a member of another machine keeps its own member record', () => {
  // A remote Bot endpoint is somebody else's Bot: there is nothing local to draw it with, so it must
  // stay the member record rather than accidentally resolving to a local Bot.
  const roster = indexRoster({ bots: [{ id: 'a', name: 'Chief' }], rooms: [], agents: [] }, [{
    id: 's-room-1',
    name: 'G',
    adminId: null,
    members: [{ id: 'ep_remote', kind: 'remoteBot', name: 'Their Chief', role: 'member' }],
  }])
  const drawn = roster.byId['ep_remote']
  assert.equal(drawn.name, 'Their Chief')
  assert.equal(drawn.botId, undefined, 'a remote member has no local Bot')
})
