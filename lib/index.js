/**
 * dsh-opencode-go-usage-badge — Host half.
 *
 * Two read-only, loopback-only data sources:
 *  1. OpenCode Go subscription usage (5-hour rolling / weekly / monthly windows),
 *     read with the DSH Go API key, or with the OAuth token of an
 *     installed OpenCode Console plugin.
 *  2. DeepSeek official balance, from the API key for an API-key conversation, or
 *     from the DSH account sign-in service (`deepseekAccount`) — the same
 *     service the "账号与余额" settings card uses.
 *
 * The browser half decides which source matches the current conversation's
 * model provider and calls the matching route. Keys and account tokens never
 * reach the page and are never written anywhere.
 *
 * Credential references and optional services are resolved as plain strings /
 * `ctx.get()` so this module deliberately avoids importing any `@deepseek-ai/*`
 * package: a `link:`-based profile install resolves modules from this package's
 * own directory, where the harness packages are not reachable.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Stable Cordis plugin name. */
export const name = 'dsh-opencode-go-usage-badge'

/** Services required before this plugin activates. */
export const inject = ['webServer', 'credentials']

/** Go usage endpoints, current path first and the legacy migration path second. */
const USAGE_URLS = [
  'https://opencode.ai/inference/go/v1/usage',
  'https://opencode.ai/zen/go/v1/usage',
]

/** Dedicated credential used by the Go provider. */
const GO_KEY_REF = 'OPENCODE_GO_API_KEY'

/** OpenCode Console's OAuth credential, when its DSH plugin is installed. */
const CONSOLE_TOKEN_REF = 'OPENCODE_CONSOLE_TOKEN'

/** Console credential file (the fallback when DSH has no Go API key). */
const CONSOLE_DATA_DIR = 'opencode-console'
const CONSOLE_CREDENTIAL_FILE = 'credential.json'

/** DeepSeek official balance endpoint (API-key route). */
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'

/** Credential reference used by DSH for the DeepSeek official API. */
const DEEPSEEK_KEY_REF = 'DEEPSEEK_API_KEY'

/** Same-origin routes the client half polls. */
const USAGE_PATH = '/dsh-opencode-go-usage-badge/api'
const BALANCE_PATH = '/dsh-opencode-go-usage-badge/deepseek'

/** How long a successful upstream answer is reused. */
const CACHE_MS = 30_000

/** Upstream request timeout. */
const TIMEOUT_MS = 12_000

/** Identifies this plugin to upstream endpoints. */
const USER_AGENT = 'dsh-opencode-go-usage-badge/0.4.4'

/**
 * Window mapping: `source` is the key in the upstream payload (`rolling` is the
 * 5-hour window), `kind` is the stable name the client renders, `tag` is the
 * compact label shown in the collapsed badge.
 */
const WINDOWS = [
  { source: 'rolling', kind: 'session', tag: '5h' },
  { source: 'weekly', kind: 'weekly', tag: '1w' },
  { source: 'monthly', kind: 'monthly', tag: '1m' },
]

/** True for loopback peers only (IPv4, IPv6, and IPv4-mapped IPv6). */
function isLoopback(address) {
  if (typeof address !== 'string' || address.length === 0) return false
  const value = address.startsWith('::ffff:') ? address.slice(7) : address
  return value === '::1' || value === '127.0.0.1' || value.startsWith('127.')
}

/** Normalize one upstream window into the shape the client renders. */
function normalizeWindow(kind, tag, raw) {
  if (raw === null || typeof raw !== 'object') return null
  const used = typeof raw.percent === 'number' && Number.isFinite(raw.percent)
    ? Math.min(100, Math.max(0, raw.percent))
    : null
  const status = typeof raw.status === 'string' ? raw.status : null
  const resetsAt = typeof raw.resetsAt === 'string' ? raw.resetsAt : null
  return {
    kind,
    tag,
    usedPercent: used,
    remainingPercent: used === null ? null : Math.round((100 - used) * 10) / 10,
    resetsAt,
    status,
  }
}

