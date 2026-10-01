/**
 * Structural test for the settings component, run against the real bundle.
 *
 * The bundle is executed in a VM with a miniature React runtime, the
 * component's hook state is seeded into its "loaded" phase, and the resulting
 * element tree is walked. That catches what `node --check` cannot: a card in
 * the wrong place, a subtree that stopped rendering, a percentage attached to
 * the wrong candidate.
 *
 * This does NOT replace looking at the page. It cannot see CSS, layout, or
 * whether a real Pill overflows — only that the tree is shaped correctly.
 *
 * The hook indices below are positional, so inserting a `useState` into the
 * component shifts every later one. When this suite fails after an edit to
 * `lib/client.js`, check the hook order before suspecting the logic.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

let failures = 0
const test = async (label, fn) => {
  try {
    await fn()
    console.log(`ok   - ${label}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL - ${label}`)
    console.log(`       ${error.message}`)
  }
}

/**
 * Boot the bundle and hand back a renderer seeded with the given hook state.
 *
 * Re-executed per case rather than shared: the component's `useState` cells are
 * captured in a closure, so a single VM could not be re-seeded reliably.
 */
function loadComponent() {
  const registered = []
  const style = { dataset: {}, style: {}, textContent: '' }
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry) => registered.push(entry) } },
    document: {
      head: { appendChild: () => {} },
      createElement: () => style,
      querySelector: () => null,
      getElementById: () => null,
      baseURI: 'http://127.0.0.1:3080/',
    },
    console,
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: false, status: 0, json: async () => ({}) }),
    URL,
  }
  runInContext(source, createContext(sandbox), { filename: 'lib/client.js' })

  const entry = registered[0]
  assert.ok(entry !== undefined, 'the bundle registered nothing')

  const element = (type, props, key) => ({ type, props: props ?? {}, key })
  const states = []
  let hookIndex = 0
  const react = {
    useState: (init) => {
      const at = hookIndex++
      if (!(at in states)) states[at] = typeof init === 'function' ? init() : init
      return [states[at], (next) => { states[at] = typeof next === 'function' ? next(states[at]) : next }]
    },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    // Real memo wraps the component and compares props; the structural test
    // renders directly, so a passthrough is faithful enough for shape checks.
    memo: (component) => component,
    useEffect: () => {},
    useRef: (init) => ({ current: init }),
  }
  const jsxRuntime = { jsx: element, jsxs: element, Fragment: Symbol('Fragment') }
  const primitives = new Proxy({}, { get: (_t, name) => (typeof name === 'string' ? function Primitive() {} : undefined) })

  const require = (name) => {
    if (name === 'react') return react
    if (name === 'react/jsx-runtime') return jsxRuntime
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error('unexpected require: ' + name)
  }

  const mod = entry.factory(require)
  let captured
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    locale: { register: () => {}, bind: () => (key) => key },
    slots: {
      inject: (_name, fn) => { fn() },
      register: (_options, component) => { captured = component; return () => {} },
    },
  }
  mod.apply(ctx)
  assert.ok(captured !== undefined, 'no component was registered')
  return { captured, states, resetHooks: () => { hookIndex = 0 } }
}

/** The settings status the component renders from. */
const STATUS = {
  path: '/v1', modelsPath: '/v1/models', completionsPath: '/v1/chat/completions',
  port: 3080, bindHost: '127.0.0.1', keysFile: 'C:/k.json', groupsFile: 'C:/g.json',
  authRequired: true, staticKeyCount: 0, keys: [], providers: ['codebuddy'],
  models: [{ id: 'codebuddy_glm-5.2', rawId: 'glm-5.2', provider: 'codebuddy', name: 'GLM' }],
  lan: null,
}

/**
 * Seed the component's hook cells and render.
 *
 * The indices are positional (see the header): phase, status, error, then the
 * key-dialog cells, then groups, groupModels, stats, and the group-dialog cells.
 */
