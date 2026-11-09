// Host-half tests: the three loopback routes are exercised with a fake Cordis
// context, so credential resolution, provider payload normalization, caching and
// the route guard are verified without a running Harness.
import assert from 'node:assert/strict'
import test from 'node:test'

const USAGE_PATH = '/dsh-opencode-go-usage-badge/api'
const ACCOUNT_PATH = '/dsh-opencode-go-usage-badge/deepseek/account'
const KEY_PATH = '/dsh-opencode-go-usage-badge/deepseek/api-key'

/** Fresh module instance per test, so module-level caches do not leak. */
let instance = 0
async function loadHost() {
  instance += 1
  return import(`../lib/index.js?test=${instance}`)
}

function makeCtx({ credentials, account } = {}) {
  const routes = new Map()
  const ctx = {
    webServer: {
      register(options) {
        routes.set(options.path, options.handler)
        return () => {}
      },
    },
    credentials: credentials ?? { resolve: async () => undefined },
    get(name) {
      if (name === 'credentials') return this.credentials
      if (name === 'deepseekAccount') return account
      return undefined
    },
    effect(run) { return run() },
    logger: { info() {}, warn() {} },
  }
  return { ctx, routes }
}

function makeRequest({ method = 'GET', url = '/', remote = '127.0.0.1' }) {
  return { method, url, socket: { remoteAddress: remote } }
}

function makeResponse() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers },
    end(chunk) { this.body = chunk ?? '' },
  }
}

async function callRoute(routes, path, { request, ...rest } = {}) {
  const handler = routes.get(path)
  assert.ok(handler !== undefined, `route ${path} must be registered`)
  const response = makeResponse()
  await handler(makeRequest({ url: path, ...rest, ...request }), response)
  return { response, body: response.body === '' ? null : JSON.parse(response.body) }
}

test('only the three read-only data routes are registered', async () => {
  const host = await loadHost()
  const { ctx, routes } = makeCtx()
  host.apply(ctx)
  assert.deepEqual([...routes.keys()].sort(), [USAGE_PATH, ACCOUNT_PATH, KEY_PATH].sort())
})

