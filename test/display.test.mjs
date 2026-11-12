// Display-logic tests for the client half. The browser bundle is loaded with a
// stubbed module loader and React, so the pure helpers can be exercised without
// a DOM. Run with: node --test
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

/** Load the real client bundle with stubbed loader/react and expose its test hooks. */
async function loadClient() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let loaded = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (config) => { loaded = config } } },
    document: { body: {} },
    console,
  }
  vm.runInNewContext(source, sandbox)
  assert.ok(loaded !== null, 'client bundle must register itself')
  assert.equal(loaded.id, 'dsh-opencode-go-usage-badge')
  const reactStub = {
    Component: class {},
    createElement: () => null,
    Fragment: Symbol('Fragment'),
    useState: () => [null, () => {}],
    useRef: () => ({ current: null }),
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
  const moduleExports = loaded.factory((name) => {
    if (name === 'react') return reactStub
    if (name === 'react-dom') return { createPortal: () => null }
    throw new Error(`unexpected require: ${name}`)
  })
  assert.equal(typeof moduleExports.apply, 'function')
  assert.ok(moduleExports.__test !== undefined, 'client must expose __test hooks')
  return moduleExports.__test
}

const T = await loadClient()

const WINDOWS = [
  { kind: 'session', remainingPercent: 82 },
  { kind: 'weekly', remainingPercent: 45 },
  { kind: 'monthly', remainingPercent: 96 },
]

test('tightestOf picks the binding window', () => {
  assert.equal(T.tightestOf(WINDOWS).kind, 'weekly')
  assert.equal(T.tightestOf([]), null)
  assert.equal(T.tightestOf([{ kind: 'session', remainingPercent: null }]), null)
  const tied = [{ kind: 'session', remainingPercent: 50 }, { kind: 'weekly', remainingPercent: 50 }]
  assert.equal(T.tightestOf(tied).kind, 'session')
})

test('normalizeSelection keeps known kinds in display order and defaults to 5h', () => {
  assert.equal(T.normalizeSelection(['monthly', 'session']).join(','), 'session,monthly')
  assert.equal(T.normalizeSelection(['nope', 'weekly']).join(','), 'weekly')
  assert.equal(T.normalizeSelection([]).join(','), 'session')
  assert.equal(T.normalizeSelection(null).join(','), 'session')
})

test('displaySegments renders exactly the selected windows', () => {
  assert.equal(T.displaySegments(WINDOWS, ['session']).map((w) => w.kind).join(','), 'session')
  assert.equal(T.displaySegments(WINDOWS, ['session', 'weekly']).map((w) => w.kind).join(','), 'session,weekly')
  assert.equal(T.displaySegments(WINDOWS, ['monthly']).map((w) => w.kind).join(','), 'monthly')
  assert.equal(T.displaySegments([], ['session']).length, 0)
  // An empty selection falls back to the documented default rather than an empty badge.
  assert.equal(T.displaySegments(WINDOWS, []).map((w) => w.kind).join(','), 'session')
})

test('hiddenTighter reports a hidden window that is tighter than every shown one', () => {
  const shown = [{ kind: 'session', remainingPercent: 95 }]
  assert.equal(T.hiddenTighter(WINDOWS, shown).kind, 'weekly')
  assert.equal(T.hiddenTighter(WINDOWS, [
    { kind: 'session', remainingPercent: 82 },
    { kind: 'weekly', remainingPercent: 45 },
  ]), null)
  assert.equal(T.hiddenTighter([], shown), null)
  const equal = [
    { kind: 'weekly', remainingPercent: 45 },
    { kind: 'session', remainingPercent: 45 },
  ]
  assert.equal(T.hiddenTighter(equal, [{ kind: 'session', remainingPercent: 45 }]), null)
})

test('toneOf uses green above 20%, yellow for 6-20%, red at 5% and below', () => {
  assert.equal(T.toneOf(100), '#30a46c')
  assert.equal(T.toneOf(21), '#30a46c')
  assert.equal(T.toneOf(20), '#f5a524')
  assert.equal(T.toneOf(6), '#f5a524')
  assert.equal(T.toneOf(5), '#e5484d')
  assert.equal(T.toneOf(0), '#e5484d')
  assert.equal(T.toneOf(null), 'var(--dsw-alias-label-tertiary, #999)')
})