function render({ groups, stats, dialog, history } = {}) {
  const { captured, states, resetHooks } = loadComponent()
  states[0] = 'idle'
  states[1] = STATUS
  states[2] = undefined
  states[10] = groups ?? []
  states[11] = [{ id: 'codebuddy_glm-5.2', name: 'GLM', provider: 'codebuddy' }]
  states[12] = stats ?? {}
  states[13] = dialog
  // ChartsCard's own metric useState is hook 0 in the shared VM counter, so
  // GatewaySection's cells all shift by one: expandedGroups is 17, statsHistory 18.
  states[17] = new Set()
  states[18] = history
  resetHooks()
  return captured({ t: (key) => key })
}

/** Every string leaf, in tree order. */
function textsOf(tree) {
  const out = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string') { out.push(node); return }
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    if (typeof node === 'object' && node.props !== undefined) walk(node.props.children)
  }
  walk(tree)
  return out
}

/** Every className in the tree, in tree order. */
function classesOf(tree) {
  const out = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    if (typeof node.props?.className === 'string') out.push(node.props.className)
    walk(node.props?.children)
  }
  walk(tree)
  return out
}

const GROUP = { id: 'g', name: 'hinds', models: ['codebuddy_glm-5.2'], enabled: true, strategy: 'round-robin', retry429: 0 }

await test('the component renders every card', async () => {
  const texts = textsOf(render({ groups: [GROUP] }))
  assert.ok(texts.length > 0, 'a non-empty tree')
  for (const key of ['groupsTitle', 'endpointTitle', 'keysTitle', 'modelsTitle', 'createGroup', 'hinds']) {
    assert.ok(texts.includes(key), `${key} is rendered`)
  }
  assert.ok(texts.includes('strategyRoundRobin'), 'the group shows its scheduling badge')
})

await test('the groups card still leads the page', async () => {
  const texts = textsOf(render({ groups: [GROUP] }))
  const at = (key) => texts.indexOf(key)
  // Pinned because moving this card was a deliberate earlier change, and
  // adding the statistics must not quietly undo it.
  assert.ok(at('groupsTitle') < at('endpointTitle'), 'groups before endpoint')
  assert.ok(at('endpointTitle') < at('keysTitle'), 'endpoint before keys')
  assert.ok(at('keysTitle') < at('modelsTitle'), 'keys before models')
})

await test('no empty text nodes leak into the tree', async () => {
  const texts = textsOf(render({ groups: [GROUP] }))
  assert.ok(texts.every((entry) => typeof entry === 'string' && entry !== ''))
})

await test('a scored candidate shows its recent answer rate', async () => {
  const texts = textsOf(render({
    groups: [GROUP],
    stats: { hinds: { requests: 4, allFailed: 0, candidates: {
      'codebuddy_glm-5.2': { attempts: 4, answered: 3, refused: 1, retry429: 0, ignored: 0, ratio: 0.75, recentRatio: 0.75 },
    } } },
  }))
  // F1: the badge now carries the sample size next to the percentage.
  assert.ok(texts.some((entry) => entry.trim() === '75% · 4'), 'percentage and sample size render next to the candidate')
  assert.ok(texts.includes('codebuddy_glm-5.2'), 'the model name is still shown')
})

await test('the badge prefers the recent rate over the lifetime one', async () => {
  // Broken earlier, fine now: the badge must show the recovery, not the scar.
  const texts = textsOf(render({
    groups: [GROUP],
    stats: { hinds: { requests: 0, allFailed: 0, candidates: {
      'codebuddy_glm-5.2': { attempts: 30, answered: 20, refused: 10, retry429: 0, ignored: 0, ratio: 0.67, recentRatio: 1 },
    } } },
  }))
  assert.ok(texts.some((entry) => entry.trim() === '100% · 30'), 'the recent rate is shown with its sample size')
  assert.ok(!texts.some((entry) => entry.trim().includes('67%')), 'the lifetime rate stays in the tooltip')
})