/** Map the upstream body into the client payload, keeping unknown kinds out. */
function normalizeUsage(body) {
  const usage = body !== null && typeof body === 'object' && body.usage !== null && typeof body.usage === 'object'
    ? body.usage
    : body
  const windows = []
  if (usage !== null && typeof usage === 'object') {
    for (const entry of WINDOWS) {
      const window = normalizeWindow(entry.kind, entry.tag, usage[entry.source])
      if (window !== null) windows.push(window)
    }
  }
  return windows
}

/** Tokens are HTTP header values: reject empty or control-character input. */
function usableToken(value) {
  if (typeof value !== 'string') return null
  const token = value.trim()
  return /^[\x21-\x7e]+$/.test(token) ? token : null
}

/** Read only the credential owned by the selected provider. */
async function resolveKey(ctx, ref) {
  const hit = await ctx.get('credentials')?.resolve(ref)
  const value = typeof hit === 'string' ? hit : hit?.value
  return usableToken(value)
}

/** Where OpenCode Console stores its per-user data on this platform. */
function consoleDataDir(env = process.env, home = homedir()) {
  const xdg = typeof env.XDG_DATA_HOME === 'string' ? env.XDG_DATA_HOME.trim() : ''
  return xdg !== '' ? xdg : join(home, '.local', 'share')
}

/** Path of the Console credential file; XDG_DATA_HOME wins on every platform. */
function consoleCredentialPath(env = process.env, home = homedir()) {
  return join(consoleDataDir(env, home), CONSOLE_DATA_DIR, CONSOLE_CREDENTIAL_FILE)
}

/** Pick the usable secret out of Console's credential JSON. */
function tokenFromConsoleCredential(value) {
  if (value === null || typeof value !== 'object') return null
  if (value.credential !== null && typeof value.credential === 'object') {
    return tokenFromConsoleCredential(value.credential)
  }
  if (value.type === 'oauth' && typeof value.access === 'string') {
    const token = value.access.trim()
    return token === '' ? null : token
  }
  if (value.type === 'key' && typeof value.key === 'string') {
    const token = value.key.trim()
    return token === '' ? null : token
  }
  return null
}

/** Read the Console OAuth/key token, tolerating a missing or unreadable file. */
async function readConsoleToken(options = {}) {
  const { env = process.env, home = homedir(), read = readFile } = options
  try {
    const parsed = JSON.parse(await read(consoleCredentialPath(env, home), 'utf8'))
    return usableToken(tokenFromConsoleCredential(parsed))
  } catch {
    return null
  }
}

/** Prefer the DSH Go key, then a Console credential, then its local file. */
async function resolveUsageKey(ctx) {
  let stored = null
  try {
    stored = await resolveKey(ctx, GO_KEY_REF)
  } catch {
    stored = null
  }
  if (stored !== null) return stored
  let consoleToken = null
  try {
    consoleToken = await resolveKey(ctx, CONSOLE_TOKEN_REF)
  } catch {
    consoleToken = null
  }
  if (consoleToken !== null) return consoleToken
  return await readConsoleToken()
}

/** Ask the Go usage endpoint; legacy path is only tried when the current one is absent. */
async function fetchUsage(key) {
  for (const [index, url] of USAGE_URLS.entries()) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'User-Agent': USER_AGENT },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (index === 0 && (response.status === 404 || response.status === 405)) continue
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'credential', message: `OpenCode Go 拒绝了此凭据（HTTP ${response.status}）；若使用 OpenCode Console，请重新登录后刷新。` }
    }
    if (!response.ok) throw new Error(`OpenCode Go 额度请求失败（HTTP ${response.status}）`)
    const windows = normalizeUsage(await response.json())
    if (!windows.some((window) => window.remainingPercent !== null)) throw new Error('OpenCode Go 未返回可用的额度窗口。')
    return { ok: true, windows }
  }
  return { ok: false, reason: 'upstream', message: 'OpenCode Go 未返回可用的额度窗口。' }
}

