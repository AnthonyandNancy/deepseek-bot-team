// WHAT THE PLUGIN LOADS MUST BE IN THE PACKAGE.
//
// `index.js` loads the host modules and, through `src/workgroup/index.js`, the whole Workgroup
// domain; `bridge.js` imports `src/client/characters.js` for the published appearance snapshot.
// That last import is host code reaching into the client source. It is fine in the checkout and
// fatal in the published package unless `package.json`'s `files` covers it: npm then installs
// `bridge.js` without the file it imports, the domain's install throws, its route never registers,
// and every Hub call — including login — answers 404 while the local Bot team keeps working.
//
// So the assertion is the module GRAPH, not one remembered filename. Read every relative import
// reachable from the two entry points and require each resolved file to be covered by `files`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const PACKAGE = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))
const PREFIXES = PACKAGE.files.filter(file => file.endsWith('/'))
const FILES = new Set(PACKAGE.files.filter(file => !file.endsWith('/')))

function covered(file) {
  return FILES.has(file) || PREFIXES.some(prefix => file.startsWith(prefix))
}

// A relative specifier from an ES module: `./x.js`, `../y/z.js`, or a bare directory import.
// `new URL(specifier, import.meta.url)` is the point of truth for resolution, so the test cannot
// invent a path the runtime would not use.
function importsOf(file) {
  const source = readFileSync(resolve(ROOT, file), 'utf8')
  const found = []
  const pattern = /(?:^|\n)\s*(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g
  let match
  while ((match = pattern.exec(source))) if (match[1].startsWith('.')) found.push(match[1])
  return found
}

function resolveLocal(from, specifier) {
  const target = relative(ROOT, resolve(dirname(resolve(ROOT, from)), specifier)).split(sep).join('/')
  return target.endsWith('.js') ? target : `${target}.js`
}

test('every host module the plugin loads is covered by package.json files', () => {
  const queue = ['index.js', 'src/workgroup/index.js']
  const visited = new Set()
  const uncovered = []
  const missing = []
  while (queue.length > 0) {
    const file = queue.shift()
    if (visited.has(file)) continue
    visited.add(file)
    try {
      statSync(resolve(ROOT, file))
    } catch {
      missing.push(file)
      continue
    }
    if (!covered(file)) uncovered.push(file)
    for (const specifier of importsOf(file)) queue.push(resolveLocal(file, specifier))
  }

  assert.deepEqual(missing, [], `the host graph imports files that do not exist: ${missing.join(', ')}`)
  assert.deepEqual(uncovered, [],
    `the published package would omit host modules it loads: ${uncovered.join(', ')}`)
})