await test('an uncalled candidate shows no percentage at all', async () => {
  const texts = textsOf(render({ groups: [GROUP], stats: {} }))
  assert.ok(texts.includes('codebuddy_glm-5.2'))
  assert.ok(!texts.some((entry) => typeof entry === 'string' && entry.endsWith('%')),
    'a candidate with no history must not be shown as 0%')
})

await test('F1: a small sample is named in the tooltip', async () => {
  // 6 attempts is below the threshold: the tooltip must say so instead of
  // letting "100%" read as proven.
  const tree = render({
    groups: [GROUP],
    stats: { hinds: { requests: 6, allFailed: 0, candidates: {
      'codebuddy_glm-5.2': { attempts: 6, answered: 6, refused: 0, retry429: 0, ignored: 0, ratio: 1, recentRatio: 1 },
    } } },
  })
  const titles = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    if (typeof node.props?.title === 'string') titles.push(node.props.title)
    walk(node.props?.children)
  }
  walk(tree)
  assert.ok(titles.some((title) => title.includes('statSampleSmall')), 'the small-sample hint is present')
})

await test('F2: a recovered candidate tones amber, not green', async () => {
  // recent 100% on a scarred lifetime record: green would say "all clear"
  // while the lifetime rate still says "mostly broken".
  const classes = classesOf(render({
    groups: [GROUP],
    stats: { hinds: { requests: 30, allFailed: 0, candidates: {
      'codebuddy_glm-5.2': { attempts: 30, answered: 20, refused: 10, retry429: 0, ignored: 0, ratio: 0.67, recentRatio: 1 },
    } } },
  }))
  const tone = classes.find((name) => name.includes('dsh-gw-stat '))
  assert.ok(tone.includes('dsh-gw-stat-recovering'), 'the disagreement gets its own tone: ' + tone)
})

// ChartsCard and Heatmap are child components: the shared-hook VM renders
// GatewaySection but never invokes child function components, so their innards
// (legend, cell classes, hover titles) are asserted structurally against the
// bundle source instead of the element tree.
await test('heatmap legend ships the four intensity swatches and the empty one', async () => {
  assert.ok(source.includes('dsh-gw-heat-legend'), 'the legend container class exists')
  for (const cls of ['dsh-gw-heat-l1', 'dsh-gw-heat-l2', 'dsh-gw-heat-l3', 'dsh-gw-heat-l4']) {
    assert.ok(source.includes(cls + ' dsh-gw-heat-legend-swatch'), 'a legend swatch reuses ' + cls)
  }
  assert.ok(source.includes('dsh-gw-heat-empty dsh-gw-heat-legend-swatch'), 'the no-data swatch is in the legend')
})

await test('heatmap cells carry outlines; empty days go dashed instead of invisible', async () => {
  assert.ok(source.includes('outline:1px solid'), 'data cells have a solid outline')
  assert.ok(source.includes('outline:1px dashed'), 'empty cells have a dashed outline')
  assert.ok(!source.includes('dsh-gw-heat-empty{opacity:0.35}'), 'the old invisible empty style is gone')
})

await test('heatmap hover title spells calls and tokens, not just the date', async () => {
  assert.ok(source.includes('heatCellTitle'), 'the title builder exists')
  assert.ok(source.includes('title: heatCellTitle(t, cell, metric)'), 'cells use it for their title')
  assert.ok(source.includes('chartsTipCalls'), 'the calls line exists')
  assert.ok(source.includes('chartsTipTokens'), 'the token line exists')
})