/** A successful answer belongs to this activation, route, and credential. */
function cachedCollector(collect) {
  let cached = null
  let latest = 0
  const clear = () => {
    latest++
    cached = null
  }
  const read = async (force, identity) => {
    if (cached && cached.identity !== identity) clear()
    if (!force && cached && Date.now() - cached.payload.fetchedAt < CACHE_MS) return cached.payload
    const request = ++latest
    let answer
    try {
      answer = await collect(identity)
    } catch (error) {
      answer = { ok: false, reason: 'upstream', message: errorText(error) }
    }
    const payload = { ...answer, fetchedAt: Date.now() }
    if (request === latest) cached = payload.ok ? { identity, payload } : null
    return payload
  }
  return { read, clear }
}

/** Get the current key before consulting the route cache (including after logout). */
function keyedRoute(ctx, ref, cached, guidance, resolve = null) {
  return guardedRoute(async (force) => {
    let key
    try {
      key = resolve === null ? await resolveKey(ctx, ref) : await resolve(ctx)
    } catch {
      cached.clear()
      return { ok: false, reason: 'credential', message: guidance }
    }
    if (key !== null) return cached.read(force, key)
    cached.clear()
    return { ok: false, reason: 'no-key', message: guidance }
  })
}

/** Human-readable message from an unknown thrown value. */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Finite number from a wallet amount, or null. */
function amountOf(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/** Round money for transport; display keeps two decimals. */
function round6(value) {
  return Math.round(value * 1e6) / 1e6
}

/** Pick the wallet worth reporting: CNY first, then any funded wallet, then the first. */
function pickWallet(wallets) {
  const list = Array.isArray(wallets) ? wallets : []
  const usable = list.filter((wallet) => wallet !== null && typeof wallet === 'object' && amountOf(wallet.balance) !== null)
  return usable.find((wallet) => wallet.currency === 'CNY')
    ?? usable.find((wallet) => amountOf(wallet.balance) > 0)
    ?? usable[0]
    ?? null
}

/** DeepSeek balance through the official API key. */
async function fetchDeepSeekKeyBalance(key) {
  const response = await fetch(DEEPSEEK_BALANCE_URL, {
    method: 'GET',
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: 'credential', message: `DeepSeek 拒绝了这个 API Key（HTTP ${response.status}）。` }
  }
  if (!response.ok) throw new Error(`DeepSeek 余额请求失败（HTTP ${response.status}）`)
  const body = await response.json()
  const infos = body !== null && typeof body === 'object' && Array.isArray(body.balance_infos) ? body.balance_infos : []
  const pick = pickWallet(infos.map((info) => ({
    currency: info?.currency,
    balance: info?.total_balance,
    granted: info?.granted_balance,
    toppedUp: info?.topped_up_balance,
  })))
  if (pick === null) throw new Error('DeepSeek 余额响应里没有可用钱包')
  return {
    ok: true,
    source: 'api-key',
    currency: typeof pick.currency === 'string' ? pick.currency : 'CNY',
    totalBalance: amountOf(pick.balance) ?? 0,
    rechargeBalance: amountOf(pick.toppedUp),
    bonusBalance: amountOf(pick.granted),
  }
}

/**
 * DeepSeek balance through the DSH account sign-in service. The
 * `deepseekAccount` service is optional on purpose: an older host without it
 * must not stop this plugin from activating.
 */
async function fetchDeepSeekAccountBalance(ctx) {
  const account = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : null
  if (typeof account?.getBalance !== 'function') {
    return { ok: false, reason: 'no-account-service', message: '当前 DSH 未提供 DeepSeek 登录账号服务。' }
  }
  const result = await account.getBalance({
    version: String(process.env.DSH_CLIENT_VERSION || process.env.DSH_VERSION || '') || 'unknown',
    locale: String(process.env.DSH_LOCALE || '') || 'zh_CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  })
  if (result === null || result === void 0) {
    return { ok: false, reason: 'signed-out', message: 'DSH 未登录 DeepSeek 账号；如需使用余额显示，请在 设置 → 账号与余额 登录后刷新。' }
  }
  if (result.status === 'failed') {
    return { ok: false, reason: 'upstream', message: 'DeepSeek 账号余额查询失败（网络或平台问题），稍后重试。' }
  }
  if (result.status !== 'ready') {
    return { ok: false, reason: 'upstream', message: `DeepSeek 账号余额暂不可用（${String(result.status)}）。` }
  }
  const normal = (Array.isArray(result.value) ? result.value : [])
    .filter((wallet) => wallet !== null && typeof wallet === 'object' && amountOf(wallet.balance) !== null)
  const bonus = (Array.isArray(result.bonusWallets) ? result.bonusWallets : [])
    .filter((wallet) => wallet !== null && typeof wallet === 'object' && amountOf(wallet.balance) !== null)
  const all = normal.concat(bonus)
  if (all.length === 0) {
    return { ok: false, reason: 'no-wallet', message: 'DeepSeek 账号没有可用的余额钱包。' }
  }
  const currencyOf = (wallet) => (typeof wallet.currency === 'string' && wallet.currency.length > 0 ? wallet.currency : 'CNY')
  const currency = currencyOf(pickWallet(all) ?? all[0])
  const sumOf = (wallets) => wallets
    .filter((wallet) => currencyOf(wallet) === currency)
    .reduce((total, wallet) => total + (amountOf(wallet.balance) ?? 0), 0)
  const recharge = sumOf(normal)
  const bonusSum = sumOf(bonus)
  return {
    ok: true,
    source: 'account',
    currency,
    totalBalance: round6(recharge + bonusSum),
    rechargeBalance: round6(recharge),
    bonusBalance: round6(bonusSum),
  }
}

/**
 * Wrap a collector in the shared route guard: loopback only, GET/HEAD only.
 * @param handler - builds the JSON payload for one request.
 * @returns a Node request handler.
 */
function guardedRoute(handler) {
  return async (req, res) => {
    const remote = req.socket?.remoteAddress ?? ''
    if (!isLoopback(remote)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, reason: 'forbidden', message: 'loopback only' }))
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'GET, HEAD' })
      res.end(JSON.stringify({ ok: false, reason: 'method', message: 'GET or HEAD only' }))
      return
    }
    let force = false
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      force = url.searchParams.get('refresh') === '1'
    } catch { /* keep the cached answer */ }
    try {
      const payload = await handler(force)
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(payload))
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, reason: 'internal', message: '额度服务暂时无法读取数据。' }))
    }
  }
}