test('segmentText renders the compact badge label', () => {
  assert.equal(T.segmentText(WINDOWS[0]), '5h 82%')
  assert.equal(T.segmentText({ kind: 'weekly', remainingPercent: null }), null)
  assert.equal(T.segmentText(null), null)
})

test('fmtClock renders local HH:MM and rejects junk', () => {
  assert.equal(T.fmtClock('nope'), null)
  assert.equal(T.fmtClock(null), null)
  assert.match(T.fmtClock(Date.now()), /^\d{2}:\d{2}$/)
})

/** Minimal stand-in for the client Session list service. */
function fakeSessions(byId, phase = 'ready') {
  return { list: { getSnapshot: () => ({ phase, byId }) } }
}

const MAIN_ROW = {
  id: 'session-main',
  retainedBy: { mainView: 1 },
  projectionValues: {
    modelSelection: {
      lastUsed: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
      next: { provider: 'deepseek-account', model: 'deepseek-flash' },
    },
  },
}

test('readModelSource follows the main-view session and prefers the wire next selection', () => {
  const source = T.readModelSource(fakeSessions({ 'session-main': MAIN_ROW }))
  assert.equal(source.status, 'ready')
  assert.equal(source.provider, 'deepseek-account')
  assert.equal(source.model, 'deepseek-flash')
  assert.equal(source.sessionId, 'session-main')
})

test('readModelSource falls back to lastUsed and waits while the list is pending', () => {
  const row = {
    id: 's1',
    retainedBy: { mainView: 2 },
    projectionValues: { modelSelection: { lastUsed: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, next: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } } },
  }
  assert.equal(T.readModelSource(fakeSessions({ s1: row })).provider, 'opencode-go')
  assert.equal(T.readModelSource(fakeSessions({ s1: row }, 'pending')).status, 'detecting')
  assert.equal(T.readModelSource(fakeSessions({ other: { id: 'other', retainedBy: {} } })).status, 'detecting')
  assert.equal(T.readModelSource(null).status, 'unavailable')
})

test('kindOfProvider maps only the supported provider families', () => {
  assert.equal(T.kindOfProvider('opencode-go'), 'opencode')
  assert.equal(T.kindOfProvider('opencode'), 'unsupported')
  assert.equal(T.kindOfProvider('deepseek-account'), 'deepseek')
  assert.equal(T.kindOfProvider('deepseek'), 'unsupported')
  assert.equal(T.kindOfProvider('deepseek-official'), 'deepseek')
  assert.equal(T.kindOfProvider('zai'), 'unsupported')
  assert.equal(T.kindOfProvider(undefined), 'unsupported')
})

test('fmtMoney renders two decimals with a currency prefix', () => {
  assert.equal(T.fmtMoney(18.236, 'CNY'), '¥18.24')
  assert.equal(T.fmtMoney(3, 'USD'), '$3.00')
  assert.equal(T.fmtMoney(0, 'CNY'), '¥0.00')
  assert.equal(T.fmtMoney('nope', 'CNY'), null)
})

test('kindOfModel keeps detecting/loading distinct from unsupported', () => {
  assert.equal(T.kindOfModel({ status: 'detecting' }), 'detecting')
  assert.equal(T.kindOfModel({ status: 'ready', provider: 'opencode-go' }), 'opencode')
  assert.equal(T.kindOfModel({ status: 'ready', provider: 'deepseek-account' }), 'deepseek')
  assert.equal(T.kindOfModel({ status: 'ready', provider: 'zai' }), 'unsupported')
  assert.equal(T.kindOfModel({ status: 'unavailable' }), 'unsupported')
})

/** Minimal stand-in for the official `uiSession` main-view binding. */
function fakeUiSession(selection, sessionId = 'session-main') {
  const face = { getSnapshot: () => selection, subscribe: () => () => {} }
  return {
    current: {
      getSnapshot: () => ({ key: sessionId, keyedHooks: { projection: (key) => (key === 'modelSelection' ? face : null) } }),
      subscribe: () => () => {},
    },
  }
}