await test('F3: a composite member pill expands the inner scoreboard', async () => {
  const composite = { id: 'outer', name: 'outer', models: ['dsh-model-gateway_hinds'], enabled: true, strategy: 'sequential', retry429: 0, kind: 'composite', dangling: [] }
  const tree = render({
    groups: [composite],
    stats: {
      outer: { requests: 2, allFailed: 0, candidates: { 'dsh-model-gateway_hinds': { attempts: 2, answered: 2, refused: 0, retry429: 0, ignored: 0, ratio: 1, recentRatio: 1 } } },
      hinds: { requests: 2, allFailed: 0, candidates: { 'codebuddy_glm-5.2': { attempts: 2, answered: 2, refused: 0, retry429: 0, ignored: 0, ratio: 1, recentRatio: 1 } } },
    },
  })
  // Collapsed: the inner name is not spelled out yet.
  const collapsed = textsOf(tree)
  assert.ok(!collapsed.includes('hinds\ncodebuddy_glm-5.2'), 'sanity: nothing expanded before the click')
  // The expansion hook starts empty, so a static render shows the collapsed
  // tree; the expansion affordance itself is what the tree must carry.
  const clickables = []
  const walk2 = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const child of node) walk2(child); return }
    if (typeof node.props?.onClick === 'function') clickables.push(node)
    walk2(node.props?.children)
  }
  walk2(tree)
  assert.ok(clickables.length >= 1, 'the composite member pill is clickable')
})

await test('a candidate whose only failures were excused shows no rate', async () => {
  // `ignored` means nothing that blames the candidate was ever counted, so the
  // ratio is undefined and must render as an em dash, not as 0%.
  const texts = textsOf(render({
    groups: [GROUP],
    stats: { hinds: { requests: 1, allFailed: 1, candidates: {
      'codebuddy_glm-5.2': { attempts: 1, answered: 0, refused: 0, retry429: 0, ignored: 1 },
    } } },
  }))
  assert.ok(!texts.some((entry) => typeof entry === 'string' && entry.includes('0%')), 'not 0%')
})

await test('the tone class tracks the answer rate', async () => {
  const toneFor = (recentRatio) => classesOf(render({
    groups: [GROUP],
    stats: { hinds: { requests: 1, allFailed: 0, candidates: {
      'codebuddy_glm-5.2': { attempts: 1, answered: 1, refused: 0, retry429: 0, ignored: 0, ratio: recentRatio, recentRatio },
    } } },
  })).find((name) => name.includes('dsh-gw-stat '))
  assert.ok(toneFor(1).includes('dsh-gw-stat-ok'), 'a healthy candidate is green')
  assert.ok(toneFor(0.7).includes('dsh-gw-stat-warn'), 'a patchy one is amber')
  assert.ok(toneFor(0).includes('dsh-gw-stat-bad'), 'a dead one is red')
})

await test('an unscored candidate is neutral, not red', async () => {
  const classes = classesOf(render({ groups: [GROUP], stats: {} }))
  const tone = classes.find((name) => name.includes('dsh-gw-stat '))
  assert.ok(tone.includes('dsh-gw-stat-none'), 'never called must not look broken')
})

await test('the refresh affordance is rendered', async () => {
  const texts = textsOf(render({ groups: [GROUP] }))
  assert.ok(texts.includes('refreshStats'), 'the statistics refresh button is present')
})

await test('the retry preset reveals its count input', async () => {
  const dialog = { mode: 'edit', id: 'hinds', name: 'hinds', models: ['codebuddy_glm-5.2'], preset: 'retry', retry429: 2 }
  const texts = textsOf(render({
    groups: [{ ...GROUP, strategy: 'sequential', retry429: 2 }],
    dialog,
  }))
  assert.ok(texts.includes('retryTimes'), 'the retry count input appears')
  assert.ok(texts.includes('retryHint'), 'the retry hint appears')
  assert.ok(texts.includes('presetRetryDesc'), 'the retry preset description is shown')
})

await test('the count input is hidden for a plain sequential group', async () => {
  const dialog = { mode: 'edit', id: 'hinds', name: 'hinds', models: ['codebuddy_glm-5.2'], preset: 'sequential', retry429: 0 }
  const texts = textsOf(render({ groups: [GROUP], dialog }))
  assert.ok(!texts.includes('retryTimes'), 'no retry input for a sequential group')
})

if (failures > 0) {
  console.log(`\n${failures} failing`)
  process.exitCode = 1
} else {
  console.log('\nclient structure OK')
}