/** Pure helpers exposed for the host-side tests. */
export const __test = { consoleCredentialPath, tokenFromConsoleCredential, usableToken }

/**
 * Mount the plugin: provider-specific loopback routes.
 * @param ctx - Cordis context carrying the services listed in {@link inject}.
 */
export function apply(ctx) {
  if (ctx.webServer === void 0 || typeof ctx.webServer.register !== 'function') {
    ctx.logger?.warn?.(`[${name}] webServer is unavailable; the badge has no data source`)
    return
  }
  const usage = cachedCollector(fetchUsage)
  const apiKey = cachedCollector(fetchDeepSeekKeyBalance)
  const account = cachedCollector(() => fetchDeepSeekAccountBalance(ctx))
  ctx.effect(() => ctx.on?.('deepseek-account/signed-out', account.clear), `${name}: signed-out cache`)

  const register = (path, handler) => ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path, handler,
  }), `${name}: ${path}`)
  register(USAGE_PATH, keyedRoute(ctx, GO_KEY_REF, usage, '请在 DSH 中配置 OPENCODE_GO_API_KEY，或登录 OpenCode Console。', resolveUsageKey))
  register(`${BALANCE_PATH}/account`, guardedRoute((force) => account.read(force)))
  register(`${BALANCE_PATH}/api-key`, keyedRoute(ctx, DEEPSEEK_KEY_REF, apiKey, '请在 DSH 模型设置中配置 DEEPSEEK_API_KEY。'))
}