test('OpenCode route reports the three remaining windows', async () => {
  const host = await loadHost()
  const { ctx, routes } = makeCtx({
    credentials: {
      async resolve(ref) {
        return ref === 'OPENCODE_GO_API_KEY' ? 'test-opencode-key' : undefined
      },
    },
  })
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return {
      status: 200,
      ok: true,
      json: async () => ({
        usage: {
          rolling: { percent: 2, resetsAt: '2026-11-09T05:42:15.000Z' },
          weekly: { percent: 5 },
          monthly: { percent: 1 },
        },
      }),
    }
  }
  try {
    host.apply(ctx)
    const { response, body } = await callRoute(routes, USAGE_PATH)
    assert.equal(response.statusCode, 200)
    assert.equal(body.ok, true)
    assert.deepEqual(body.windows.map((window) => [window.kind, window.remainingPercent]), [
      ['session', 98],
      ['weekly', 95],
      ['monthly', 99],
    ])
    // A second call within the cache window reuses the answer.
    const again = await callRoute(routes, USAGE_PATH)
    assert.equal(again.body.fetchedAt, body.fetchedAt)
    assert.equal(calls, 1)
    // The explicit refresh flag bypasses that cache.
    await callRoute(routes, USAGE_PATH, { request: { url: `${USAGE_PATH}?refresh=1` } })
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('DeepSeek account route adds wallets within the selected currency', async () => {
  const host = await loadHost()
  const { ctx, routes } = makeCtx({
    credentials: { resolve: async () => undefined },
    account: {
      async getBalance() {
        return {
          status: 'ready',
          value: [{ currency: 'CNY', balance: '86.000000' }],
          bonusWallets: [{ currency: 'CNY', balance: '2.000000' }],
        }
      },
    },
  })
  host.apply(ctx)
  const { response, body } = await callRoute(routes, ACCOUNT_PATH)
  assert.equal(response.statusCode, 200)
  assert.equal(body.ok, true)
  assert.equal(body.source, 'account')
  assert.equal(body.currency, 'CNY')
  assert.equal(body.totalBalance, 88)
  assert.equal(body.rechargeBalance, 86.000000)
  assert.equal(body.bonusBalance, 2)
})

test('DeepSeek API-key route uses only its own credential', async () => {
  const host = await loadHost()
  const { ctx, routes } = makeCtx({
    credentials: {
      async resolve(ref) {
        return ref === 'DEEPSEEK_API_KEY' ? 'test-deepseek-key' : undefined
      },
    },
    account: {
      async getBalance() {
        throw new Error('account path must not run while an API key is configured')
      },
    },
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'https://api.deepseek.com/user/balance')
    return {
      status: 200,
      ok: true,
      json: async () => ({
        balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '2.00', topped_up_balance: '10.34' }],
      }),
    }
  }
  try {
    host.apply(ctx)
    const { body } = await callRoute(routes, KEY_PATH)
    assert.equal(body.ok, true)
    assert.equal(body.source, 'api-key')
    assert.equal(body.totalBalance, 12.34)
    assert.equal(body.rechargeBalance, 10.34)
    assert.equal(body.bonusBalance, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Missing API key is reported without querying a signed-in account', async () => {
  const host = await loadHost()
  const { ctx, routes } = makeCtx({ credentials: { resolve: async () => undefined } })
  host.apply(ctx)
  const { body } = await callRoute(routes, KEY_PATH)
  assert.equal(body.ok, false)
  assert.equal(body.reason, 'no-key')
})

test('routes refuse non-loopback peers and non-GET methods', async () => {
  const host = await loadHost()
  const { ctx, routes } = makeCtx()
  host.apply(ctx)
  const remote = await callRoute(routes, KEY_PATH, { request: { remote: '192.168.1.9' } })
  assert.equal(remote.response.statusCode, 403)
  const method = await callRoute(routes, USAGE_PATH, { request: { method: 'POST' } })
  assert.equal(method.response.statusCode, 405)
})

test('account and key keep separate caches when both wallets are configured', async (t) => {
  let accountBalance = 88
  let key = 'fixture-key'
  let keyBalance = 12
  let accountCalls = 0
  let keyCalls = 0
  let signedOut
  const { ctx, routes } = makeCtx({
    credentials: { resolve: async (ref) => ref === 'DEEPSEEK_API_KEY' ? key : undefined },
    account: { async getBalance() {
      accountCalls++
      return accountBalance === null ? null : { status: 'ready', value: [{ currency: 'CNY', balance: accountBalance }] }
    } },
  })
  ctx.on = (event, listener) => { assert.equal(event, 'deepseek-account/signed-out'); signedOut = listener }
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    keyCalls++
    assert.equal(options.headers.Authorization, `Bearer ${key}`)
    return { ok: true, json: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: keyBalance }] }) }
  })
  const host = await loadHost()
  host.apply(ctx)
  for (const path of [ACCOUNT_PATH, KEY_PATH, ACCOUNT_PATH, KEY_PATH]) {
    const { body } = await callRoute(routes, path)
    assert.equal(body.totalBalance, path === ACCOUNT_PATH ? 88 : 12)
  }
  assert.deepEqual([accountCalls, keyCalls], [1, 1])
  key = 'new-fixture'
  keyBalance = 7
  assert.equal((await callRoute(routes, KEY_PATH)).body.totalBalance, 7)
  key = null
  assert.equal((await callRoute(routes, KEY_PATH)).body.reason, 'no-key')
  accountBalance = null
  signedOut()
  assert.equal((await callRoute(routes, ACCOUNT_PATH)).body.reason, 'signed-out')
  assert.deepEqual([accountCalls, keyCalls], [2, 2])
})

test('generic OpenCode credentials never authorize a Go lookup', async () => {
  const refs = []
  const { ctx, routes } = makeCtx({ credentials: { resolve: async (ref) => {
    refs.push(ref)
    return ref === 'OPENCODE_API_KEY' ? 'unrelated-key' : undefined
  } } })
  const host = await loadHost()
  host.apply(ctx)
  assert.equal((await callRoute(routes, USAGE_PATH)).body.reason, 'no-key')
  assert.deepEqual(refs, ['OPENCODE_GO_API_KEY'])
})

test('late host responses cannot replace a newer cached balance', async () => {
  const pending = []
  const { ctx, routes } = makeCtx({ account: { getBalance: () => new Promise(resolve => pending.push(resolve)) } })
  const host = await loadHost()
  host.apply(ctx)
  const first = callRoute(routes, ACCOUNT_PATH)
  const second = callRoute(routes, ACCOUNT_PATH, { request: { url: ACCOUNT_PATH + '?refresh=1' } })
  const wallet = amount => ({ status: 'ready', value: [{ currency: 'CNY', balance: amount }] })
  pending[1](wallet(20))
  await second
  pending[0](wallet(10))
  await first
  assert.equal((await callRoute(routes, ACCOUNT_PATH)).body.totalBalance, 20)
})

test('credential service errors do not disclose private details to the page', async () => {
  const { ctx, routes } = makeCtx({ credentials: { resolve: async () => { throw new Error('fixture-private-detail') } } })
  const host = await loadHost()
  host.apply(ctx)
  const { body } = await callRoute(routes, KEY_PATH)
  assert.equal(body.reason, 'credential')
  assert.doesNotMatch(body.message, /fixture-private-detail/)
})
