// Builds client.js, the browser half, from the modules in src/client.
//
//   node scripts/build-client.mjs           writes client.js
//   node scripts/build-client.mjs --check   exits 1 when client.js differs from a fresh build
//   node scripts/build-client.mjs --watch   writes client.js, then rebuilds on every change
//
// client.js is committed, so `link:` and git installs need no build step. dsh loads it as
// a classic script; the wrapper mirrors packages/client/tsdown.client.ts in
// deepseek-harness: `require` resolves the shell-seeded platform modules (react,
// react-dom, ui-primitives, ...), which therefore stay external.
//
// `--watch` exists for development against the desktop app: the plugin's host half is loaded once at
// process start, so a change there always needs a restart, but the browser half is read from
// `client.js` whenever the window loads. Rebuilding on save is what turns that into a working loop —
// edit, reload the window — instead of "edit, remember to run the build, reload".
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, context } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const OUTPUT = join(PLUGIN, 'client.js')
const PLATFORM_MODULES = ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives']

// One place for the esbuild options, so a watch rebuild and a one-shot build cannot drift apart.
const OPTIONS = {
  // Region comments name sources relative to the plugin, wherever the script runs from.
  absWorkingDir: PLUGIN,
  entryPoints: ['src/client/index.js'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: PLATFORM_MODULES,
  // Every source declaration ships, used or not, as in the hand-written bundle.
  treeShaking: false,
  // Readable for debugging in the browser: no minification, and Chinese text stays text.
  charset: 'utf8',
  write: false,
  logLevel: 'silent',
}

// The loader expects a named module whose factory returns a plain exports object.
const wrap = text => [
  '// Generated from src/client by `npm run build` (scripts/build-client.mjs). Do not edit by hand.',
  'window.__ModuleLoader__.load({',
  '  id: \'ds-bot\',',
  '  factory: (require) => {',
  'const module = { exports: {} }',
  text.trimEnd(),
  // The loader gets a plain exports object tagged as a module, as the tsdown preset
  // emits, rather than esbuild's getter-based `__esModule` object.
  'return Object.defineProperty({ ...module.exports }, Symbol.toStringTag, { value: \'Module\' })',
  '  },',
  '})',
  '',
].join('\n')

export async function bundleClient() {
  const result = await build(OPTIONS)
  if (result.warnings.length > 0) throw new Error(`esbuild warnings:\n${result.warnings.map(warning => warning.text).join('\n')}`)
  return wrap(result.outputFiles[0].text)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--watch')) {
    // The output is wrapped rather than written straight out by esbuild, so it is written from a
    // plugin hook. A failed rebuild leaves the previous `client.js` in place, which is what keeps a
    // half-typed edit from blanking the UI mid-iteration.
    const watcher = await context({
      ...OPTIONS,
      plugins: [{
        name: 'write-wrapped-client',
        setup(pluginBuild) {
          pluginBuild.onEnd(result => {
            if (result.errors.length > 0) return
            writeFileSync(OUTPUT, wrap(result.outputFiles[0].text))
            // A timestamp, not a byte count: the question this answers is "is the build I am looking
            // at the one I just saved", and a size that happens not to change would look like nothing
            // happened.
            process.stdout.write(`[build-client] client.js rebuilt at ${new Date().toLocaleTimeString()}\n`)
          })
        },
      }],
    })
    await watcher.watch()
    process.stdout.write('[build-client] watching src/client; press Ctrl+C to stop\n')
  } else {
    const next = await bundleClient()
    if (process.argv.includes('--check')) {
      let current = null
      try { current = readFileSync(OUTPUT, 'utf8') } catch { /* missing counts as stale */ }
      if (current !== next) {
        console.error('client.js is stale: run `npm run build` in ds-bot and commit the result')
        process.exit(1)
      }
    } else {
      writeFileSync(OUTPUT, next)
    }
  }
}
