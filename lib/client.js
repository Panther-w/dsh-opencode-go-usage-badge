// dsh-opencode-go-usage-badge — Client half
// Bottom-left sidebar badge that follows the *current conversation's* model
// provider: OpenCode Go shows the tightest subscription window (5-hour rolling /
// weekly / monthly), DeepSeek official shows the account balance. The source is
// read from the main-view uiSession (or sessions.list) and its `modelSelection`
// projection, so switching conversations or models re-points the badge.
//
// Refresh: every 60s while the page is visible, and immediately when the app
// regains focus/visibility, on pageshow, and when the network comes back —
// background timers get throttled or frozen, so relying on the interval alone
// leaves last night's numbers on screen after the app wakes up.
window.__ModuleLoader__.load({
  id: 'dsh-opencode-go-usage-badge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    let react = require('react')
    let react_dom = require('react-dom')

    const inject = ['slots']
    const VERSION = '0.4.4'
    const USAGE_API = '/dsh-opencode-go-usage-badge/api'
    const BALANCE_API = '/dsh-opencode-go-usage-badge/deepseek'
    const POLL_MS = 60_000
    /** Data older than this is called out instead of silently shown. */
    const STALE_MS = 5 * 60_000
    /** Collapse repeated wake-up refreshes (mount + focus fire together). */
    const MIN_REFRESH_GAP_MS = 5_000
    const SELECTION_KEY = 'dsh-opencode-go-usage-badge.windows'
    const LEGACY_MODE_KEY = 'dsh-opencode-go-usage-badge.mode'
    const WINDOW_ORDER = ['session', 'weekly', 'monthly']
    const WINDOW_LABELS = { session: '5 小时', weekly: '本周', monthly: '本月' }
    const WINDOW_TAGS = { session: '5h', weekly: '1w', monthly: '1m' }
    const DEFAULT_SELECTION = ['session']
    const routes = new Map([
      ['opencode-go', USAGE_API],
      ['deepseek-account', `${BALANCE_API}/account`],
      ['deepseek-official', `${BALANCE_API}/api-key`],
    ])
    const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$' }
    const BALANCE_TONE = 'var(--dsw-alias-state-business-primary, #4d6bfe)'

    const S = {
      badge: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 8px',
        borderRadius: '8px',
        fontSize: '12px',
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        userSelect: 'none',
        background: 'transparent',
        border: 'none',
        fontFamily: 'inherit',
      },
      dot: {
        width: '6px',
        height: '6px',
        borderRadius: '999px',
        flex: '0 0 auto',
      },
      value: {
        fontVariantNumeric: 'tabular-nums',
        fontWeight: 600,
        color: 'var(--dsw-alias-label-primary)',
      },
      panel: {
        position: 'fixed',
        zIndex: 2147483000,
        minWidth: '260px',
        padding: '10px 12px',
        borderRadius: '12px',
        background: 'var(--dsw-alias-bg-layer-2, #ffffff)',
        color: 'var(--dsw-alias-label-primary, #111)',
        border: '0.5px solid var(--dsw-alias-border-l3, rgba(0,0,0,.12))',
        boxShadow: '0 8px 28px rgba(0,0,0,.18)',
        fontSize: '12px',
        lineHeight: '18px',
      },
      head: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: '8px',
        marginBottom: '6px',
      },
      title: { fontWeight: 600 },
      muted: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px' },
      warning: { color: '#f5a524', fontSize: '11px', marginTop: '4px' },
      modeRow: { display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px' },
      modeButton: {
        padding: '2px 8px',
        borderRadius: '999px',
        border: '0.5px solid var(--dsw-alias-border-l3, rgba(0,0,0,.14))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '11px',
        lineHeight: '16px',
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      modeButtonActive: {
        background: 'var(--dsw-alias-bg-layer-3, rgba(0,0,0,.06))',
        color: 'var(--dsw-alias-label-primary)',
        fontWeight: 600,
      },
      row: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
        padding: '4px 0',
      },
      balanceBig: {
        fontSize: '17px',
        fontWeight: 700,
        fontVariantNumeric: 'tabular-nums',
      },
      line: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', marginTop: '2px' },
      track: {
        position: 'relative',
        height: '4px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-border-l2, rgba(0,0,0,.08))',
        marginTop: '2px',
        overflow: 'hidden',
      },
      fill: { position: 'absolute', inset: '0 auto 0 0', borderRadius: '999px' },
      action: {
        marginTop: '8px',
        width: '100%',
        padding: '5px 8px',
        borderRadius: '8px',
        border: '0.5px solid var(--dsw-alias-border-l3, rgba(0,0,0,.14))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, #111)',
        fontSize: '12px',
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
    }

    /** Quota colors keep the same thresholds as the DSH usage surfaces. */
    function toneOf(remaining) {
      if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return 'var(--dsw-alias-label-tertiary, #999)'
      if (remaining <= 5) return '#e5484d'
      if (remaining <= 20) return '#f5a524'
      return '#30a46c'
    }

    /** Text color for a quota number: only low quotas are colored; normal stays the theme text. */
    function quotaTextTone(remaining) {
      if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return null
      return remaining <= 20 ? toneOf(remaining) : null
    }

    /** Short human duration for a reset timestamp; null when unusable. */
    function fmtReset(iso) {
      if (typeof iso !== 'string' || iso.length === 0) return null
      const target = new Date(iso).getTime()
      if (!Number.isFinite(target)) return null
      const diff = target - Date.now()
      if (diff <= 0) return '即将重置'
      const minutes = Math.round(diff / 60000)
      if (minutes < 60) return `${minutes} 分钟后重置`
      const hours = Math.floor(minutes / 60)
      const restMinutes = minutes % 60
      if (hours < 24) return restMinutes === 0 ? `${hours} 小时后重置` : `${hours} 小时 ${restMinutes} 分后重置`
      const days = Math.floor(hours / 24)
      const restHours = hours % 24
      return restHours === 0 ? `${days} 天后重置` : `${days} 天 ${restHours} 小时后重置`
    }

    /** Local `HH:MM` for a fetch timestamp; null when unusable. */
    function fmtClock(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return null
      const date = new Date(ms)
      if (!Number.isFinite(date.getTime())) return null
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /** Currency-prefixed amount with two decimals; null when unusable. */
    function fmtMoney(value, currency) {
      if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null
      const number = Number(value)
      if (!Number.isFinite(number)) return null
      const amount = number.toFixed(2)
      const code = typeof currency === 'string' && currency.length > 0 ? currency : 'CNY'
      const symbol = CURRENCY_SYMBOLS[code]
      return symbol === void 0 ? `${amount} ${code}` : `${symbol}${amount}`
    }

    /** The window with the least remaining quota; ties keep the shorter one. */
    function tightestOf(windows) {
      let tightest = null
      for (const value of windows) {
        if (value === null || typeof value !== 'object') continue
        if (typeof value.remainingPercent !== 'number') continue
        if (tightest === null || value.remainingPercent < tightest.remainingPercent) tightest = value
      }
      return tightest
    }

    /** Compact `5h 82%` label for one window; null when it cannot be rendered. */
    function segmentText(value) {
      if (value === null || typeof value !== 'object') return null
      if (typeof value.remainingPercent !== 'number') return null
      return `${WINDOW_TAGS[value.kind] ?? value.kind} ${value.remainingPercent}%`
    }

    /** Keep only known window kinds, in display order, with at least one window. */
    function normalizeSelection(value) {
      const list = Array.isArray(value) ? value : []
      const picked = WINDOW_ORDER.filter((kind) => list.includes(kind))
      return picked.length === 0 ? DEFAULT_SELECTION.slice() : picked
    }

    /** The windows rendered in the collapsed badge for the chosen selection. */
    function displaySegments(windows, selection) {
      const list = Array.isArray(windows) ? windows : []
      const kinds = normalizeSelection(selection)
      const picked = []
      for (const kind of kinds) {
        const value = list.find((item) => item !== null && typeof item === 'object'
          && item.kind === kind && typeof item.remainingPercent === 'number')
        if (value !== void 0) picked.push(value)
      }
      if (picked.length > 0) return picked
      const tightest = tightestOf(list)
      return tightest === null ? [] : [tightest]
    }

    /** A hidden window tighter than every shown window, or null. */
    function hiddenTighter(windows, segments) {
      const list = Array.isArray(windows) ? windows : []
      const shown = Array.isArray(segments) ? segments : []
      if (shown.length === 0) return null
      const tightest = tightestOf(list)
      if (tightest === null) return null
      if (shown.some((value) => value !== null && typeof value === 'object' && value.kind === tightest.kind)) return null
      const shownMin = shown.reduce((min, value) => (typeof value.remainingPercent === 'number' ? Math.min(min, value.remainingPercent) : min), Infinity)
      return tightest.remainingPercent < shownMin ? tightest : null
    }

    /** Map a provider id to the data source it needs. */
    function kindOfProvider(provider) {
      if (!routes.has(provider)) return 'unsupported'
      return provider === 'opencode-go' ? 'opencode' : 'deepseek'
    }

    /** Map the current model-source snapshot to the badge's data source. */
    function kindOfModel(source) {
      if (source === null || typeof source !== 'object') return 'detecting'
      if (source.status === 'ready') return kindOfProvider(source.provider)
      if (source.status === 'unavailable') return 'unsupported'
      return 'detecting'
    }

    /**
     * Pick the intended selection from the client-facing wire value.
     * The Host projection state is `{lastUsed, pending}`, but the wire view the
     * Client receives is `{lastUsed, next}` where `next = pending ?? lastUsed`.
     * `lastUsed` only moves after a request is sent, so a model switch that has
     * not run yet is visible only in `next` (older hosts exposed `pending`).
     */
    function selectionOf(selection) {
      if (selection === null || typeof selection !== 'object') return null
      for (const candidate of [selection.next, selection.pending, selection.lastUsed]) {
        if (candidate !== null && candidate !== void 0 && typeof candidate === 'object' && typeof candidate.provider === 'string') {
          return candidate
        }
      }
      return null
    }

    /**
     * Read the model selection of the Conversation the user is looking at.
     * The Session list marks the main-view Session with `retainedBy.mainView`;
     * its `modelSelection` projection holds `pending` (just switched) or
     * `lastUsed` (durable) with `{ provider, model, reasoningEffort }`.
     * @param sessions - client `sessions` service (Session Controller object layer).
     * @returns `{ status: 'ready' | 'detecting' | 'unavailable', ... }`.
     */
    function readModelSource(sessions) {
      if (sessions === null || sessions === void 0 || typeof sessions.list !== 'object' || typeof sessions.list.getSnapshot !== 'function') {
        return { status: 'unavailable' }
      }
      let list = null
      try {
        list = sessions.list.getSnapshot()
      } catch {
        return { status: 'unavailable' }
      }
      if (list === null || typeof list !== 'object' || list.phase !== 'ready') return { status: 'detecting' }
      const byId = list.byId !== null && typeof list.byId === 'object' ? list.byId : {}
      const rows = Object.values(byId)
      const main = rows.find((row) => row !== null && typeof row === 'object'
        && (((row.retainedBy !== null && typeof row.retainedBy === 'object' ? row.retainedBy.mainView : 0) || 0) > 0))
      if (main === void 0) return { status: 'detecting' }
      const values = main.projectionValues !== null && typeof main.projectionValues === 'object' ? main.projectionValues : {}
      const pick = selectionOf(values.modelSelection)
      if (pick === null) return { status: 'detecting' }
      return {
        status: 'ready',
        provider: pick.provider,
        model: typeof pick.model === 'string' ? pick.model : null,
        sessionId: typeof main.id === 'string' ? main.id : null,
      }
    }

    /**
     * Read the current Conversation through the official `uiSession` service:
     * `current` is the same main-view binding the Conversation renders from, and
     * `keyedHooks.projection('modelSelection')` is its reactive projection face.
     * This follows session switches and model changes without waiting for the
     * Session list snapshot. Returns null when the service is unavailable.
     */
    function readUiModelSource(uiSession) {
      if (uiSession === null || uiSession === void 0) return null
      const current = uiSession.current
      if (current === null || typeof current !== 'object' || typeof current.getSnapshot !== 'function') return null
      let value = null
      try {
        value = current.getSnapshot()
      } catch {
        return null
      }
      if (value === null || typeof value !== 'object') return { status: 'detecting', sessionId: null, face: null }
      const sessionId = typeof value.key === 'string' ? value.key : (value.props !== null && typeof value.props === 'object' && typeof value.props.sessionId === 'string' ? value.props.sessionId : null)
      if (sessionId === null) return { status: 'detecting', sessionId: null, face: null }
      let face = null
      try {
        const projection = value.keyedHooks !== null && typeof value.keyedHooks === 'object' ? value.keyedHooks.projection : null
        if (typeof projection === 'function') face = projection('modelSelection')
      } catch {
        face = null
      }
      let selection = null
      try {
        selection = face !== null && typeof face.getSnapshot === 'function' ? face.getSnapshot() : null
      } catch {
        selection = null
      }
      const pick = selectionOf(selection)
      if (pick === null) {
        return { status: 'detecting', sessionId, face }
      }
      return {
        status: 'ready',
        provider: pick.provider,
        model: typeof pick.model === 'string' ? pick.model : null,
        sessionId,
        face,
      }
    }

    /** Best available model source: official main-view binding first, list snapshot as fallback. */
    function detectModelSource(uiSession, sessions) {
      const fromUi = readUiModelSource(uiSession)
      if (fromUi !== null) return fromUi
      return readModelSource(sessions)
    }

    /** One quota row inside the expanded card. */
    function WindowRow({ window: value, label }) {
      const remaining = value.remainingPercent
      const reset = fmtReset(value.resetsAt)
      const filled = typeof remaining === 'number' ? Math.max(0, Math.min(100, remaining)) : 0
      return react.createElement('div', { style: { padding: '4px 0' } },
        react.createElement('div', { style: S.row },
          react.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
            react.createElement('span', { style: { ...S.dot, background: toneOf(remaining) } }),
            react.createElement('span', null, label)),
          react.createElement('span', { style: { fontVariantNumeric: 'tabular-nums', fontWeight: 600, ...(quotaTextTone(remaining) === null ? {} : { color: quotaTextTone(remaining) }) } },
            typeof remaining === 'number' ? `${remaining}% 剩余` : '—')),
        react.createElement('div', { style: S.track },
          react.createElement('div', { style: { ...S.fill, width: `${filled}%`, background: toneOf(remaining) } })),
        reset === null
          ? null
          : react.createElement('div', { style: { ...S.muted, marginTop: '2px' } }, reset))
    }

    /** Expanded card for either data source, portaled so the sidebar cannot clip it. */
    function Panel({ kind, state, model, anchor, refreshing, selection, onToggle, onRefresh }) {
      const payload = state.payload
      const windows = kind === 'opencode' && payload !== null && typeof payload === 'object' && Array.isArray(payload.windows)
        ? payload.windows
        : []
      const tightest = tightestOf(windows)
      const balance = kind === 'deepseek' && payload !== null && typeof payload === 'object' && payload.ok !== false
        ? payload
        : null
      const totalBalance = balance === null ? null : (Number.isFinite(Number(balance.totalBalance)) ? Number(balance.totalBalance) : null)
      const hasValue = kind === 'opencode' ? windows.length > 0 : kind === 'deepseek' ? balance !== null : false
      const fetchedAt = typeof state.fetchedAt === 'number' ? state.fetchedAt : null
      const stale = hasValue && fetchedAt !== null && Date.now() - fetchedAt > STALE_MS
      const titleText = kind === 'deepseek' ? 'DeepSeek' : kind === 'opencode' ? 'OpenCode Go' : '用量与余额'
      const updatedText = state.status === 'loading'
        ? '加载中…'
        : fetchedAt === null
          ? null
          : `更新于 ${fmtClock(fetchedAt) ?? '—'}${stale ? ' · 已过期' : ''}`
      const warning = state.ok !== true
        ? (state.message ?? '暂时拿不到最新数据')
        : stale
          ? `数据超过 ${Math.round(STALE_MS / 60_000)} 分钟未更新`
          : null
      const style = { ...S.panel, left: `${anchor.left}px`, bottom: `${anchor.bottom}px` }
      const sourceLabel = balance === null
        ? null
        : balance.source === 'account'
          ? 'DSH 账号登录'
          : balance.source === 'api-key'
            ? 'DEEPSEEK_API_KEY'
            : null
      let body = null
      if (kind === 'opencode') {
        body = react.createElement(react.Fragment, null,
          react.createElement('div', { style: S.modeRow, role: 'group', 'aria-label': '显示哪些窗口' },
            WINDOW_ORDER.map((kind) => react.createElement('button', {
              key: kind,
              type: 'button',
              style: selection.includes(kind) ? { ...S.modeButton, ...S.modeButtonActive } : S.modeButton,
              'aria-pressed': selection.includes(kind),
              title: WINDOW_LABELS[kind],
              onClick: () => onToggle(kind),
            }, WINDOW_TAGS[kind]))),
          tightest === null
            ? null
            : react.createElement('div', { style: S.muted }, `最紧：${WINDOW_LABELS[tightest.kind] ?? tightest.kind}`),
          windows.length === 0
            ? null
            : react.createElement('div', null, windows.map((value) => react.createElement(WindowRow, {
              key: value.kind ?? String(Math.random()),
              window: value,
              label: WINDOW_LABELS[value.kind] ?? value.kind,
            }))))
      } else if (kind === 'deepseek') {
        body = balance === null
          ? null
          : react.createElement('div', null,
            react.createElement('div', { style: { ...S.row, paddingTop: '2px' } },
              react.createElement('span', null, '余额'),
              react.createElement('span', { style: totalBalance !== null && totalBalance <= 0 ? { ...S.balanceBig, color: '#e5484d' } : S.balanceBig }, fmtMoney(balance.totalBalance, balance.currency) ?? '—')),
            typeof balance.rechargeBalance === 'number'
              ? react.createElement('div', { style: { ...S.row, padding: '2px 0' } },
                react.createElement('span', { style: S.muted }, '充值余额'),
                react.createElement('span', { style: S.muted }, fmtMoney(balance.rechargeBalance, balance.currency) ?? '—'))
              : null,
            typeof balance.bonusBalance === 'number'
              ? react.createElement('div', { style: { ...S.row, padding: '2px 0' } },
                react.createElement('span', { style: S.muted }, '赠金'),
                react.createElement('span', { style: S.muted }, fmtMoney(balance.bonusBalance, balance.currency) ?? '—'))
              : null,
            sourceLabel === null ? null : react.createElement('div', { style: S.line }, `数据来源：${sourceLabel}`),
            model.model === null ? null : react.createElement('div', { style: S.line }, `当前模型：${model.model}`))
      } else {
        body = react.createElement('div', { style: S.muted },
          model.status === 'ready' ? `当前模型 ${model.provider} 暂不支持余额或配额显示。`
            : '暂未识别当前对话的模型来源。')
      }
      return react_dom.createPortal(
        react.createElement('div', { style, role: 'dialog', 'aria-label': '用量与余额', 'data-dsh-opencode-go-usage-badge': '' },
          react.createElement('div', { style: S.head },
            react.createElement('span', { style: S.title }, titleText),
            updatedText === null
              ? null
              : react.createElement('span', { style: stale ? { ...S.muted, color: '#f5a524' } : S.muted }, updatedText)),
          body,
          warning === null ? null : react.createElement('div', { style: S.warning }, warning),
          react.createElement('div', { style: { ...S.muted, marginTop: '4px' } },
            `v${VERSION} · 当前对话：${model.status === 'ready'
              ? `${model.provider}${model.model === null ? '' : ` / ${model.model}`}`
              : model.status === 'detecting' ? '读取中…' : '读取不到'}`),
          react.createElement('button', {
            type: 'button',
            style: S.action,
            disabled: refreshing,
            onClick: onRefresh,
          }, refreshing ? '刷新中…' : '刷新')),
        document.body)
    }

    /** Read the persisted window selection; tolerate unavailable storage. */
    function readSelection() {
      try {
        const raw = localStorage.getItem(SELECTION_KEY)
        if (raw !== null) return normalizeSelection(JSON.parse(raw))
        const legacy = localStorage.getItem(LEGACY_MODE_KEY)
        if (legacy === 'dual') return ['session', 'weekly']
      } catch { /* best effort */ }
      return DEFAULT_SELECTION.slice()
    }

    /** Catches render failures so the slot shows an error instead of disappearing. */
    class BadgeBoundary extends react.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      render() {
        if (this.state.error !== null) {
          const message = String(this.state.error && this.state.error.message ? this.state.error.message : this.state.error)
          return react.createElement('span', {
            style: { fontSize: '11px', color: '#e5484d', padding: '2px 6px' },
            title: message,
          }, `徽标错误 ${VERSION}`)
        }
        return this.props.children
      }
    }

    const EMPTY_STATE = { status: 'ready', ok: false, payload: null, fetchedAt: null, message: null, refreshing: false }

    /** Each selection or refresh supersedes earlier work, including an A → B → A switch. */
    function createRefreshController(request, publish) {
      let provider = null
      let generation = 0
      let lastAttempt = null
      const successes = new Map()

      function select(next) {
        if (provider === next) return
        provider = next
        generation++
        lastAttempt = null
        publish({ ...EMPTY_STATE, status: routes.has(next) ? 'loading' : 'ready' })
      }

      async function refresh(force = false) {
        const route = routes.get(provider)
        if (!route) return
        const now = Date.now()
        if (!force && lastAttempt !== null && now - lastAttempt < MIN_REFRESH_GAP_MS) return
        lastAttempt = now
        const id = ++generation
        publish((state) => ({ ...state, refreshing: true }))
        let body
        try {
          const response = await request(force ? `${route}?refresh=1` : route, { headers: { Accept: 'application/json' } })
          if (!response.ok) throw new Error(`额度服务请求失败（HTTP ${response.status}）。`)
          body = await response.json()
          if (!body || typeof body.ok !== 'boolean') throw new Error('额度服务返回了无法识别的结果。')
        } catch (error) {
          body = { ok: false, reason: 'upstream', message: String(error?.message ?? error) }
        }
        if (id !== generation) return
        if (body.ok) successes.set(provider, body)
        else if (body.reason !== 'upstream') successes.delete(provider)
        const lastGood = successes.get(provider)
        publish({
          status: body.ok ? 'ready' : 'error',
          ok: body.ok,
          payload: lastGood ?? null,
          fetchedAt: lastGood?.fetchedAt ?? null,
          message: body.ok ? null : (body.message ?? '暂时拿不到最新数据'),
          refreshing: false,
        })
      }
      return { select, refresh }
    }

    /** Sidebar badge + popover. */
    function PantherUsageBadge({ getServices }) {
      const [model, setModel] = react.useState({ status: 'detecting' })
      const [state, setState] = react.useState(EMPTY_STATE)
      const [open, setOpen] = react.useState(false)
      const [anchor, setAnchor] = react.useState({ left: 16, bottom: 64 })
      const [selection, setSelection] = react.useState(readSelection)
      const buttonRef = react.useRef(null)
      const lastSignatureRef = react.useRef('')
      const controllerRef = react.useRef(null)
      if (!controllerRef.current) controllerRef.current = createRefreshController(fetch, setState)
      const controller = controllerRef.current
      const kind = kindOfModel(model)

      // Follow the current Conversation. The official uiSession main-view binding
      // is authoritative; the Session list is a fallback. Besides store
      // subscriptions, a 3 s in-memory re-check keeps the source correct even if
      // a store misses a notification.
      react.useEffect(() => {
        let offList = null
        let offCurrent = null
        let offFace = null
        let currentFace = null
        let timer = null
        let disposed = false
        const detachFace = () => {
          if (typeof offFace === 'function') {
            try { offFace() } catch { /* already disposed */ }
          }
          offFace = null
          currentFace = null
        }
        const sync = () => {
          if (disposed) return
          let services = null
          try {
            services = typeof getServices === 'function' ? getServices() : null
          } catch {
            services = null
          }
          const sessions = services !== null && typeof services === 'object' ? services.sessions : null
          const uiSession = services !== null && typeof services === 'object' ? services.uiSession : null
          let source = null
          try {
            source = detectModelSource(uiSession, sessions)
          } catch {
            source = { status: 'detecting' }
          }
          const signature = `${source.status}|${source.provider ?? ''}|${source.model ?? ''}|${source.sessionId ?? ''}`
          if (signature !== lastSignatureRef.current) {
            lastSignatureRef.current = signature
            controller.select(source.status === 'ready' ? source.provider : null)
            setModel(source)
            if (document.visibilityState !== 'hidden') void controller.refresh(true)
          }
          const face = source !== null && typeof source === 'object' && source.face !== void 0 ? source.face : null
          if (face !== currentFace) {
            detachFace()
            if (face !== null && typeof face === 'object' && typeof face.subscribe === 'function') {
              currentFace = face
              try {
                offFace = face.subscribe(sync)
              } catch {
                offFace = null
                currentFace = null
              }
            }
          }
          try {
            if (offList === null && sessions !== null && sessions !== void 0
              && sessions.list !== null && sessions.list !== void 0 && typeof sessions.list.subscribe === 'function') {
              offList = sessions.list.subscribe(sync)
            }
            if (offCurrent === null && uiSession !== null && uiSession !== void 0
              && uiSession.current !== null && uiSession.current !== void 0 && typeof uiSession.current.subscribe === 'function') {
              offCurrent = uiSession.current.subscribe(sync)
            }
          } catch { /* service shapes differ between host versions */ }
        }
        sync()
        timer = setInterval(sync, 3_000)
        return () => {
          disposed = true
          lastSignatureRef.current = ''
          if (timer !== null) clearInterval(timer)
          detachFace()
          if (typeof offList === 'function') {
            try { offList() } catch { /* already disposed */ }
          }
          if (typeof offCurrent === 'function') {
            try { offCurrent() } catch { /* already disposed */ }
          }
        }
      }, [getServices, controller])

      react.useEffect(() => {
        let timer = null
        let disposed = false
        const tick = () => {
          if (disposed) return
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          void controller.refresh()
        }
        timer = setInterval(tick, POLL_MS)
        // Hidden windows have throttled or frozen timers: returning to the app
        // must fetch right away instead of waiting for the next interval.
        document.addEventListener('visibilitychange', tick)
        window.addEventListener('focus', tick)
        window.addEventListener('pageshow', tick)
        window.addEventListener('online', tick)
        return () => {
          disposed = true
          if (timer !== null) clearInterval(timer)
          document.removeEventListener('visibilitychange', tick)
          window.removeEventListener('focus', tick)
          window.removeEventListener('pageshow', tick)
          window.removeEventListener('online', tick)
        }
      }, [controller])

      react.useEffect(() => {
        if (!open) return undefined
        const close = (event) => {
          const target = event.target
          if (buttonRef.current !== null && buttonRef.current.contains(target)) return
          const card = document.querySelector('[data-dsh-opencode-go-usage-badge]')
          if (card !== null && card.contains(target)) return
          setOpen(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', close)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', close)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      const toggleWindow = (kind) => {
        const current = normalizeSelection(selection)
        const next = current.includes(kind)
          ? current.filter((item) => item !== kind)
          : WINDOW_ORDER.filter((item) => item === kind || current.includes(item))
        if (next.length === 0) return
        setSelection(next)
        try {
          localStorage.setItem(SELECTION_KEY, JSON.stringify(next))
        } catch { /* preference is best effort */ }
      }

      const payload = state.payload
      const windows = kind === 'opencode' && payload !== null && typeof payload === 'object' && Array.isArray(payload.windows)
        ? payload.windows
        : []
      const segments = displaySegments(windows, selection)
      const tightest = tightestOf(windows)
      const hidden = hiddenTighter(windows, segments)
      const hiddenReason = hidden === null ? null : `${WINDOW_LABELS[hidden.kind] ?? hidden.kind}更紧（${hidden.remainingPercent}%）`
      const balance = kind === 'deepseek' && payload !== null && typeof payload === 'object' && payload.ok !== false
        ? payload
        : null
      const totalBalance = balance === null ? null : Number(balance.totalBalance)
      const money = totalBalance !== null && Number.isFinite(totalBalance) ? fmtMoney(totalBalance, balance.currency) : null
      const hasValue = kind === 'opencode' ? segments.length > 0 : kind === 'deepseek' ? money !== null : false
      const loading = state.status === 'loading' || kind === 'detecting'
      const stale = !loading && hasValue && (state.ok !== true
        || (typeof state.fetchedAt === 'number' && Date.now() - state.fetchedAt > STALE_MS))
      let tone = 'var(--dsw-alias-label-tertiary, #999)'
      if (!loading) {
        if (kind === 'opencode' && segments.length > 0) {
          tone = toneOf(tightest === null ? null : tightest.remainingPercent)
        } else if (kind === 'deepseek' && money !== null) {
          tone = totalBalance <= 0 ? '#e5484d' : BALANCE_TONE
        }
      }
      const lowQuota = kind === 'opencode' && tightest !== null && quotaTextTone(tightest.remainingPercent) !== null
      const emptyBalance = kind === 'deepseek' && totalBalance !== null && totalBalance <= 0
      const valueStyle = lowQuota ? { ...S.value, color: tone } : emptyBalance ? { ...S.value, color: '#e5484d' } : S.value
      const valueText = loading
        ? '…'
        : kind === 'opencode'
          ? (segments.length === 0 ? '额度 —' : segments.map(segmentText).filter(Boolean).join(' · '))
          : kind === 'deepseek'
            ? (money ?? '余额 —')
            : '额度 —'
      const staleReason = state.message
        ?? (typeof state.fetchedAt === 'number' ? `上次更新 ${fmtClock(state.fetchedAt) ?? '未知'}` : '尚未取到数据')
      const sourceLabel = balance === null
        ? null
        : balance.source === 'account'
          ? '账号登录'
          : balance.source === 'api-key'
            ? 'API Key'
            : null
      let title = '用量与余额（点击展开）'
      if (loading) {
        title = '正在读取当前对话的模型…'
      } else if (kind === 'opencode') {
        const all = windows.map(segmentText).filter(Boolean).join(' · ')
        const selectedText = normalizeSelection(selection).map((kind) => WINDOW_TAGS[kind] ?? kind).join('+')
        title = state.ok === true
          ? `OpenCode Go：${all}（显示 ${selectedText}${hiddenReason === null ? '' : `；${hiddenReason}`}，点击展开）`
          : (state.message ?? 'OpenCode Go 额度')
      } else if (kind === 'deepseek') {
        title = state.ok === true
          ? `DeepSeek 余额 ${money ?? '—'}${sourceLabel === null ? '' : `（${sourceLabel}）`}${model.model === null ? '' : ` · 当前模型 ${model.model}`}`
          : (state.message ?? 'DeepSeek 余额')
      } else {
        title = model.status === 'ready' ? `当前模型 ${model.provider} 暂不支持余额或配额显示`
          : '暂未识别当前对话的模型来源'
      }

      const versionedTitle = `${title} · v${VERSION}`
      const toggle = (event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        setAnchor({ left: Math.max(8, rect.left), bottom: Math.max(8, window.innerHeight - rect.top + 6) })
        setOpen((previous) => !previous)
      }

      return react.createElement(react.Fragment, null,
        react.createElement('button', {
          type: 'button',
          ref: buttonRef,
          style: S.badge,
          title: versionedTitle,
          onClick: toggle,
        },
        react.createElement('span', { style: { ...S.dot, background: tone } }),
        react.createElement('span', { style: valueStyle }, valueText),
        stale || hidden !== null
          ? react.createElement('span', { style: { ...S.muted, fontWeight: 600, ...(hidden !== null ? { color: '#f5a524' } : {}) }, title: hiddenReason ?? staleReason }, '!')
          : null),
        open
          ? react.createElement(Panel, {
            kind,
            state,
            model,
            anchor,
            refreshing: state.refreshing,
            selection,
            onToggle: toggleWindow,
            onRefresh: () => { void controller.refresh(true) },
          })
          : null)
    }

    /**
     * Register immediately. Session services may become available after mounting.
     */
    function mount(ctx, getServices) {
      ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'dsh-opencode-go-usage-badge',
        order: 20,
        label: () => '用量与余额',
      }, () => react.createElement(BadgeBoundary, null,
        react.createElement(PantherUsageBadge, { getServices })))), 'dsh-opencode-go-usage-badge: badge')
    }

    /** Last-resort slot entry: an error message instead of an empty footer. */
    function mountFallback(ctx, error) {
      const text = `徽标加载失败 ${VERSION}`
      const title = String(error && error.message ? error.message : error)
      ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'dsh-opencode-go-usage-badge',
        order: 20,
        label: () => '用量与余额',
      }, () => react.createElement('span', {
        style: { fontSize: '11px', color: '#e5484d', padding: '2px 6px' },
        title,
      }, text))), 'dsh-opencode-go-usage-badge: fallback')
    }

    function apply(ctx) {
      const optional = (name) => {
        try {
          return typeof ctx.get === 'function' ? ctx.get(name) : null
        } catch {
          return null
        }
      }
      const getServices = () => ({ sessions: optional('sessions'), uiSession: optional('uiSession') })
      try {
        mount(ctx, getServices)
      } catch (error) {
        try {
          mountFallback(ctx, error)
        } catch { /* nothing else to try */ }
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.PantherUsageBadge = PantherUsageBadge
    exports.__test = { createRefreshController, Panel, tightestOf, toneOf, quotaTextTone, displaySegments, hiddenTighter, normalizeSelection, segmentText, fmtClock, fmtMoney, kindOfProvider, kindOfModel, selectionOf, readModelSource, readUiModelSource, detectModelSource, VERSION }
    return module.exports
  },
})
