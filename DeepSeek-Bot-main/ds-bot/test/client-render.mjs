// Renders a client module outside a browser, for tests that must inspect what a
// component actually returns.
//
// The client modules import `react` and `@deepseek-ai/dsh-client-ui-primitives`, which a
// test process cannot resolve (the shell supplies them through its own import map). So
// this bundles the requested module with esbuild — exactly like test/bot-mark.test.js —
// marks those two as external, and evaluates the bundle against a fake React that
// returns plain trees. `useState` returns the initial value, so a component renders its
// first frame, which is what these assertions need.
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// One fake React for every module loaded through here, so a component and the helpers it
// imports see the same `createElement`.
export const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: make => make(),
  useCallback: fn => fn,
  useRef: current => ({ current }),
  useContext: () => null,
  createContext: () => ({ Provider: 'provider', Consumer: 'consumer' }),
  Fragment: 'fragment',
  Children: { toArray: value => (Array.isArray(value) ? value.flat(Infinity) : [value]) },
  memo: component => component,
}

// The primitives the client imports. Only the names ds-bot uses need to exist, and each
// one renders a marker so a test can tell it apart from a plain element.
const fakePrimitives = new Proxy({}, {
  get: (_target, name) => (name === '__esModule' ? false : () => ({ type: `primitive:${String(name)}`, props: {}, children: [] })),
})

/**
 * Bundle and evaluate the module source, returning its exports.
 * @param source - an ES module body whose imports resolve from the plugin root.
 */
export async function loadClientModule(source) {
  const bundle = await build({
    stdin: { contents: source, resolveDir: root },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    // `fetch` is reached only by an effect, and effects never run here.
    fetch: () => Promise.reject(new Error('no network in tests')),
    console,
    require: name => (name === 'react' ? fakeReact : name === '@deepseek-ai/dsh-client-ui-primitives' ? fakePrimitives : {}),
  })
  return module.exports
}