test('readUiModelSource reads the main-view binding projection', () => {
  const ui = fakeUiSession({
    lastUsed: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    next: { provider: 'deepseek-account', model: 'deepseek-flash' },
  })
  const source = T.readUiModelSource(ui)
  assert.equal(source.status, 'ready')
  assert.equal(source.provider, 'deepseek-account')
  assert.equal(source.model, 'deepseek-flash')
  assert.equal(source.sessionId, 'session-main')
  assert.ok(source.face !== null && typeof source.face.subscribe === 'function')
})

test('readUiModelSource handles absent sessions and missing projections', () => {
  assert.equal(T.readUiModelSource(null), null)
  const absent = { current: { getSnapshot: () => ({ key: undefined, keyedHooks: {} }), subscribe: () => () => {} } }
  assert.equal(T.readUiModelSource(absent).status, 'detecting')
  const noSelection = fakeUiSession(undefined)
  assert.equal(T.readUiModelSource(noSelection).status, 'detecting')
})

test('detectModelSource prefers uiSession and falls back to the session list', () => {
  const ui = fakeUiSession({ lastUsed: { provider: 'deepseek-account', model: 'deepseek-flash' }, next: { provider: 'deepseek-account', model: 'deepseek-flash' } })
  const sessions = fakeSessions({
    'session-main': { id: 'session-main', retainedBy: { mainView: 1 }, projectionValues: { modelSelection: { lastUsed: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } } } },
  })
  assert.equal(T.detectModelSource(ui, sessions).provider, 'deepseek-account')
  assert.equal(T.detectModelSource(null, sessions).provider, 'opencode-go')
  assert.equal(T.detectModelSource(null, null).status, 'unavailable')
})


test('selectionOf prefers the wire next over lastUsed and pending', () => {
  assert.equal(T.selectionOf({
    lastUsed: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    next: { provider: 'deepseek-account', model: 'deepseek-flash' },
  }).provider, 'deepseek-account')
  // Older hosts exposed the pending choice directly.
  assert.equal(T.selectionOf({ pending: { provider: 'deepseek-account', model: 'deepseek-flash' } }).provider, 'deepseek-account')
  assert.equal(T.selectionOf({ lastUsed: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } }).provider, 'opencode-go')
  assert.equal(T.selectionOf({ lastUsed: null, next: null }), null)
  assert.equal(T.selectionOf(null), null)
})

function refreshFixture() {
  let state
  const pending = []
  const controller = T.createRefreshController(url => new Promise((resolve, reject) => {
    pending.push({ url, reject, reply: body => resolve({ ok: true, json: async () => body }) })
  }), (next) => { state = typeof next === 'function' ? next(state) : next })
  return { controller, pending, get state() { return state } }
}

test('only the latest selection may publish data, errors, or refreshing status', async () => {
  const f = refreshFixture()
  const sources = ['opencode-go', 'deepseek-account', 'opencode-go', 'deepseek-official']
  const tasks = sources.map(provider => { f.controller.select(provider); return f.controller.refresh(true) })
  assert.deepEqual(f.pending.map(p => p.url), [
    '/dsh-opencode-go-usage-badge/api?refresh=1', '/dsh-opencode-go-usage-badge/deepseek/account?refresh=1',
    '/dsh-opencode-go-usage-badge/api?refresh=1', '/dsh-opencode-go-usage-badge/deepseek/api-key?refresh=1',
  ])
  f.pending[1].reject(new Error('late account error'))
  await tasks[1]
  assert.equal(f.state.refreshing, true)
  f.pending[3].reply({ ok: true, source: 'api-key', totalBalance: 12, fetchedAt: 500 })
  await tasks[3]
  const settled = f.state
  for (const i of [2, 0]) { f.pending[i].reply({ ok: true, windows: [] }); await tasks[i] }
  assert.equal(f.state, settled)
  assert.equal(f.state.payload.totalBalance, 12)
  f.controller.select('opencode')
  await f.controller.refresh(true)
  assert.equal(f.state.payload, null)
  assert.equal(f.pending.length, 4)
})

test('two overlapping refreshes of the same source keep the latest result', async () => {
  const f = refreshFixture()
  f.controller.select('deepseek-account')
  const slow = f.controller.refresh(true)
  const fast = f.controller.refresh(true)
  f.pending[1].reply({ ok: true, totalBalance: 88, fetchedAt: 200 })
  await fast
  f.pending[0].reply({ ok: true, totalBalance: 55, fetchedAt: 100 })
  await slow
  assert.equal(f.state.payload.totalBalance, 88)
  assert.equal(f.state.fetchedAt, 200)
})

test('outages preserve only the same source’s successful data and timestamp until access is lost', async () => {
  const f = refreshFixture()
  f.controller.select('deepseek-account')
  async function refresh(body) {
    const result = f.controller.refresh(true)
    f.pending.at(-1).reply(body)
    await result
  }
  await refresh({ ok: true, totalBalance: 88, fetchedAt: 100 })
  const failure = { ok: false, reason: 'upstream', message: 'offline', fetchedAt: 200 }
  for (let i = 0; i < 2; i++) {
    await refresh(failure)
    assert.equal(f.state.ok, false)
    assert.equal(f.state.payload.totalBalance, 88)
    assert.equal(f.state.fetchedAt, 100)
  }
  f.controller.select('deepseek-official')
  await refresh(failure)
  assert.equal(f.state.payload, null)
  f.controller.select('deepseek-account')
  await refresh({ ok: false, reason: 'signed-out', message: 'signed out' })
  await refresh(failure)
  assert.equal(f.state.payload, null)
  assert.equal(f.state.fetchedAt, null)
  await refresh({ ok: true, totalBalance: 15, fetchedAt: 300 })
  assert.equal(f.state.payload.totalBalance, 15)
  assert.equal(f.state.message, null)
})


test('quotaTextTone colors only low quotas, keeping normal numbers plain', () => {
  assert.equal(T.quotaTextTone(100), null)
  assert.equal(T.quotaTextTone(21), null)
  assert.equal(T.quotaTextTone(20), '#f5a524')
  assert.equal(T.quotaTextTone(6), '#f5a524')
  assert.equal(T.quotaTextTone(5), '#e5484d')
  assert.equal(T.quotaTextTone(0), '#e5484d')
  assert.equal(T.quotaTextTone(null), null)
})


test('Panel renders the DeepSeek balance card without a ReferenceError', () => {
  const state = {
    status: 'ready',
    ok: true,
    payload: { ok: true, source: 'account', currency: 'CNY', totalBalance: 40.15, rechargeBalance: 40.15, bonusBalance: 0 },
    fetchedAt: Date.now(),
    message: null,
    refreshing: false,
  }
  const model = { status: 'ready', provider: 'deepseek-account', model: 'deepseek-flash' }
  assert.doesNotThrow(() => T.Panel({
    kind: 'deepseek',
    state,
    model,
    anchor: { left: 0, bottom: 0 },
    refreshing: false,
    selection: [],
    onToggle: () => {},
    onRefresh: () => {},
  }))
})

test('Panel renders the OpenCode quota card', () => {
  const state = {
    status: 'ready',
    ok: true,
    payload: { windows: WINDOWS },
    fetchedAt: Date.now(),
    message: null,
    refreshing: false,
  }
  const model = { status: 'ready', provider: 'opencode-go', model: 'deepseek-v4.1-flash' }
  assert.doesNotThrow(() => T.Panel({
    kind: 'opencode',
    state,
    model,
    anchor: { left: 0, bottom: 0 },
    refreshing: false,
    selection: ['session', 'weekly'],
    onToggle: () => {},
    onRefresh: () => {},
  }))
})


test('withDefaultSource fills a brand-new conversation with the profile default', () => {
  const detected = { status: 'detecting', sessionId: null, face: null }
  assert.deepStrictEqual({ ...T.withDefaultSource(detected, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }) }, {
    status: 'ready',
    provider: 'opencode-go',
    model: 'deepseek-v4.1-flash',
    sessionId: null,
    face: null,
    fromDefault: true,
  })
  const ready = { status: 'ready', provider: 'deepseek-official', model: 'deepseek-chat' }
  assert.equal(T.withDefaultSource(ready, { provider: 'opencode-go', model: 'x' }), ready)
  assert.equal(T.withDefaultSource(detected, null), detected)
  assert.equal(T.withDefaultSource(detected, { provider: 'opencode-go' }), detected)
})
