/**
 * page.js — 魔法少女抽卡（前端全部逻辑，无构建）
 *
 * 分层（改起来才不打架）：
 *   ① 配置与常量      CFG / API / SECTIONS
 *   ② 基础设施        el() / clear() / toast() / announce()
 *   ③ 网络            request()（带超时 + 把 401/403 翻译成人话）
 *   ④ 状态与路由      state / parseRoute() / render()
 *   ⑤ 抽卡            runDraw()（判定在 draw.js，这里只管记账与呈现）
 *   ⑥ 各板块渲染      draw / pool / collection / history / admin
 *   ⑦ 卡片与详情      cardFigure() / rarityChip()
 *   ⑧ 编辑器          FIELDS 字段表 → 打开 / 保存
 *   ⑨ 启动            cacheEls() → wire() → boot()
 *
 * 两条纪律：
 *   · 派生字段（xxxUrl）由服务端算好，这里**只读不拼路径**
 *   · 任何失败都要在页面上留下可读痕迹，绝不静默吞掉
 */
;(function () {
  'use strict'

  // -------------------------------------------------------------------------
  // ① 配置与常量
  // -------------------------------------------------------------------------

  /**
   * 读运行时配置。
   *
   * ⚠️ 这个函数**绝不能碰 `state`**：它在模块顶部就被调用，而 `var state` 在它下面
   * 才声明 —— 配置缺失或 JSON 损坏时写 `state.xxx` 会抛 TypeError，把整页带崩，
   * 于是「配置坏了要留痕」这条错误路径自己先坏掉（真踩过：页面白屏且没有任何提示）。
   * 所以它只返回 { cfg, error }，由调用方去记。
   */
  function readConfig() {
    var fallback = { base: '', api: '', unlocked: false, hasKey: false, backend: false, readonly: true }
    var node = document.getElementById('gacha-config')
    if (!node) {
      return { cfg: fallback, error: '页面里没有 #gacha-config 配置块（page.html 被改坏了？）' }
    }
    try {
      var parsed = JSON.parse(node.textContent || '{}')
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { cfg: fallback, error: '#gacha-config 不是 JSON 对象' }
      }
      // 注意 Object.assign 的语义：fallback 里的默认值会被 parsed 覆盖。
      // fallback.readonly=true 只是「没有配置时的安全默认」，显式传 false 才算动态站。
      return { cfg: Object.assign(fallback, parsed), error: '' }
    } catch (err) {
      return { cfg: fallback, error: '页面配置（#gacha-config）不是合法 JSON：' + err.message }
    }
  }

  var _cfgResult = readConfig()
  var CFG = _cfgResult.cfg

  /** API 前缀：静态站没有后端，所有写操作直接落到 localStorage */
  var API = CFG.api || ''
  var BACKEND = CFG.backend !== false
  /** 静态导出站：整体隐藏编辑入口（区别于「这次没解锁」） */
  var READONLY = !!CFG.readonly

  /**
   * 动态站的配置里不该有 readonly。
   * 没有它时 fallback 的 true 不会生效（parsed 覆盖了别的键），但漏传 backend 之类的
   * 情况会让页面误判成静态站 —— 那种「看起来能用、其实编辑入口全没了」的症状极难查，
   * 所以在开发期就把可疑配置喊出来。
   */
  if (!READONLY && CFG.backend === undefined) {
    console.warn('[gacha] 配置里既没有 readonly 也没有 backend —— 页面会按动态站处理，请检查注入的配置。')
  }

  var SECTIONS = [
    { id: 'draw', label: '抽卡', hash: '#/draw' },
    // 「卡池一览」已删除：它展示的就是图鉴一级分组（卡池）的内容，功能重复。
    // 想按卡池看牌 → 图鉴里按卡池收起/展开。
    { id: 'collection', label: '图鉴', hash: '#/collection' },
    { id: 'shards', label: '碎片兑换', hash: '#/shards' },
    /**
     * 每日签到（用户 2026-09-19）。
     *
     * 放在碎片兑换之后：它是「每天来一次」的动作，不是抽卡的前置 ——
     * 读者点进来领完就走，所以不占第一位（第一位留给抽卡）。
     */
    { id: 'checkin', label: '每日签到', hash: '#/checkin' },
    { id: 'history', label: '抽卡记录', hash: '#/history' },
    // 「关注安叶喵」：参考 dsh-magical-girl-catalog 的「关注安叶！」板块。
    // 放在后台管理之前 —— 那是给读者的内容，后台是给作者的。
    { id: 'follow', label: '关注安叶喵', hash: '#/follow' },
    { id: 'admin', label: '后台管理', hash: '#/admin', needsEdit: true },
  ]

  /** localStorage 键（静态站用它承载抽卡状态） */
  var LS = {
    player: 'gacha.player.v1',
    collection: 'gacha.collection.v1',
    last: 'gacha.last.v1',
    /** 抽卡动画开关（读者自己的偏好，不写服务端） */
    anim: 'gacha.anim.v1',
    /** 图鉴里收起的系列组（也是读者偏好） */
    collapsed: 'gacha.collapsed.v1',
    /** 图鉴里每张卡选中的闪卡工艺（读者偏好：切换过就记住） */
    foilView: 'gacha.foilview.v1',
    /** 选中的卡池（读者偏好：刷新之后要还在，否则「我选了群友池」会白选） */
    pool: 'gacha.pool.v1',
    /** 哪些卡池切到了「追梦池」模式（读者偏好；花券的是读者，所以由他决定） */
    dream: 'gacha.dream.v1',
    /**
     * 图鉴里显示动态卡面还是静态卡面（读者偏好，默认**静态**）。
     *
     * 默认关是刻意的：默认开意味着读者一进图鉴就有视频在解码，
     * 而他可能只是来查一张卡的合成价 —— 那是白花的电量和流量。
     */
    dynamic: 'gacha.dynamic.v1',
  }

  /**
   * sessionStorage 键：**只在这一次「打开网站」里有效**。
   *
   * 与 LS 分开是刻意的：LS 里放的是「读者偏好 / 进度」，要跨次保留；
   * 这里放的是「这一趟已经做过的事」。公告弹窗的「每次打开最多一次」
   * 就是这个语义 —— 放进 LS 会变成「一辈子只弹一次」（读者换台机器或
   * 清了缓存又会弹，而不是按次）。
   */
  var SS = {
    /** 公告弹窗这一趟是否已经弹过 */
    notice: 'gacha.notice.v1',
  }

  var state = {
    data: null,
    unlocked: false,
    hasKey: false,
    route: 'draw',
    routeArg: '',
    poolId: '',
    warning: '',
    /** 配置块读不出来时的原因（非空就说明页面起不来，且原因要留在标题上） */
    configBroken: '',
    /** 最近一次抽卡结果：{ results, at, poolId, dryRun } */
    last: null,
    /** 待编辑对象：{ kind:'card'|'pool', id } */
    editing: null,
    /** 本次会话的碎片兑换记录（只用于显示，不落盘） */
    shardLog: [],
    /** 图鉴搜索词（切板块后保留，回来还在） */
    collQuery: '',
    /** 图鉴里收起的系列组 { 'series:女仆系列': true } */
    collapsed: {},
    /** 图鉴里每张卡选中的闪卡工艺 { 卡牌id: 'full' }（读者偏好） */
    foilView: {},
    /** 图鉴的工艺筛选：'' = 全部，否则只看拥有这门工艺的卡 */
    foilFilter: '',
    /**
     * 图鉴的稀有度筛选：'' = 全部，否则只看这一档。
     *
     * 取值为**档位 id**（`SR` / `SSR` / `UR` / `???`）或 `HR`。
     * ⚠️ `HR` **不是档位表里的一项**（它是「这张卡有动态卡面」的状态，见 draw.js 的
     * `canUnlockHr`）—— 但作者要求筛选里能选 HR（用户 2026-09-19：
     * 「在筛选中新增筛选稀有度（SR/SSR/UR/SP/HR）」），所以它在这里是一个特例：
     * 选中它 = 只看**配了动态卡面**的卡。别把它塞进 `data.rarities` ——
     * 那会让概率表/卡池一览/动画配色各多出一档永远 0 张的幽灵档。
     */
    rarityFilter: '',
    /** 哪些卡池切到了追梦池模式：`{ 卡池id: true }`（读者偏好） */
    dreamPools: {},
    /** 在大图里换过工艺、图鉴格子还没跟上（关弹层时要重画一次） */
    foilViewDirty: false,
    /** 大图弹层当前显示的卡 id */
    cardOpen: '',
    /**
     * 公告弹窗在这**一次打开**里是否已经弹过（内存标记）。
     * 与 sessionStorage 里的标记一起把关，见 noticeOnce。
     */
    noticeShown: false,
    els: {},
  }

  var TERMINOLOGY = {
    top: '最高档',
  }

  // -------------------------------------------------------------------------
  // ② 基础设施
  // -------------------------------------------------------------------------

  // 配置坏了时的可见痕迹。放在「基础设施」这一段里、在 state 声明之后设置 ——
  // readConfig() 自己不能写 state（见它的注释），所以由这里落账。
  if (_cfgResult.error) {
    state.configBroken = _cfgResult.error
    document.title = '配置解析失败 — 魔法少女抽卡'
    var brokenBox = document.getElementById('view')
    if (brokenBox) {
      brokenBox.textContent = _cfgResult.error + '（这是构建/注入的问题，不是你的操作问题）'
    }
    console.error('[gacha] ' + _cfgResult.error)
  }

  /**
   * 建 DOM。
   *
   * ⚠️ 绝不通过 setAttribute 写 style：页面的 CSP 是 style-src 'self'（没有
   * unsafe-inline），`setAttribute('style', ...)` / 传 `{style: ...}` 会被浏览器
   * **静默丢掉、不报错** —— 参考实现里首页封面因此整整一版没显示出来。
   * 需要动态样式请用 CSSOM（node.style.xxx = ...，CSP 不管它）。
   */
  function el(tag, attrs, children) {
    var node = document.createElement(tag)
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue
        var v = attrs[k]
        if (v === undefined || v === null || v === false) continue
        if (k === 'style') {
          // 把静默失效变成开发期可见的错
          console.error('[gacha] 拒绝 style 属性（CSP 会静默丢掉它）：请改用 CSS 类或 CSSOM', attrs)
          continue
        }
        if (k === 'class') node.className = String(v)
        else if (k === 'text') node.textContent = String(v)
        else if (k === 'html') node.innerHTML = String(v) // 仅用于内部固定片段，绝不用于用户内容
        else if (k.indexOf('data-') === 0 || k === 'type' || k === 'value' || k === 'placeholder' || k === 'title' || k === 'href' || k === 'src' || k === 'alt' || k === 'id' || k === 'name' || k === 'rows' || k === 'loading' || k === 'aria-label' || k === 'aria-live' || k === 'autocomplete' || k === 'spellcheck' || k === 'min' || k === 'max' || k === 'step') {
          node.setAttribute(k, String(v))
        } else if (k === 'hidden') {
          if (v) node.hidden = true
        } else {
          node.setAttribute(k, String(v))
        }
      }
    }
    append(node, children)
    return node
  }

  function append(node, children) {
    if (children === undefined || children === null || children === false) return
    if (Array.isArray(children)) {
      for (var i = 0; i < children.length; i++) append(node, children[i])
      return
    }
    if (isNode(children)) {
      node.appendChild(children)
      return
    }
    // 文本一律走 textContent —— 内容里可能有角色名，防 XSS
    node.appendChild(document.createTextNode(String(children)))
  }

  /**
   * 是不是一个 DOM 节点。
   *
   * 用鸭子类型而不是 `instanceof Node`：那在真实浏览器里没问题，但在测试用的最小
   * DOM shim 上，节点是普通对象，`instanceof Node` 恒为 false —— 于是**所有子节点
   * 都被当成文本**、整棵树退化成一行字符串，页面看起来像没渲染。测试里出现这种
   * 症状时，先看这里。
   */
  function isNode(v) {
    return !!v && typeof v === 'object' && typeof v.nodeType === 'number' && typeof v.appendChild === 'function'
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild)
    return node
  }

  function announce(msg) {
    var a = state.els.announce
    if (a) a.textContent = String(msg)
  }

  var toastTimer = null
  function toast(msg, kind) {
    var t = state.els.toast
    if (!t) return
    t.textContent = String(msg)
    t.hidden = false
    t.className = 'toast' + (kind ? ' toast-' + kind : '')
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(function () {
      t.hidden = true
    }, kind === 'error' ? 6000 : 2600)
  }

  function fmt(n) {
    return String(n == null ? 0 : n)
  }

  /**
   * 出率（0~1 的小数）显示成百分比。
   *
   * 为什么要专门写一个：权重现在是 60 / 35 / **4.4** / **0.6**，
   * 直接用 `(rate*100).toFixed(2)` 会显示成「4.40%」「0.60%」——
   * 数字没错，但和作者心里想的「4.4%」「0.6%」看着不像一回事，
   * 而 60% 显示成「60.00%」又啰嗦。这里去掉多余的 0。
   *
   * ⚠️ 只去掉**小数部分**末尾的 0，不能把「60」变成「6」：
   * 正则 `\.?0+$` 会连着小数点一起吃掉（"60.00" -> "60"、"4.40" -> "4.4"），
   * 而 "0.60" 里那个 0 前面是 6，所以只吃掉末尾的 0 -> "0.6"。
   */
  function fmtRate(rate) {
    var p = Number(rate) * 100
    if (!isFinite(p)) return '0%'
    var s = p.toFixed(2)
    if (s.indexOf('.') !== -1) s = s.replace(/\.?0+$/, '')
    return (s === '' ? '0' : s) + '%'
  }

  function fmtTime(ms) {
    if (!ms) return '—'
    var d = new Date(Number(ms))
    if (isNaN(d.getTime())) return '—'
    function p(x) {
      return (x < 10 ? '0' : '') + x
    }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }

  // -------------------------------------------------------------------------
  // ③ 网络
  // -------------------------------------------------------------------------

  /**
   * 带超时的请求。把 401/403 翻译成「人能照着做」的话 ——
   * 直接把 status code 甩到界面上等于让人去猜。
   */
  function request(path, opts) {
    opts = opts || {}
    var url = API + path
    var timeoutMs = opts.timeoutMs || 15000
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
    var timer = ctrl
      ? setTimeout(function () {
          ctrl.abort()
        }, timeoutMs)
      : null

    var init = {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    }
    if (ctrl) init.signal = ctrl.signal
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body)

    return fetch(url, init)
      .then(function (res) {
        return res.text().then(function (text) {
          var json = null
          try {
            json = JSON.parse(text)
          } catch (e) {}
          if (!res.ok) {
            var msg =
              (json && json.error) ||
              (res.status === 401
                ? '请求被 DSH 的信任栅栏拦下了（可能是会话过期，刷新页面重试）'
                : res.status === 403
                ? '没有权限：这个操作需要先解锁编辑秘钥'
                : res.status === 404
                ? '接口不存在：' + path + '（插件可能没重新加载）'
                : 'HTTP ' + res.status + (text ? '：' + text.slice(0, 200) : ''))
            var err = new Error(msg)
            err.status = res.status
            err.payload = json
            throw err
          }
          return json === null ? { ok: true, raw: text } : json
        })
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') {
          throw new Error('请求超时（' + Math.round(timeoutMs / 1000) + 's）：' + path)
        }
        throw err
      })
      .then(function (v) {
        if (timer) clearTimeout(timer)
        return v
      })
      .catch(function (err) {
        if (timer) clearTimeout(timer)
        throw err
      })
  }

  // -------------------------------------------------------------------------
  // ④ 状态：本地存储（静态站用）
  // -------------------------------------------------------------------------

  function lsGet(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key)
      if (!raw) return fallback
      var parsed = JSON.parse(raw)
      return parsed === null || parsed === undefined ? fallback : parsed
    } catch (err) {
      // 存储读不出来（隐私模式/配额）必须留痕，否则会表现成「记录凭空消失」
      console.warn('[gacha] 读取 localStorage 失败：' + key, err)
      return fallback
    }
  }

  function lsSet(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
      return true
    } catch (err) {
      console.warn('[gacha] 写入 localStorage 失败：' + key, err)
      toast('本机存储写入失败（可能是隐私模式或配额满）：抽卡记录无法保存', 'error')
      return false
    }
  }

  /**
   * sessionStorage：**会话级**的标记。
   *
   * 与 localStorage 的区别正好是公告弹窗要的语义：「每次打开网站最多一次」
   * —— 刷新还是同一次打开（不该再弹），关掉标签页再进来才算新的一次。
   *
   * ⚠️ 它可能整个不可用（隐私模式、被策略禁用、file:// 打开）。所以每条读写都
   * 自己 try/catch 并**退回内存标记**（调用方另有一份内存标记，见 noticeOnce）；
   * 少了这一层，页面会在读取时抛异常，表现成「开了网站什么都没发生」。
   */
  function ssGet(key, fallback) {
    try {
      var store = window.sessionStorage
      if (!store) return fallback
      var raw = store.getItem(key)
      if (!raw) return fallback
      var parsed = JSON.parse(raw)
      return parsed === null || parsed === undefined ? fallback : parsed
    } catch (err) {
      console.warn('[gacha] 读取 sessionStorage 失败（将退回内存标记）：' + key, err)
      return fallback
    }
  }

  function ssSet(key, value) {
    try {
      var store = window.sessionStorage
      if (!store) return false
      store.setItem(key, JSON.stringify(value))
      return true
    } catch (err) {
      console.warn('[gacha] 写入 sessionStorage 失败：' + key, err)
      return false
    }
  }

  /**
   * 本地抽卡状态。
   *
   * 动态站也有它 —— 静态站（GitHub Pages）**完全靠它**承载抽卡状态：
   * 拥有张数、碎片、抽数、保底计数、记录。形状与服务端的 `player` 字段
   * 刻意保持一致，这样 `player()` / `collection()` / `shards()` 三个访问器
   * 在两种站上返回同样的东西，渲染代码不用分支。
   */
  function localState() {
    var s = lsGet(LS.player, null)
    if (!s || typeof s !== 'object') {
      s = {
        currency: 0,
        currencyName: '抽卡券',
        pulls: 0,
        sinceTop: 0,
        history: [],
        // 与服务端同名：卡牌 id -> 张数
        owned: {},
        // 与服务端同名：稀有度 id -> 个数
        shards: {},
        duplicates: 0,
        // 与服务端同名：卡池 id -> true（SP 保底开关，见 draw.js 的 spPityAfter）
        spPity: {},
        // 与服务端同名：卡池 id -> true（UR 保底，见 draw.js 的 urPityAfter）
        urPity: {},
        // 与服务端同名：卡牌 id -> 拥有的特殊工艺数组（见 draw.js 的 foilsAfter）
        foils: {},
      }
    }
    // 旧版本用过 collection 这个名字 —— 迁移过来，别让老玩家的收集进度凭空消失
    if (s.collection && typeof s.collection === 'object' && !s.owned) {
      s.owned = s.collection
    }
    delete s.collection
    if (!s.owned || typeof s.owned !== 'object') s.owned = {}
    if (!s.shards || typeof s.shards !== 'object') s.shards = {}
    if (!Array.isArray(s.history)) s.history = []
    if (typeof s.duplicates !== 'number') s.duplicates = 0
    // 只留真值：留着 false / 0 / 空字符串会让「开关开着吗」这类判断到处要写 === true
    if (!s.spPity || typeof s.spPity !== 'object') s.spPity = {}
    else {
      var kept = {}
      for (var pk in s.spPity) if (s.spPity[pk]) kept[pk] = true
      s.spPity = kept
    }
    // UR 保底：与 spPity 同一种形状、同一条纪律（只留真值）
    if (!s.urPity || typeof s.urPity !== 'object') s.urPity = {}
    else {
      var keptU = {}
      for (var uk in s.urPity) if (s.urPity[uk]) keptU[uk] = true
      s.urPity = keptU
    }
    // 工艺拥有表：只留认识的工艺 id，去重（拼错的留着不会报错，
    // 只会让「这张卡到底有没有闪」永远判错）
    if (!s.foils || typeof s.foils !== 'object' || Array.isArray(s.foils)) s.foils = {}
    else {
      var keptF = {}
      for (var fk in s.foils) {
        var list = s.foils[fk]
        if (!Array.isArray(list)) continue
        var ids = []
        for (var li = 0; li < list.length; li++) {
          var id = foilId(list[li])
          if (id && ids.indexOf(id) < 0) ids.push(id)
        }
        if (ids.length) keptF[fk] = ids
      }
      s.foils = keptF
    }
    return s
  }

  function saveLocal(s) {
    lsSet(LS.player, s)
  }

  /**
   * 抽卡状态：**由「服务端快照里有没有 player」决定归谁管**。
   *
   *   · 有 player  -> 动态站，服务端那份是权威（它记账、它算碎片）
   *   · 没有 player -> 静态站（export-static 会剥掉 player），状态在 localStorage
   *
   * 为什么用「有没有这个字段」而不是 `state.unlocked` 来判断：
   * 未解锁的人**不是没有状态**，只是不能改卡池 —— 他一样会抽卡、一样该看到自己的收集进度。
   * 早先用 unlocked 分流，导致未解锁时读到一份空状态，表现成
   * 「重复卡永远算新卡、碎片永远是 0、图鉴永远没进度、记录永远为空」。
   * 而导出脚本一定会删掉 player，所以这个判据在两种站上是确定的。
   */
  function player() {
    var sv = state.data && state.data.player
    if (BACKEND && sv && typeof sv === 'object') return sv
    return localState()
  }

  /** 已拥有张数：卡牌 id -> 张数 */
  function collection() {
    var p = player()
    return (p && (p.owned || p.collection)) || {}
  }

  /** 碎片：稀有度 id -> 个数 */
  function shards() {
    var p = player()
    return (p && p.shards) || {}
  }

  /** 表情包转发 URL：稀有度 id -> url（服务端/导出脚本算好，前端只读） */
  function emojiUrls() {
    var s = (state.data && state.data.settings) || {}
    return s.emojiUrls || {}
  }

  /** 抽卡动画的配置（配色、背景暗度、开关默认值…） */
  function revealConfig() {
    var s = (state.data && state.data.settings) || {}
    return s.reveal || {}
  }

  /**
   * 动画现在开不开。
   *
   * 读者自己的选择（存在**他的浏览器**里）优先于数据里的默认值 ——
   * 「要不要看动画」是每个人的偏好，不是站点的内容，所以不该写进服务端。
   * 数据里的 `reveal.enabled` 只作为「从未选过时」的默认。
   */
  function animEnabled() {
    var stored = lsGet(LS.anim, null)
    if (stored === true || stored === false) return stored
    return revealConfig().enabled !== false
  }

  function setAnimEnabled(on) {
    lsSet(LS.anim, !!on)
  }

  /** 碎片规则（服务端/本地都要按同一份规则显示与判定） */
  function shardRules() {
    var S = window.GachaShards
    if (!S) return { perDuplicate: 1, costForCard: 5, costForUpgrade: 5 }
    return S.rules(state.data || {})
  }

  /**
   * 把**已确认的状态**写回内存快照。
   *
   * ⚠️ 这一步不能省。抽卡/兑换在本地记账后如果只写 localStorage，
   * `state.data.player` 还停在页面加载时那一眼的值 —— 于是**下一次抽卡的重复判定
   * 读到的还是「什么都没拥有」**，同一张卡抽一百次都算新卡、一个碎片也攒不到。
   * 所有改动状态的代码路径都必须调用它。
   */
  function applyStateToSnapshot(patch) {
    if (!state.data) return
    /*
     * ⚠️ 快照里**没有** player 时（静态站），先把**本机完整状态**放进去，再打补丁。
     *
     * 不能只放 patch 里那几个字段 —— 那会造出一个「残缺的 player」，而 `player()`
     * 只要看到快照里有 player 就认它（那条判断是用来分「动态站/静态站」的），
     * 于是本机状态被半张空表遮住：抽卡全部判成新卡、保底开关读不到、碎片永远 0。
     * 实测就是这么炸的：每日赠送往快照里写了 points/lastGift 两个字段，
     * 之后所有抽卡都变成「新卡」（SP 保底那几条断言一起红）。
     */
    if (!state.data.player || typeof state.data.player !== 'object') {
      state.data.player = localState()
    }
    var p = state.data.player
    if (patch.owned) p.owned = patch.owned
    if (patch.shards) p.shards = patch.shards
    if (patch.duplicates !== undefined) p.duplicates = Number(patch.duplicates || 0)
    if (patch.pulls !== undefined) p.pulls = Number(patch.pulls || 0)
    if (patch.sinceTop !== undefined) p.sinceTop = Number(patch.sinceTop || 0)
    if (patch.history) p.history = patch.history
    if (patch.spPity) p.spPity = patch.spPity
    /*
     * UR 保底：漏了这一行的症状是「刚抽到重复 UR，界面还说下一张不会保底」，
     * 而且同一轮之后的抽卡会重新按「未保底」算 —— 也就是保底**时灵时不灵**。
     * 与 spPity 一样，`patch.urPity` 允许是空表（表示「保底关掉了」）。
     */
    if (patch.urPity) p.urPity = patch.urPity
    if (patch.foils) p.foils = patch.foils
    // 追梦计数与券数：追梦池要靠它算「SP 涨到多少了」，换券之后券数也要立刻可见
    if (patch.dream) p.dream = patch.dream
    if (patch.currency !== undefined) p.currency = Number(patch.currency || 0)
    // 点数（普通抽卡次数）与「今天领过每日赠送没有」
    if (patch.points !== undefined) p.points = Number(patch.points || 0)
    if (patch.lastGift !== undefined) p.lastGift = String(patch.lastGift || '')
    /*
     * HR 动态卡面的解锁状态：图鉴的动静开关、大图的兑换按钮、碎片页的 HR 区块
     * 全都读它。漏了这一行的症状很典型 —— **本机已经解锁了，界面还说没解锁**
     * （碎片扣掉了、按钮还在那儿），刷新一次又正常（服务端那份是新的）。
     * 这一类「快照少写一个字段」的 bug 在 points/lastGift 上已经踩过一次。
     */
    if (patch.hr) p.hr = patch.hr
    // 今日签到的候选与选择：签到页要在**同一次会话里**立刻看到刚开的四张牌
    if (patch.checkin) p.checkin = patch.checkin
    /*
     * 红碎欠条：抽卡时本地已经把「兑现掉 / 新攒的」算好了（见 runDraw 的 pityNext），
     * 不写回快照的话，紧接着的下一次十连读到的还是抽之前那张旧表 ——
     * 症状是「欠条兑现过了却还欠着」，或者反过来「攒了新的却没补」。
     * 后端（动态站）本来会靠响应里那份 player 自愈，但**本机那一刻**是错的。
     */
    if (patch.shatterPity) p.shatterPity = patch.shatterPity
    /*
     * 记完账立刻对一次「集齐系列才有」的纪念卡。
     *
     * 用户 2026-09-20：「在收集完成『冥幽』系列之后领取……如果后续推出新的卡片，
     * 则纪念卡会被回收，在重新收集完成时再次获得」。所以它必须在**每一次**
     * 状态变化之后重算 —— 抽到系列最后一张卡的那一刻就该拿到，
     * 而不是「等下次刷新页面时服务端顺手补上」（静态站根本没有服务端）。
     */
    syncMemorials({ announce: true })
  }

  /**
   * 「集齐系列才有」的纪念卡对账（发放 / 回收）。
   *
   * 规则本体在 `page/shards.js` 的 `reconcileMemorials` —— 服务端、导出、客户端
   * 同一份源码；这里只负责**把结果落回当前站的状态载体**：
   *   · 动态站 -> 内存快照（服务端那份是权威，它也在同一个位置对账）
   *   · 静态站 -> localStorage（没有服务端，本机就是权威）
   *
   * @param {{announce?:boolean}} opts `announce` = 这次变化值得报一声（抽卡之后），
   *        每次渲染都报的话，开页面就会被自己的纪念卡刷屏。
   * @returns {{changed:boolean, granted:Array, revoked:Array}|null}
   */
  function syncMemorials(opts) {
    var S = window.GachaShards
    if (!S || typeof S.reconcileMemorials !== 'function' || !state.data) return null
    var r = S.reconcileMemorials(dataWithState())
    if (!r.changed) return r

    var s = localState()
    s.owned = r.owned
    s.foils = r.foils
    saveLocal(s)
    if (state.data.player && typeof state.data.player === 'object') {
      state.data.player.owned = r.owned
      state.data.player.foils = r.foils
    }

    if (opts && opts.announce) {
      var names = function (list) {
        return list
          .map(function (x) { return '「' + x.card.name + '」' })
          .join('、')
      }
      if (r.granted.length) {
        toast('集齐「' + r.granted[0].progress.series + '」系列，获得纪念卡 ' + names(r.granted) + '（含全部特殊工艺）', 'ok')
      }
      if (r.revoked.length) {
        toast(
          '「' + r.revoked[0].progress.series + '」系列又新增了卡，纪念卡 ' + names(r.revoked) +
            ' 已暂时回收（重新集齐 ' + r.revoked[0].progress.total + ' 张后会再发一次）',
          'error'
        )
      }
    }
    return r
  }

  /**
   * 把**当前实际状态**（owned / shards / sinceTop / spPity）折进快照，
   * 供 shards.js / draw.js 的纯函数使用。
   *
   * ⚠️ 这一步也不能省。shards.js / draw.js 的函数是纯函数，只认传入对象里的
   * `player.*`；而静态站的数据快照里**根本没有 player**（导出时会剥离），
   * 直接传 state.data 会让碎片永远显示 0、兑换按钮永远禁用、
   * 「抽到的是不是重复」「SP 保底开着没有」全判错 —— 一个「点了没反应」的静默 bug。
   * 所有问「能不能兑换」「现在有多少碎片」「这次是不是重复」的地方都先过这里。
   */
  function dataWithState() {
    var d = state.data || {}
    var p = player() || {}
    return Object.assign({}, d, {
      player: Object.assign({}, d.player, {
        owned: p.owned || p.collection || {},
        shards: p.shards || {},
        duplicates: Number(p.duplicates || 0),
        sinceTop: Number(p.sinceTop || 0),
        spPity: p.spPity || {},
        urPity: p.urPity || {},
        foils: p.foils || {},
        dream: p.dream || {},
        currency: Number(p.currency || 0),
        currencyName: p.currencyName || '抽卡券',
        points: Number(p.points || 0),
        lastGift: String(p.lastGift || ''),
        /**
         * ⚠️ 下面这三张表**必须显式带上**，不能指望 `d.player` 里已经有。
         *
         * 静态站（导出时会剥掉 player）里 `d.player` 是空的，全靠这份清单补；
         * 漏字段的症状都极隐蔽：
         *   · `shatterPity` -> 欠条「当时领了、下次十连却不兑现」，而且**只在静态站**、
         *     且只在「今天已经签过到」的时候出现 —— 2026-09-19 之前它一直没露出来，
         *     是因为启动时那次自动发放的每日赠送顺手把 player 塞进了快照，
         *     把这份清单的漏洞挡住了。改成签到的当天就炸在 §42 的断言上。
         *   · `checkin` -> 签到页看不到自己刚开的四张牌，领取永远报「不在候选里」
         *   · `hr` -> 刚解锁的动态卡面在界面里立刻又变回「未解锁」
         * **「另有别处会帮我补上」不是设计，是巧合。**
         */
        shatterPity: p.shatterPity || {},
        hr: p.hr || {},
        checkin: p.checkin || {},
      }),
    })
  }

  // -------------------------------------------------------------------------
  // ④ 路由
  // -------------------------------------------------------------------------

  function parseRoute() {
    var hash = String(window.location.hash || '')
    if (!hash || hash === '#' || hash === '#/') return { route: 'draw', arg: '' }
    var body = hash.replace(/^#\/?/, '')
    var parts = body.split('/')
    var name = parts[0] || 'draw'
    var known = false
    for (var i = 0; i < SECTIONS.length; i++) if (SECTIONS[i].id === name) known = true
    if (!known) return { route: 'draw', arg: '', bad: name }
    return { route: name, arg: decodeURIComponent(parts.slice(1).join('/') || '') }
  }

  function go(hash) {
    if (window.location.hash === hash) render()
    else window.location.hash = hash
  }

  // -------------------------------------------------------------------------
  // 排行榜 / 卡池辅助
  // -------------------------------------------------------------------------

  function rarityList() {
    return (state.data && state.data.rarities) || []
  }

  function rarityById(id) {
    var list = rarityList()
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]
    return null
  }

  function topRarity() {
    var list = rarityList()
    return list.length ? list[list.length - 1] : null
  }

  function cardById(id) {
    var cards = (state.data && state.data.cards) || []
    for (var i = 0; i < cards.length; i++) if (cards[i].id === id) return cards[i]
    return null
  }

  function currentPool() {
    var pools = (state.data && state.data.pools) || []
    if (!pools.length) return null
    for (var i = 0; i < pools.length; i++) if (pools[i].id === state.poolId) return pools[i]
    return pools[0]
  }

  // -------------------------------------------------------------------------
  // 追梦池（用户要求：给现有卡池加一个「追梦池」切换项）
  // -------------------------------------------------------------------------
  //
  // 它是**每个池子上的开关**，不是第三个池子：切过去之后出率换成另一套、
  // 工艺概率上调、并且要花抽卡券；切回来依旧免费。
  // 「哪些池子开着」是**读者偏好**（存在他自己浏览器里），因为花的是他的券。

  /** 这个池子能不能切追梦模式（看池子上的 dream 配置） */
  function dreamAvailable(pool) {
    var g = G()
    if (!g || typeof g.dreamAvailable !== 'function') return false
    return g.dreamAvailable(pool)
  }

  /** 当前池子现在是不是追梦模式 */
  function dreamOn(pool) {
    if (!pool || !dreamAvailable(pool)) return false
    return !!(state.dreamPools || {})[pool.id]
  }

  function setDreamOn(poolId, on) {
    var m = Object.assign({}, state.dreamPools || {})
    if (on) m[poolId] = true
    else delete m[poolId]
    state.dreamPools = m
    lsSet(LS.dream, m)
  }

  /** 追梦计数（玩家状态：`player.dream[poolId]`） */
  function dreamSteps(poolId) {
    var p = player()
    var m = (p && p.dream) || {}
    var raw = Number(m[poolId])
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
  }

  /** 这一池当前的追梦信息（权重 / 次数 / 上限 / SP 档位）—— 拿不到就返回 null */
  function dreamInfo(pool) {
    var g = G()
    if (!g || !pool || !dreamOn(pool)) return null
    var d = g.dreamWeights(state.data, pool, dreamSteps(pool.id))
    return d
  }

  /** 这个池子一次抽卡要花什么（追梦模式花券、普通模式花点数） */
  function drawPrice(count, pool) {
    var g = G()
    if (!g || !g.priceFor) return { amount: 0, currency: 'points', name: '点数' }
    return g.priceFor(state.data, count, { pool: pool, dream: dreamOn(pool) })
  }

  function drawCost(count, pool) {
    return drawPrice(count, pool).amount
  }

  /** 点数（普通抽卡用的次数） */
  function points() {
    var p = player()
    return Math.max(0, Number((p && p.points) || 0))
  }

  /** 抽卡券（追梦池用的） */
  function tickets() {
    var p = player()
    return Math.max(0, Number((p && p.currency) || 0))
  }

  /**
   * ⚠️ 每日赠送**不再自动发放**（用户 2026-09-19）。
   *
   * 这里以前是 `claimDailyGift()`：打开页面就送 300 点，并把 `player.lastGift`
   * 写成今天。改成签到之后**不能再留一个自动发放的入口** —— 留着的话点数会
   * 自动到账两次（一次自动、一次签到），而页面上只会显示「点数比预期多」。
   *
   * 现在发点数的地方只有一处：`viewCheckin` 的领取按钮 → `doCheckinClaim`。
   * 旧的「当天领过没有」判定仍然共用 `player.lastGift`（见 draw.js 的
   * `giftClaimedOn`），所以换个入口也不会多领一次。
   */

  /**
   * 某个卡池里的全部卡牌对象。
   *
   * 成员判定**只用服务端算好的 `pool.byRarity`**，前端不自己按系列筛 ——
   * 前后端各写一套筛选规则，迟早会出现「界面说这个池有这张卡、抽卡却抽不到」。
   * 服务端没给 byRarity 时（老数据）返回空数组。
   */
  function poolCardsAll(pool) {
    if (!pool) return []
    var by = pool.byRarity || {}
    var out = []
    var seen = {}
    for (var r in by) {
      if (!Object.prototype.hasOwnProperty.call(by, r)) continue
      var ids = by[r] || []
      for (var i = 0; i < ids.length; i++) {
        if (seen[ids[i]]) continue
        seen[ids[i]] = 1
        var c = cardById(ids[i])
        if (c) out.push(c)
      }
    }
    return out
  }

  /** 卡池的系列说明文字（`常驻` 是「不属于任何系列」的哨兵，要说清楚） */
  function seriesLabel(list) {
    if (!list || !list.length) return '不限系列（收全部卡）'
    return list
      .map(function (s) {
        return s === '常驻' ? '常驻（无系列）' : s
      })
      .join('、')
  }

  /**
   * 切换卡池。**抽卡范围由它决定** —— 抽卡判定用的是池子的 `byRarity`。
   *
   * 选择存进 localStorage：不存的话刷新一次就掉回第一个池，
   * 读者会以为自己「选了但没用」。数据里已经没有这个池时（被删了）
   * 由 currentPool() 兜回第一个池，不会卡在空池上。
   */
  function selectPool(id) {
    if (!id) return
    var pools = (state.data && state.data.pools) || []
    if (!pools.some(function (p) { return p.id === id })) return
    if (state.poolId === id) return
    state.poolId = id
    lsSet(LS.pool, id)
    render()
  }

  /** 这个池子可抽多少张（服务端算好优先，老数据退回自己数） */
  function poolPlayableCount(p) {
    if (!p) return 0
    if (p.playableCount != null) return Number(p.playableCount)
    var n = 0
    var buckets = p.byRarity || {}
    for (var k in buckets) n += (buckets[k] || []).length
    return n
  }

  /** 一句话说清「现在抽卡会抽到哪些卡」——范围必须让人看得见 */
  function poolScopeLine(pool) {
    if (!pool) return null
    return el('div', { class: 'pool-scope' }, [
      el('span', { class: 'pool-scope-key', text: '抽卡范围' }),
      el('span', { class: 'pool-scope-name', text: pool.name }),
      el('span', { class: 'pool-scope-count', text: poolPlayableCount(pool) + ' 张' }),
      el('span', { class: 'pool-scope-series', text: seriesLabel(pool.series) }),
    ])
  }

  /** 轮播滑动时长（与 page.css 的 .banner-track transition 对应） */
  var BANNER_SLIDE_MS = 620

  // 轮播的定时器与「这一代」标记。
  // **必须能彻底停**：每次 render() 都会重建 DOM，旧定时器若不停，它会继续去改
  // 已经不存在的节点；而且归位用的那个 setTimeout 如果在换板块时刚好在等，
  // 它回来还会再起一个新定时器 —— 于是页面越用越多的隐形轮播。
  // 用「代号（generation）」而不是只 clearInterval：代号能连带作废已排队的回调。
  var bannerTimer = null
  var bannerWrapTimer = null
  var bannerGen = 0

  function stopBannerTimer() {
    bannerGen++
    if (bannerTimer) {
      clearInterval(bannerTimer)
      bannerTimer = null
    }
    if (bannerWrapTimer) {
      clearTimeout(bannerWrapTimer)
      bannerWrapTimer = null
    }
  }

  /** 读者是否要求「减少动态效果」——那就不要自动轮播，只留手动切换 */
  function prefersReducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    } catch (e) {
      return false
    }
  }

  /**
   * 卡池切换：侧面竖排的「封面（半透明）+ 卡池名」方块。
   *
   * 封面用**卡池自带的封面卡**（`coverCardUrl`）。半透明是**未选中**的状态，
   * 选中的那个不透明并加一圈高亮 —— 用透明度而不是灰度，
   * 是为了让几张封面并排时仍然认得出画的是什么。
   */
  function poolSwitcherColumn() {
    var col = el('div', { class: 'draw-pools', role: 'tablist' })
    var pools = (state.data && state.data.pools) || []
    var cur = currentPool() || {}
    pools.forEach(function (p) {
      var on = p.id === cur.id
      var tile = el('button', {
        class: 'pool-tile' + (on ? ' is-on' : ''),
        type: 'button',
        role: 'tab',
        'aria-selected': on ? 'true' : 'false',
        'data-pool': p.id,
        title: p.name + '（可抽 ' + poolPlayableCount(p) + ' 张）',
      })
      if (p.coverCardUrl) {
        tile.appendChild(el('img', { referrerpolicy: 'no-referrer', class: 'pool-tile-img', src: p.coverCardUrl, alt: '', loading: 'lazy' }))
      } else {
        tile.appendChild(el('div', { class: 'pool-tile-noimg', text: '无封面' }))
      }
      tile.appendChild(el('span', { class: 'pool-tile-veil' }))
      tile.appendChild(el('span', { class: 'pool-tile-name', text: p.name }))
      tile.addEventListener('click', function () { selectPool(p.id) })
      col.appendChild(tile)
    })
    return col
  }

  /**
   * 卡池主视觉：多张时横向滑动轮播，每张展示 `bannerIntervalMs`（默认 3 秒）后
   * 滚到下一张，循环。
   *
   * 循环的做法：轨道里放**两份**幻灯片，滑到第二份时瞬间归位到第一份
   * （`transition: none` + 强制重排），视觉上就是无缝循环 ——
   * 比「滑到末尾再倒着滑回来」自然，也不用把图片真的复制两份。
   */
  function bannerTrack(urls, pool) {
    var count = urls.length
    // 记下「我是哪一代」：换板块（render）会让代号 +1，这之后我所有的回调都要闭嘴。
    var gen = bannerGen
    var box = el('div', { class: 'banner-box' })
    var track = el('div', { class: 'banner-track' })
    var slides = count > 1 ? urls.concat(urls) : urls.slice()
    slides.forEach(function (u, i) {
      // 第一张立刻加载，其余懒加载 —— 否则一进页面就把 7 张大图全拉下来
      var eager = i === 0 ? 'eager' : 'lazy'
      // 一张幻灯片 = 模糊底 + 完整卡面两层。
      // 横幅原图不一定正好是 16:9（「我与我的群友」那张是 3:2），用 cover 会把
      // 上下各裁掉约 9%。所以卡面用 contain 完整显示，左右多出来的两条用
      // **同一张图的模糊放大版**补满：不裁内容，也不是死板的黑边。
      // 正好 16:9 的图（常驻池那 7 张）contain 之后铺满整框，模糊层完全看不见，
      // 视觉上跟改之前一模一样。
      // 两层用同一个 URL —— 浏览器只会下载一次。
      track.appendChild(
        el('div', { class: 'banner-slide' }, [
          el('img', { referrerpolicy: 'no-referrer',
            class: 'banner-blur',
            src: u,
            alt: '',
            loading: eager,
          }),
          el('img', { referrerpolicy: 'no-referrer',
            class: 'banner-img',
            src: u,
            alt: (pool.name || '卡池') + ' 主视觉',
            loading: eager,
          }),
        ])
      )
    })
    box.appendChild(track)

    var idx = 0
    // 每张幻灯片占容器整整一屏（`.banner-slide { flex: 0 0 100% }`），
    // 所以位移就是「第几张 × 100%」—— 不需要知道一共几张。
    var step = 100

    function paint(i, animate) {
      track.style.transition = animate ? '' : 'none'
      track.style.transform = 'translateX(' + -(i * step) + '%)'
      if (!animate) {
        // 强制重排：否则「去掉过渡」和「设置位置」会被浏览器合并成一次动画，
        // 归位那一下就会看到明显的倒滑。
        void track.offsetWidth
        track.style.transition = ''
      }
      for (var d = 0; d < dots.children.length; d++) {
        dots.children[d].className = 'banner-dot' + (d === (i % count) ? ' is-on' : '')
      }
    }

    var dots = el('div', { class: 'banner-dots' })
    // 间隔**不在这里夹下限**：服务端的 normalizePool 已经保证 ≥1000ms。
    // 两处都夹的话客户端这层就是重复政策，而且会把测试用的短间隔一起夹掉
    //（表现成「轮播在测试里永远不前进」）。
    var interval = Number(pool.bannerIntervalMs) > 0 ? Number(pool.bannerIntervalMs) : 3000

    // 只认「我这一代」的回调：换板块会让代号 +1，旧回调就自动作废。
    // 用闭包读外层的 gen（不是拷贝），所以 schedule() 重新认领之后依然有效。
    function owned(fn) {
      return function () {
        if (gen !== bannerGen) return
        return fn()
      }
    }

    /**
     * 起一轮定时器。会先清掉在跑的那个（并 +1 代号、作废已排队的归位回调），
     * 再认领新代号 —— 不认领的话，下一次代号变化前自己就先被当成过期的了。
     */
    function schedule() {
      stopBannerTimer()
      gen = bannerGen
      // 读者的「减少动态效果」优先：不自动轮播，圆点仍然可以手动切
      if (count < 2 || prefersReducedMotion()) return
      bannerTimer = setInterval(
        owned(function () {
          // 标签页在后台时不推进，回来时不会一次跳好几张
          if (document.hidden) return
          idx++
          paint(idx, true)
          if (idx < count) return
          // 滑到「第二份的第一张」之后**先停表**：不停的话这 620ms 里
          // 还会继续 idx++，直接滑出轨道外面（轨道只有两份幻灯片）。
          stopBannerTimer()
          gen = bannerGen
          bannerWrapTimer = setTimeout(
            owned(function () {
              bannerWrapTimer = null
              idx = 0
              paint(0, false)
              schedule() // 归位后接着循环
            }),
            BANNER_SLIDE_MS,
          )
        }),
        interval,
      )
    }

    if (count > 1) {
      urls.forEach(function (u, i) {
        var dot = el('button', { class: 'banner-dot' + (i === 0 ? ' is-on' : ''), type: 'button' })
        dot.setAttribute('aria-label', '第 ' + (i + 1) + ' 张主视觉')
        dot.addEventListener('click', function () {
          idx = i
          paint(idx, true)
          schedule()
        })
        dots.appendChild(dot)
      })
      box.appendChild(dots)
    }

    paint(0, false)
    schedule()
    return box
  }

  // -------------------------------------------------------------------------
  // 图片缓存（Service Worker + Cache Storage）
  // -------------------------------------------------------------------------
  //
  // 站点在 GitHub Pages 上，而 Pages **不允许自定义响应头**，图片只拿到
  // `Cache-Control: max-age=600`（10 分钟就过期）。整套资源 12.5 MB，
  // 所以「每次打开都重新加载」是真实存在的问题。
  // Service Worker 是 Pages 上唯一能自己说了算的缓存层；这个区块提供
  // 「看缓存状态 / 一次抓好 / 清掉重来」三件事。

  /**
   * 缓存名必须与 page/sw.js 里的 CACHE_NAME 一致。
   *
   * v1 -> v2：跨域镜像的图（opaque 响应）也要进缓存，键的形状与命中判据都变了，
   * 直接沿用旧名字会让「同一条 URL 命中一条内容不对的旧记录」。改名之后
   * sw.js 的 activate 会把 `gacha-img-` 开头的旧缓存全删掉，读者不会两头都占。
   *
   * v2 -> v3：**镜像的 403 被当成图片缓存过**。Gitee 对带 Referer 的请求回
   * 403 JSON，而 no-cors 下这是个 opaque 响应，`res.type === 'opaque'` 就当作
   * 「缓存成功」存了起来 —— 于是那些读者**永远**看到坏图：请求根本没出网，
   * SW 直接把那条 403 当图片喂回 `<img>`。加了 no-referrer 之后必须把旧缓存
   * 整批作废（改名即可，sw.js 的 activate 会自动删掉 `gacha-img-` 开头的旧的），
   * 否则修了也没用 —— 他们命中的还是那条毒缓存。
   */
  var IMG_CACHE = 'gacha-img-v3'

  /**
   * 图片镜像基址（来自 `settings.imageMirror` / `settings.imageFallback`）。
   *
   * 只有**静态站**用得上：导出后 `imageUrl` 是 `assets/img/xxx` 这样的相对路径，
   * 而国内直连 GitHub Pages 经常慢到超时；换成 Gitee 之类的镜像就快得多。
   * 动态站的图片走 `api/image?src=…`，不匹配这个前缀，所以本机永远读磁盘。
   *
   * 返回值按优先级排列，只收 http(s) 的基址（写错了就当没填 —— 让图片回退到
   * 站内相对路径，而不是变成一串坏 URL）。
   *
   * ⚠️ 要读**传进来的那份数据**，不能读 `state.data`：`loadData()` 里
   * `state.data = normalizeSnapshot(inline)` 是**先算右边再赋值** ——
   * 在 normalizeSnapshot 里读 state.data 拿到的是上一份（首次启动时是 null），
   * 于是镜像一个都换不上，而且没有任何报错。
   */
  function mirrorBasesOf(data) {
    var s = (data && data.settings) || {}
    var out = []
    var push = function (v) {
      var raw = String(v == null ? '' : v).trim()
      if (!/^https?:\/\//i.test(raw)) return
      var base = raw.replace(/\/+$/, '') + '/'
      if (out.indexOf(base) >= 0) return
      out.push(base)
    }
    push(s.imageMirror)
    push(s.imageFallback)
    return out
  }

  /** 当前快照下的镜像基址（给抓图清单与测试用） */
  function mirrorBases() {
    return mirrorBasesOf(state.data)
  }

  /** 一个 `assets/img/...` 路径的完整候选链：镜像 -> 回退 -> 站内相对路径 */
  function imageChain(rel) {
    var bases = mirrorBases()
    var out = []
    for (var i = 0; i < bases.length; i++) out.push(bases[i] + rel)
    out.push(rel)
    return out
  }

  /**
   * 把快照里所有 `assets/img/...` 的字符串换成镜像地址（就地进行，幂等）。
   *
   * 为什么要**递归扫整份快照**而不是逐字段改：图片 URL 散落在卡面、卡池封面、
   * 横幅、首页封面、表情包、关注页配图/图标六处，逐一枚举必然漏 —— 而漏掉的那处
   * 会静默地继续走慢线路（或反过来：一处改了、别处没改，排查时完全看不出规律）。
   * 判据只有一条：**以 `assets/img/` 开头的字符串**。
   *
   * 幂等：改写后的字符串以 `https://…` 开头，不再匹配这个前缀，所以重复调用安全。
   */
  function mirrorAssetUrls(v, base) {
    if (Array.isArray(v)) {
      for (var i = 0; i < v.length; i++) v[i] = mirrorAssetUrls(v[i], base)
      return v
    }
    if (v && typeof v === 'object') {
      for (var k in v) {
        if (Object.prototype.hasOwnProperty.call(v, k)) v[k] = mirrorAssetUrls(v[k], base)
      }
      return v
    }
    return typeof v === 'string' && /^(?:\.\/)?assets\/img\//.test(v) ? base + v.replace(/^\.\//, '') : v
  }

  /**
   * 图片加载失败时的**多级回退**（镜像 -> 回退 -> 站内相对路径）。
   *
   * ⚠️ 两个细节都不能省：
   *   1. 只有**真的换了下一条地址**才 `stopPropagation()`。卡面自己挂着一个
   *      error 处理器（把「卡面读不到」写在卡上），而捕获阶段的 stopPropagation
   *      会让事件到不了它 —— 于是三次都失败时页面上**一点痕迹都没有**，
   *      这正是本项目最忌讳的那种失败。所以链走完了就放行，让卡面自己报错。
   *   2. 认不出来源的图（不是 `assets/img/...`）一律不碰。
   */
  function onImageError(event) {
    var img = event && event.target
    if (!img || String(img.tagName || '').toUpperCase() !== 'IMG') return
    var src = String(img.getAttribute('src') || '')
    var m = src.match(/(?:^|\/)(assets\/img\/[^/]+)$/)
    if (!m) return
    var chain = imageChain(m[1])
    var i = chain.indexOf(src)
    if (i < 0 || i >= chain.length - 1) return
    /**
     * 这条地址读不到 —— **顺手把它从图片缓存里删掉**。
     *
     * 为什么必须删：Service Worker 抓跨域镜像时用的是 no-cors，镜像回 404 时
     * 那个响应是 **opaque**（读不到状态码），而 SW 的判据写着「opaque 也算缓存成功」
     * —— 于是 404 的正文被当成图片存了进去。等镜像那边把新图同步过来之后，
     * 这位读者的 SW **仍然**拿那条毒缓存回话、图片继续报错、继续回退到慢线路，
     * 而他自己完全修不好（除非按「强制重新下载」或等缓存被顶掉）。
     * 删掉之后下一次访问就会重新走网络 —— 镜像好了就自动变快，不需要任何人做操作。
     * （`cache: 'reload'` 的强制下载不受影响：它本来就不读缓存。）
     */
    forgetCachedImage(src)
    img.setAttribute('src', chain[i + 1])
    if (event.stopPropagation) event.stopPropagation()
  }

  /**
   * 把一条地址从图片缓存里删掉（尽力而为）。
   *
   * 失败**不报错**：缓存是优化，删不掉也只是下次继续用旧的 —— 不该因为这件事
   * 让一个「图片显示不出来」的路径再多抛一个异常出来。
   */
  function forgetCachedImage(url) {
    if (!cacheSupported()) return
    try {
      caches
        .open(IMG_CACHE)
        .then(function (c) { return c.delete(absUrl(url)) })
        .catch(function () {})
    } catch (e) {}
  }

  function cacheSupported() {
    try {
      return typeof caches !== 'undefined' && !!caches && typeof caches.open === 'function'
    } catch (e) {
      return false
    }
  }

  /**
   * 注册 Service Worker。
   *
   * 失败**不算错**：缓存是优化，不是功能。不支持（老浏览器 / 非 https）时
   * 页面照常工作，只是每次重新下载图片。
   */
  function registerServiceWorker() {
    try {
      if (typeof navigator === 'undefined' || !navigator.serviceWorker) return
      var base = CFG.base || ''
      navigator.serviceWorker.register(base + '/sw.js', { scope: base + '/' }).catch(function (err) {
        console.warn('[gacha] 注册图片缓存失败（不影响使用）：' + ((err && err.message) || err))
      })
    } catch (e) {}
  }

  /**
   * 所有值得缓存的图片 URL（卡面 + 卡池封面 + 横幅 + 首页封面 + 表情包 + 关注页配图）。
   *
   * ⚠️ 这份清单必须覆盖**每一个会画图的字段**：漏掉的那类图在「加载图片」里不会被
   * 预抓，读者翻到它时还得现下 —— 而症状只是「有几张图偶尔慢」，很难联想到清单。
   * （关注页的扫码图就是这么补进来的。）
   */
  function allImageUrls() {
    var out = []
    var seen = {}
    var add = function (u) {
      if (u && !seen[u]) {
        seen[u] = 1
        out.push(u)
      }
    }
    var d = state.data || {}
    ;(d.cards || []).forEach(function (c) { add(c.imageUrl) })
    ;(d.pools || []).forEach(function (p) {
      add(p.coverCardUrl)
      ;(p.bannerUrls || []).forEach(add)
    })
    ;(d.links || []).forEach(function (ln) {
      add(ln.imageUrl)
      add(ln.iconUrl)
    })
    var s = d.settings || {}
    add(s.coverImageUrl)
    for (var k in s.emojiUrls || {}) add(s.emojiUrls[k])
    return out
  }

  /**
   * 把 URL 变成绝对的。
   *
   * Cache Storage 里的**钥匙永远是绝对 URL**（浏览器按文档地址解析过，
   * 且带上站点的子路径），而 `allImageUrls()` 给的是页面里那种相对地址
   * （`assets/img/x.jpg`）。不归一化就直接比字符串，会得出「158 张一张都没缓存」
   * —— 表现成按钮永远说「加载图片」，而且再按一次会把 158 张重新抓一遍。
   *
   * 兜底分支（没有 URL 构造器时）会退化成「原样返回」，于是两边形状可能对不上。
   * **它的失效方向是安全的**：只会把已经在本地的那几张判成「还缺」、多抓一次，
   * 绝不会反过来把没抓到的说成「已就绪」。
   */
  function absUrl(u) {
    try {
      var base = typeof location !== 'undefined' && location.href ? location.href : undefined
      return new URL(String(u), base).href
    } catch (e) {
      return String(u)
    }
  }

  /**
   * 这个 URL 是不是跨域的（镜像地址就是）。
   *
   * 判据用的是 `new URL` 而不是「字符串里有没有 http」：本机动态站的图片地址
   * 可能也是绝对的（`http://127.0.0.1:3080/gacha/api/image?…`），那种是同源、
   * 该带 same-origin 凭证。构造不出 URL 时按**同源**处理 —— 失效方向安全：
   * 顶多让一次抓取按老路子走，不会把同源的请求变成 no-cors。
   */
  function isCrossOrigin(u) {
    try {
      var base = typeof location !== 'undefined' && location.href ? location.href : undefined
      var abs = new URL(String(u), base)
      var here = new URL(base || abs.href)
      return abs.origin !== here.origin
    } catch (e) {
      return false
    }
  }

  function fmtBytes(n) {
    var b = Number(n) || 0
    if (b < 1024) return b + ' B'
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'
    return (b / 1048576).toFixed(1) + ' MB'
  }

  /**
   * 缓存里现在有什么。
   *
   * ⚠️ **跨域镜像的条目读不出字节数**：`fetch(..., {mode:'no-cors'})` 拿回来的是
   * opaque 响应，浏览器按设计不让你读它的 body —— `blob()` 会给出 0 字节。
   * 第一版把那些 0 直接累加，于是对话框写着「已缓存 270 张 / 0 B」，
   * 看起来像缓存坏了（用户就是这么报的）。所以这里**分开统计**：
   *   · `readable`：同源（或 CORS 可用）的条目，大小可信 -> 累加进 `bytes`
   *   · `opaque`  ：读不出大小的条目（镜像），只数个数，**绝不假装它是 0 字节**
   *
   * @returns {Promise<{count:number, bytes:number, readable:number, opaque:number}|null>}
   */
  function imgCacheStats() {
    if (!cacheSupported()) return Promise.resolve(null)
    return caches
      .open(IMG_CACHE)
      .then(function (cache) {
        return cache.keys().then(function (keys) {
          var jobs = keys.map(function (req) {
            return cache
              .match(req)
              .then(function (res) {
                if (!res) return { bytes: 0, opaque: true }
                // opaque 连类型都不可靠，先按类型判掉，免得白读一次 body
                if (res.type === 'opaque' || res.type === 'opaqueredirect') return { bytes: 0, opaque: true }
                return res
                  .clone()
                  .blob()
                  .then(function (b) {
                    // blob 读出来是 0 字节但响应本身不是空 —— 只可能是 opaque 的变体
                    return { bytes: b && b.size ? b.size : 0, opaque: !(b && b.size) }
                  })
                  .catch(function () { return { bytes: 0, opaque: true } })
              })
              .catch(function () { return { bytes: 0, opaque: true } })
          })
          return Promise.all(jobs).then(function (rows) {
            var total = 0
            var readable = 0
            var opaque = 0
            for (var i = 0; i < rows.length; i++) {
              if (rows[i].opaque) opaque++
              else {
                readable++
                total += rows[i].bytes
              }
            }
            return { count: keys.length, bytes: total, readable: readable, opaque: opaque }
          })
        })
      })
      .catch(function () { return null })
  }

  function clearImageCache() {
    if (!cacheSupported()) return Promise.resolve(false)
    return caches
      .keys()
      .then(function (names) {
        var mine = names.filter(function (n) { return n.indexOf('gacha-img-') === 0 })
        return Promise.all(mine.map(function (n) { return caches.delete(n) })).then(function () { return true })
      })
      .catch(function () { return false })
  }

  /**
   * 本地还缺哪些图（用绝对 URL 比对）。
   *
   * 只取一次 `keys()` 再在内存里比对，**不要**对 158 个 URL 各做一次
   * `cache.match()` —— 那是 158 次异步查询，只为把按钮文案改一下。
   */
  function missingImageUrls() {
    if (!cacheSupported()) return Promise.resolve(null)
    var urls = allImageUrls()
    return caches
      .open(IMG_CACHE)
      .then(function (cache) { return cache.keys() })
      .then(function (keys) {
        var have = {}
        for (var i = 0; i < keys.length; i++) have[absUrl(keys[i].url)] = 1
        return urls.filter(function (u) { return !have[absUrl(u)] })
      })
      .catch(function () { return null })
  }

  /**
   * 镜像站支不支持 CORS？**一次探测，整批复用。**
   *
   * 为什么值得探：跨域图片只有两种抓法，效果差别很大 ——
   *   · `mode: 'cors'`  -> 响应可读（能报出大小、类型），但镜像必须放行 CORS
   *   · `mode: 'no-cors'` -> 一定抓得到，但拿到的是 opaque：**读不出大小**，
   *     于是缓存对话框只能报「N 张（大小不可读）」（用户看到「0 B」就是这么来的）
   * 所以：先拿站点里第一张镜像图试一次 CORS，能行就整批走 CORS（大小可读），
   * 不行就整批 no-cors。只探一次 —— 每张都试会白白多出一倍的失败请求 + 一堆
   * Console 报错。
   *
   * 探测结果按 base 缓存在内存里（一次打开只探一次）。
   */
  var corsProbe = {}
  function mirrorCorsOk(sampleUrl) {
    var key = String(sampleUrl || '').replace(/[^/]*$/, '')
    if (corsProbe[key] !== undefined) return Promise.resolve(corsProbe[key])
    if (typeof fetch !== 'function') return Promise.resolve(false)
    // 探针也要 no-referrer：带 Referer 时 Gitee 一律 403，
    // 那会让这条探测**永远得出「镜像不支持 CORS」**的结论（403 在 no-cors 下读不出，
    // 在 cors 下直接被拒），于是整批退化成 no-cors、大小永远读不出来。
    return fetch(sampleUrl, { mode: 'cors', credentials: 'omit', cache: 'force-cache', referrerPolicy: 'no-referrer' })
      .then(function (res) {
        // 只有真的能读到内容才算「可用」：opaque 说明 CORS 没放行
        var ok = !!res && res.type !== 'opaque' && (res.ok || res.type === 'cors')
        corsProbe[key] = ok
        return ok
      })
      .catch(function () {
        corsProbe[key] = false
        return false
      })
  }

  /**
   * 把图片抓进缓存。
   *
   * **限并发 4**：一次丢出 130+ 个请求会把带宽抢光（页面自己的请求也会被挤掉），
   * 并发太高在移动端还容易整批失败。逐张推进并回报进度，读者才知道要等多久。
   *
   * `opts.force === true`（「强制重新下载」）时：
   *   · 不跳过已有的，每张都重抓
   *   · 请求带上 `cache: 'reload'`，绕过 HTTP 缓存**也绕过我们自己的 SW**
   *     （`page/sw.js` 认这个标记）。不带的话 SW 会拿旧缓存直接回话，
   *     这个按钮就只是看着像在干活。
   *
   * 返回值里的 `checked` 是「这一轮实际要抓几张」（0 表示本地已经齐了），
   * `skipped` 是跳过了几张。调用方靠它区分「干完了」和「本来就不用干」。
   */
  function cacheAllImages(onProgress, opts) {
    opts = opts || {}
    var force = !!opts.force
    if (!cacheSupported()) return Promise.resolve({ ok: false, error: '这个浏览器不支持 Cache Storage' })
    var urls = allImageUrls()
    if (!urls.length) return Promise.resolve({ ok: true, done: 0, total: 0, checked: 0, skipped: 0, failed: 0 })
    // 跨域的那些：先探一次 CORS，决定整批用哪种模式
    var crossSamples = urls.filter(isCrossOrigin)
    var corsReady = crossSamples.length ? mirrorCorsOk(crossSamples[0]) : Promise.resolve(false)
    return corsReady.then(function (useCors) {
      return caches
        .open(IMG_CACHE)
        .then(function (cache) {
          var pick = force
            ? Promise.resolve(urls.slice())
            : Promise.all(
                urls.map(function (u) {
                  return cache
                    .match(absUrl(u))
                    .then(function (r) { return r ? null : u })
                    .catch(function () { return u })
                })
              ).then(function (miss) {
                return miss.filter(Boolean)
              })
          return pick.then(function (todo) {
            if (!todo.length) {
              return { ok: true, done: 0, total: urls.length, checked: 0, skipped: urls.length, failed: 0, cors: useCors }
            }
            var idx = 0
            var done = 0
            var failed = 0
            var CONCURRENCY = 4
            var worker = function () {
              if (idx >= todo.length) return Promise.resolve()
              var u = todo[idx++]
              /**
               * ⚠️ `referrerPolicy: 'no-referrer'` 是**必须的**，不是优化：
               * Gitee 的镜像对带 Referer 的请求直接 403（`invalid Referer header`），
               * 而 `fetch` 默认会带上来源页。少了这一行，「缓存全部图片」抓回来的
               * 是一堆 403 —— no-cors 下还是 opaque，会被**当成缓存成功**存进去，
               * 之后显示的就是坏图（而且 SW 那份缓存同样会被污染）。
               */
              var init = { credentials: 'same-origin', referrerPolicy: 'no-referrer' }
              var cross = isCrossOrigin(u)
              if (cross) {
                // 跨域镜像：能 CORS 就 CORS（大小可读），否则退 no-cors（拿 opaque，
                // 照样能缓存、能显示，只是读不出大小 —— 见 imgCacheStats）。
                // 不带凭证是对的：公开镜像不需要 cookie，带上反而会变成非简单请求。
                init.mode = useCors ? 'cors' : 'no-cors'
                init.credentials = 'omit'
              }
              if (force) init.cache = 'reload'
              return fetch(u, init)
                .then(function (res) {
                  // opaque 也算成功：Cache Storage 允许存不透明响应，
                  // 这正是「跨域图片也能一次抓好、之后离线可见」的依据。
                  if (res && (res.ok || res.type === 'opaque')) {
                    return cache.put(absUrl(u), res.clone()).then(function () { done++ })
                  }
                  failed++
                  return null
                })
                .catch(function () {
                  failed++
                  return null
                })
                .then(function () {
                if (onProgress) onProgress(done + failed, todo.length)
                return worker()
              })
          }
          var workers = []
          for (var i = 0; i < CONCURRENCY; i++) workers.push(worker())
          return Promise.all(workers).then(function () {
            return {
              ok: true,
              done: done,
              total: urls.length,
              checked: todo.length,
              skipped: urls.length - todo.length,
              failed: failed,
              cors: useCors,
            }
          })
        })
        })
        .catch(function (err) {
          return { ok: false, error: (err && err.message) || '缓存失败' }
        })
    })
  }

  var cacheBusy = false

  /**
   * 顶栏那个「加载图片」按钮的文案。
   *
   * 三种状态：不支持 / 还差 N 张 / 全在本地。滚动到哪都看得见 ——
   * 「先抓好图」这个动作必须在读者决定「我现在要开始看图了」的那一刻够得着，
   * 而不是要先滑到页脚。
   */
  function paintCacheLoadButton() {
    var btn = state.els.cacheLoad
    if (!btn) return
    if (cacheBusy) return // 抓取期间文案归 loadAllImages 管，别抢
    if (!cacheSupported()) {
      btn.textContent = '图片不能缓存'
      btn.disabled = true
      btn.title = '这个浏览器不支持 Cache Storage，图片每次打开都会重新下载'
      return
    }
    btn.disabled = false
    var urls = allImageUrls()
    if (!urls.length) {
      btn.textContent = '加载图片'
      return
    }
    missingImageUrls().then(function (miss) {
      // 异步回来时状态可能已经变了（读者又按了一次，或者换了板块）
      if (cacheBusy || !btn) return
      if (!miss) {
        btn.textContent = '加载图片'
        return
      }
      if (!miss.length) {
        btn.textContent = '图片已就绪'
        btn.className = 'btn ghost small cache-load is-done'
        btn.title = '本站 ' + urls.length + ' 张图片都在本地，打开就是本地读取'
      } else {
        btn.textContent = miss.length === urls.length ? '加载图片' : '加载图片 ' + (urls.length - miss.length) + '/' + urls.length
        btn.className = 'btn ghost small cache-load'
        btn.title = '还有 ' + miss.length + ' 张图片不在本地，点一下全部抓好'
      }
    })
  }

  /**
   * 一键加载：把还没在本地的图全部抓好，进度就地写在按钮上。
   *
   * 不弹对话框 —— 这个动作的全部意义就是「按一下，等一会儿」。
   * 明细（状态 / 强制重新下载 / 清理）在页脚的「缓存设置」里。
   */
  function loadAllImages(force) {
    if (cacheBusy) return
    var btn = state.els.cacheLoad
    if (!cacheSupported()) {
      toast('这个浏览器不支持本地图片缓存，图片每次都会重新下载', 'error')
      return
    }
    cacheBusy = true
    if (btn) {
      btn.disabled = true
      btn.textContent = '准备中…'
    }
    cacheAllImages(
      function (n, total) {
        if (btn) btn.textContent = (force ? '重下中 ' : '加载中 ') + n + '/' + total
      },
      { force: force }
    ).then(function (r) {
      cacheBusy = false
      if (btn) btn.disabled = false
      if (!r.ok) {
        if (btn) btn.textContent = '加载图片'
        toast('图片加载失败：' + r.error, 'error')
        return
      }
      if (!r.checked) {
        // 本地已经齐了：绝不再把 158 张重新跑一遍
        toast('本地已有全部 ' + r.total + ' 张图片，不用重新下载', 'ok')
      } else {
        toast(
          r.failed
            ? '加载完成，但有 ' + r.failed + ' 张失败'
            : force
              ? '已重新下载 ' + r.done + ' 张图片'
              : '全部 ' + r.done + ' 张图片已存到本地，下次打开不用重新下载',
          r.failed ? 'error' : 'ok'
        )
      }
      paintCacheLoadButton()
      if (state.els.cacheDialog && state.els.cacheDialog.open) paintCacheDialog()
    })
  }

  function openCacheDialog() {
    var dlg = state.els.cacheDialog
    if (!dlg) return
    paintCacheDialog()
    showModal(dlg)
  }

  function paintCacheDialog() {
    var stat = state.els.cacheStat
    var hint = state.els.cacheHint
    var fill = state.els.cacheFill
    var clear = state.els.cacheClear
    var forceBtn = state.els.cacheForce
    var total = allImageUrls().length
    if (!cacheSupported()) {
      if (stat) stat.textContent = '这个浏览器不支持 Cache Storage —— 图片每次都会重新下载。'
      if (fill) fill.disabled = true
      if (clear) clear.disabled = true
      if (forceBtn) forceBtn.disabled = true
      if (hint) hint.textContent = '换一个现代浏览器（Chrome / Edge / Firefox / Safari）就能用上图片缓存。'
      return
    }
    if (stat) stat.textContent = '读取中…'
    if (hint) hint.textContent = '一次抓好这 ' + total + ' 张图，之后打开就是本地读取。抓取期间别关页面。'
    imgCacheStats().then(function (s) {
      if (!stat) return
      if (!s) {
        stat.textContent = '读不到缓存状态（浏览器可能禁用了存储）。'
        return
      }
      stat.textContent = cacheStatLine(s, total)
    })
  }

  /**
   * 状态行那句话。三种情况分开写，**绝不把「读不出大小」说成「0 字节」**：
   *   · 全是同源（没有镜像）：照旧报大小
   *   · 有镜像条目：数量照报，读不出大小的那些单独说一句
   *   · 只有镜像条目：只报数量 + 说明
   */
  function cacheStatLine(s, total) {
    var head = '已缓存 ' + s.count + ' / ' + total + ' 张'
    if (!s.opaque) return head + '（' + fmtBytes(s.bytes) + '）'
    if (!s.readable) {
      return head + '（其中 ' + s.opaque + ' 张来自镜像；浏览器按安全策略不允许读取它们的大小）'
    }
    return (
      head +
      '：同源 ' + s.readable + ' 张 ' + fmtBytes(s.bytes) +
      ' + 镜像 ' + s.opaque + ' 张（大小不可读）'
    )
  }

  function doCacheAll() {
    runCacheFromDialog(false)
  }

  function doCacheForce() {
    runCacheFromDialog(true)
  }

  /**
   * 对话框里的「缓存全部图片 / 强制重新下载」。
   *
   * 与顶栏一键按钮共用 `cacheAllImages`（同一份规则）；
   * 区别只有：这里的结果写在状态行与 toast 上，按钮在跑的时候要禁用。
   */
  function runCacheFromDialog(force) {
    if (cacheBusy) return
    cacheBusy = true
    var stat = state.els.cacheStat
    var fill = state.els.cacheFill
    var forceBtn = state.els.cacheForce
    if (fill) fill.disabled = true
    if (forceBtn) forceBtn.disabled = true
    if (stat) stat.textContent = force ? '强制重新下载…' : '开始缓存…'
    cacheAllImages(
      function (n, total) {
        if (stat) stat.textContent = (force ? '重新下载 ' : '缓存中 ') + n + ' / ' + total + ' …'
      },
      { force: force }
    ).then(function (r) {
      cacheBusy = false
      if (fill) fill.disabled = false
      if (forceBtn) forceBtn.disabled = false
      if (!r.ok) {
        if (stat) stat.textContent = '缓存失败：' + r.error
        return
      }
      // 状态行归「数字」，结果归 toast。
      // ⚠️ 不要再往 stat 里写「缓存完成：5 / 5 张」—— paintCacheDialog() 紧接着就会
      // 用「已缓存 5 张 / 55 B」覆盖掉它，两条路径抢同一个文本节点，后写的赢。
      // （这正是最初那版的行为：完成提示一闪而过，测试也抓不到。）
      paintCacheDialog()
      paintCacheLoadButton()
      if (!r.checked) {
        toast('本地已有全部 ' + r.total + ' 张图片，不用重新下载', 'ok')
        return
      }
      toast(
        r.failed
          ? '缓存完成，但有 ' + r.failed + ' 张失败'
          : force
            ? '已重新下载 ' + r.done + ' 张图片'
            : '图片已缓存，下次打开不用重新下载',
        r.failed ? 'error' : 'ok'
      )
    })
  }

  function doClearCache() {
    if (cacheBusy) return
    if (!window.confirm('清掉本机缓存的图片？下次打开会重新下载（不会影响抽卡记录）。')) return
    clearImageCache().then(function (ok) {
      // 同上：清空的结果用 toast 说，状态行交给 paintCacheDialog 显示准确数字。
      if (ok) {
        paintCacheDialog()
        paintCacheLoadButton()
      } else if (state.els.cacheStat) state.els.cacheStat.textContent = '清理失败（浏览器可能禁用了存储）。'
      toast(ok ? '图片缓存已清空' : '清理失败', ok ? 'ok' : 'error')
    })
  }

  function rarityChip(rarityId, opts) {
    opts = opts || {}
    var r = rarityById(rarityId)
    var chip = el('span', { class: 'chip' + (opts.big ? ' chip-big' : ''), text: r ? r.label || r.id : rarityId || '?' })
    // 颜色由服务端数据给（rarity.color）。CSP 允许 CSSOM，所以这里用它而不是 style 属性
    chip.style.color = r && r.color ? r.color : '#8b8b99'
    chip.style.borderColor = r && r.color ? r.color : '#8b8b99'
    if (!r) chip.title = '这个稀有度不在档位表里：' + rarityId
    return chip
  }

  /** 现在能不能改内容：静态站永远不能（那是「没有后端」，不是「没输秘钥」） */
  function canEdit() {
    return !READONLY && state.unlocked
  }

  /**
   * 图鉴「动态卡面」模式下，格子里那些 `<video>` 的可见性管理。
   *
   * 用户 2026-09-19：「图鉴页面可以切换动态卡牌与静态卡牌（只对有动态版本的
   * 卡牌生效）」。字面做法就是把格子换成视频 —— 但图鉴一页有两百多张卡，
   * 全页同时解码几十路视频是**必然的卡死**（这是本项目写死的性能红线）。
   * 所以规矩是：
   *   · 只有**已解锁 HR**、且配了动态卡面的卡才建 `<video>`（没解锁的连节点都没有）
   *   · 建出来的视频**默认不播**（poster 顶着静态卡面），进视口才播、出视口就停
   *   · 同时在播的**最多 `GRID_VIDEO_MAX` 路**，超了就顶掉最早进来的那一路
   *     （页面被缩得很小、一屏几十格时，这条才真正生效）
   *   · 没有 `IntersectionObserver`（老浏览器 / 测试替身）时**一个都不播** ——
   *     判断不了可见性就不赌，格子上仍是静态卡面 + 角标
   */
  var GRID_VIDEO_MAX = 12
  var gridVideos = { io: null, playing: [], warned: false }

  function gridVideoObserver() {
    if (gridVideos.io) return gridVideos.io
    var IO = window.IntersectionObserver
    if (typeof IO !== 'function') {
      if (!gridVideos.warned) {
        gridVideos.warned = true
        console.warn('[gacha] 这个浏览器没有 IntersectionObserver：图鉴的动态卡面只显示静态帧（大图里照常播）')
      }
      return null
    }
    gridVideos.io = new IO(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i]
        if (!e || !e.target) continue
        if (e.isIntersecting) startGridVideo(e.target)
        else stopGridVideo(e.target)
      }
    }, { rootMargin: '160px' })
    return gridVideos.io
  }

  /** 停一路：暂停 + 从「正在播」名单里摘掉（重复调用是安全的） */
  function stopGridVideo(v) {
    if (!v) return
    var i = gridVideos.playing.indexOf(v)
    if (i >= 0) gridVideos.playing.splice(i, 1)
    try {
      v.pause()
    } catch (e) {}
  }

  /** 播一路：超过上限时先顶掉最早进来的那一路（FIFO） */
  function startGridVideo(v) {
    if (!v || gridVideos.playing.indexOf(v) >= 0) return
    while (gridVideos.playing.length >= GRID_VIDEO_MAX) stopGridVideo(gridVideos.playing[0])
    gridVideos.playing.push(v)
    v.muted = true
    v.loop = true
    v.playsInline = true
    var p = v.play && v.play()
    // 自动播放被浏览器拦下是常态（策略差异）：停了就是一张海报，不报错刷屏
    if (p && typeof p.catch === 'function') p.catch(function () {})
  }

  /**
   * 把格子里的视频登记进来。
   *
   * ⚠️ 每次整页 render 都会重建这些节点，所以必须先 `resetGridVideos()` ——
   * 不重置的话观察器还盯着**已经被扔掉**的节点，既漏内存又让「同时在播」的
   * 计数永远只增不减（最后变成谁都不播）。
   */
  function registerGridVideo(v) {
    var io = gridVideoObserver()
    stopGridVideo(v)
    if (io && io.observe) io.observe(v)
    return v
  }

  function resetGridVideos() {
    for (var i = gridVideos.playing.length - 1; i >= 0; i--) stopGridVideo(gridVideos.playing[i])
    gridVideos.playing = []
    if (gridVideos.io && gridVideos.io.disconnect) {
      try {
        gridVideos.io.disconnect()
      } catch (e) {}
      gridVideos.io = null
    }
  }

  /** 这张卡的动态卡面解锁了没有（HR 是状态位，见 draw.js 的 hrUnlockAfter） */
  function hrUnlocked(cardId) {
    var g = G()
    if (g && typeof g.hasHr === 'function') return g.hasHr(player(), cardId)
    // 拿不到规则模块时读原始字段（**不能**当成「都解锁了」）
    var hr = (player() || {}).hr || {}
    return !!hr[cardId]
  }

  /** 现在有哪几张卡配了动态卡面（图鉴顶部据此解释那个开关） */
  function hrCards() {
    return (state.data.cards || []).filter(function (c) {
      return !c.hidden && c.dynamicUrl
    })
  }

  /** 图鉴是不是「动态卡面」模式（读者偏好，存在本机） */
  function dynamicMode() {
    return !!lsGet(LS.dynamic, false)
  }

  /**
   * HR 碎片的键与总数。
   *
   * 键优先问 `page/draw.js`（浏览器里它是唯一真源），拿不到时用兜底 ——
   * 与 shards.js 的 `hrShardKey()` 同一条纪律，三份拷贝由 test-plugin.mjs §5f 钉住。
   */
  var HR_SHARD_KEY = (function () {
    var g = G()
    return g && typeof g.HR_SHARD_RARITY === 'string' && g.HR_SHARD_RARITY ? g.HR_SHARD_RARITY : 'HR'
  })()

  function hrShardTotal() {
    return Math.max(0, Number((shards() || {})[HR_SHARD_KEY] || 0))
  }

  /**
   * 卡面。2:3 竖版，图片 object-fit: contain（美术图不能裁）。
   *
   * 四条硬要求：
   *   1. 占位层先留着：图没加载出来时它是内容，不是空白
   *   2. 失败要有原因：把「哪个文件读不到」写在卡上
   *   3. 占位里显示角色名与稀有度，所以没有美术资源时页面依然是可用的
   *   4. 隐藏条目对读者不可见，对已解锁的人带角标
   *
   * `opts.dynamic`（图鉴开了动态模式 + 这张卡解锁了 HR）时用 `<video>` 替掉静态图：
   * poster 仍是静态卡面，所以「还没就绪 / 不播」时看到的就是原来那张图。
   */
  function cardFigure(card, opts) {
    opts = opts || {}
    var finish = foilId(opts.finish)
    var box = el('div', {
      class:
        'card' +
        (opts.size ? ' card-' + opts.size : '') +
        (finish ? ' card-foil card-foil-' + finish : '') +
        (opts.inspect ? ' card-inspect' : ''),
    })
    if (finish) box.setAttribute('data-finish', finish)

    var r = rarityById(card.rarity)
    if (r && r.color) box.style.setProperty('--rarity-color', r.color)
    // 逐卡比例覆盖（纪念卡是 3:2 横版，其余卡走全局的 2:3）。
    // 走 CSSOM 而不是内联 style 属性 —— CSP 会静默丢掉后者。
    if (card.ratio) box.style.setProperty('--card-ratio', card.ratio)

    var face = el('div', { class: 'card-face' })
    // 占位层（永远先放）
    face.appendChild(
      el('div', { class: 'card-placeholder' }, [
        el('div', { class: 'card-placeholder-glyph', text: '✦' }),
        el('div', { class: 'card-placeholder-name', text: card.name || '未命名' }),
      ])
    )

    if (opts.dynamic && card.dynamicUrl) {
      /**
       * 图鉴「动态卡面」模式：这一格用 `<video>`（poster 仍是静态卡面）。
       *
       * 自动播放的三个前提必须**在属性（property）上也设一遍** —— 与 page.html 里
       * 大图那个 `<video>` 不同，这个是动态创建的，HTML 上没地方声明它们；
       * 少一个的症状是「视频静静地停在第一帧」，页面上不会有任何报错。
       * `preload="metadata"`：先只取头信息，滚到哪儿才播哪儿。
       */
      var v = el('video', {
        class: 'card-video',
        src: card.dynamicUrl,
        poster: card.imageUrl || '',
        preload: 'metadata',
        draggable: 'false',
        'aria-label': (card.name || '卡面') + ' 动态卡面',
      })
      v.muted = true
      v.loop = true
      v.playsInline = true
      v.setAttribute('muted', '')
      v.setAttribute('loop', '')
      v.setAttribute('playsinline', '')
      // 读不到视频时**退回静态图**（与 card-img 那条路一样：绝不静默留一块空白）
      v.addEventListener('error', function () {
        v.hidden = true
        if (opts.onVideoError) opts.onVideoError(card)
      })
      face.appendChild(registerGridVideo(v))
    } else if (card.imageUrl) {
      // ⚠️ draggable="false"：浏览器默认把 <img> 当成可拖拽对象，一按住拖动就会
      // 开始**原生图片拖拽**（半透明残影 + 禁止光标），我们的 pointermove 也就断了。
      // 大图里的「按住拖动 = 换角度看闪卡」正是被这件事抢走的。
      // 属性值必须是字符串 'false' —— el() 会把布尔 false 当成「不设置」跳过。
      var img = el('img', { referrerpolicy: 'no-referrer', class: 'card-img', src: card.imageUrl, alt: card.name || '卡面', loading: 'lazy', draggable: 'false' })
      img.addEventListener('error', function () {
        // 绝不静默：图读不到要把原因和可点开的地址挂在卡上
        img.hidden = true
        var url = card.imageUrl
        face.appendChild(
          el('div', { class: 'card-error' }, [
            el('div', { class: 'card-error-title', text: '卡面读不到' }),
            el('div', { class: 'card-error-file', text: card.image || '(未填图片)' }),
            el('a', { class: 'card-error-link', href: url, target: '_blank', rel: 'noopener', text: '打开这个地址看原因' }),
          ])
        )
        announce('卡面读不到：' + (card.image || '(未填图片)'))
      })
      face.appendChild(img)
    } else {
      // 没有填图片 —— 这是「还没配」，不是「读不到」，两者要分清
      face.appendChild(
        el('div', { class: 'card-nofile' }, [
          el('div', { text: canEdit() ? '还没有卡面图' : '暂无卡面' }),
          canEdit()
            ? el('div', { class: 'card-nofile-hint', text: '点「编辑」填图片，或到后台扫描卡池' })
            : null,
        ])
      )
    }

    // 特殊工艺的光效层：纯装饰，卡图**不动**。
    // 位置由 --pointer-x/y 等变量驱动（CSP 下不能用内联 style，所以走 CSSOM/类名）。
    if (finish) {
      face.appendChild(el('span', { class: 'foil-shine', 'aria-hidden': 'true' }))
      // 红碎多一层「不规则碎块」（在光下变彩色的那些三角/四边形）
      if (finish === 'shatter') face.appendChild(el('span', { class: 'foil-shards', 'aria-hidden': 'true' }))
      face.appendChild(el('span', { class: 'foil-glare', 'aria-hidden': 'true' }))
      if (finish === 'shatter') face.appendChild(el('span', { class: 'foil-sparks', 'aria-hidden': 'true' }))
      // 小图上没人会去悬停/拖动，所以**自动**每 5 秒扫一道条形光（用户要求），
      // 让图鉴、抽卡结果、抽卡动画里的闪卡自己把质感显出来。
      // 大图（.card-dialog-card）不走这条路：那里是拖动检视，光由手指给。
      face.appendChild(el('span', { class: 'foil-sweep', 'aria-hidden': 'true' }))
    }

    /**
     * 动态卡面（HR）的角标。
     *
     * 网格与结果区**不播视频**（两百多张卡各挂一个 `<video>` = 浏览器同时解码
     * 几十路视频，必然卡死），所以这里只标一个「动」字：读者知道这张卡点开大图
     * 会动，大图里才真的用 `<video>`（见 paintDialogMedia）。
     */
    if (card.dynamicUrl) {
      face.appendChild(
        el('span', {
          class: 'badge-hr',
          text: '动',
          title: '这张有动态卡面（HR）—— 点开大图会动起来',
          'aria-label': '动态卡面',
        })
      )
    }
    box.appendChild(face)

    // 卡面下方：角色名 + 稀有度角标
    var foot = el('div', { class: 'card-foot' }, [
      el('div', { class: 'card-name', text: card.name || '未命名' }),
      rarityChip(card.rarity),
    ])

    if (opts.count) {
      foot.appendChild(el('span', { class: 'card-count', text: '×' + opts.count, title: '已拥有 ' + opts.count + ' 张' }))
    }
    box.appendChild(foot)

    if (card.hidden) box.appendChild(el('div', { class: 'card-flag', text: '已隐藏' }))
    if (!card.rarityKnown) {
      box.appendChild(
        el('div', { class: 'card-flag card-flag-warn', text: '稀有度未设置', title: '稀有度「' + card.rarity + '」不在档位表里' })
      )
    }
    return box
  }

  function sectionHead(title, desc, extra) {
    return el('div', { class: 'sec-head' }, [
      el('div', {}, [el('h2', { class: 'sec-title', text: title }), desc ? el('p', { class: 'sec-desc', text: desc }) : null]),
      extra ? el('div', { class: 'sec-extra' }, extra) : null,
    ])
  }

  function emptyBox(title, lines, action) {
    return el('div', { class: 'empty' }, [
      el('div', { class: 'empty-title', text: title }),
      el(
        'ul',
        { class: 'empty-lines' },
        (lines || []).map(function (l) {
          return el('li', { text: l })
        })
      ),
      action || null,
    ])
  }

  // -------------------------------------------------------------------------
  // ⑤ 抽卡
  // -------------------------------------------------------------------------

  function G() {
    return window.Gacha
  }

  /**
   * 执行一次抽卡。
   *
   * 记账有三种情况，别混：
   *   · 动态站 + 已解锁 → 结果同步到服务端（data.json），页面刷新不丢
   *   · 动态站 + 未解锁 → 抽卡状态本来就不该写服务端，落 localStorage
   *   · 静态站（GitHub Pages）→ 只能落 localStorage
   */
  function runDraw(count) {
    var data = state.data
    if (!data) {
      toast('卡池数据还没加载好', 'error')
      return
    }
    var g = G()
    if (!g) {
      toast('draw.js 没有加载成功，抽卡无法进行（看 Console 的报错）', 'error')
      return
    }
    var pool = currentPool()
    if (!pool) {
      toast('没有任何卡池可抽', 'error')
      return
    }

    // 先做一次预检：把「为什么抽不了」直接说出来，而不是点下去没反应
    var probs = g.issues(data, pool.id)
    if (probs.length) {
      renderDrawProblem(probs, pool)
      toast('卡池还没配好，抽不了（页面里有原因）', 'error')
      return
    }

    var on = dreamOn(pool)
    var price = drawPrice(count, pool)
    var p = player()
    var have = price.currency === 'tickets' ? tickets() : points()
    if (price.amount > 0 && have < price.amount) {
      toast(
        price.name + '不够：需要 ' + price.amount + '，现有 ' + have +
          (on ? '（追梦池花抽卡券，到「碎片兑换」用碎片换）' : '（点数每天登陆会送）'),
        'error'
      )
      return
    }
    var cost = price.amount

    // ⚠️ 这里必须传 dataWithState() 而不是 state.data：SP 保底要看**已拥有**哪些卡，
    // 而静态站的快照里没有 player（状态在 localStorage 里）——
    // 传 state.data 会让保底永远算成「一张都没拥有」，开关永远打不开。
    var result = g.drawMany(dataWithState(), {
      poolId: pool.id,
      count: count,
      dream: on,
      dreamSteps: dreamSteps(pool.id),
    })
    if (!result.ok) {
      toast('抽卡失败：' + result.error, 'error')
      renderDrawProblem([result.error], pool)
      return
    }

    // --- 结算：重复卡 -> 碎片 ---------------------------------------------
    // 用与「服务端权威兑换」完全同一份规则（page/shards.js 的 settleDraw）。
    //
    // ⚠️ 判定「重复」必须看到**真正的**状态：静态站与未解锁的动态站里，
    // 服务端快照是没有 player 的，实际状态在 localStorage。直接传 state.data 会让
    // 第二次抽同一张卡仍然算「新卡」—— 重复卡永远拿不到碎片，页面上还显示 NEW。
    // dataWithState() 就是为这件事存在的（把当前状态折进快照）。
    var sh = window.GachaShards
    if (!sh) {
      toast('shards.js 没有加载成功，碎片结算无法进行（看 Console 的报错）', 'error')
      return
    }
    // 追梦池的重复卡**不返碎片、改返点数**（用户要求：不论品质 1 点，
    // 平闪/全闪/红碎额外 +1/+2/+5）—— 规则在 shards.js，两条路共用同一份。
    // 红碎补偿（重复红碎 -> 返券 + 攒欠条）也在这份结算里，规则本体在 draw.js。
    var settle = sh.settleDraw(dataWithState(), result.results, { reward: on ? 'points' : 'shards', poolId: pool.id })
    if (settle.shatterCompMissing) {
      console.warn('[gacha] 红碎补偿没有结算：draw.js 的 shatterCompAfter 不可用')
    }

    // 保底计数（自上次出最高档起算）
    var topId = topRarity() ? topRarity().id : ''
    var sinceTop = Number(p.sinceTop || 0)
    for (var i = 0; i < result.results.length; i++) {
      sinceTop += 1
      if (result.results[i].rarityId === topId) sinceTop = 0
    }

    // --- 落本地（静态站靠它；动态站也写一份，作为同步失败时的兜底） --------
    var local = localState()
    // 花的是点数还是券，由 priceFor 说了算（普通池点数、追梦池抽卡券）
    if (price.currency === 'tickets') {
      local.currency = Math.max(0, Number(local.currency || 0) - cost)
    } else {
      local.points = Math.max(0, Number(local.points || 0) - cost)
    }
    // 追梦池的重复卡返点数
    if (settle.gainedPoints > 0) {
      local.points = Math.max(0, Number(local.points || 0)) + Number(settle.gainedPoints)
    }
    // 红碎补偿返还的抽卡券（用户要求：抽到已有的红碎返 10 张券）
    if (Number(settle.tickets || 0) > 0) {
      local.currency = Math.max(0, Number(local.currency || 0)) + Number(settle.tickets)
    }
    // 红碎补偿的欠条：**三张表要合起来看**。
    //   · draw.js 的 result.shatterPity  = 抽之前那张表 **减去**这一轮兑现掉的
    //   · shards.js 的 settle.shatterConverted = 兑现不了、被**折成券**的那些（要从表里删掉）
    //   · shards.js 的 settle.shatterArmed     = 这一轮**新攒**的
    // 少合一边都会出错：只取 settle 会出现「补过了却还欠着」；只取 draw 则新攒的
    // 记不上、折过价的还留着（那正是「程序卡死」的样子）。第一版就漏了折价这一边。
    var pityNext = result.shatterPity ? Object.assign({}, result.shatterPity) : Object.assign({}, local.shatterPity || {})
    var convertedNow = settle.shatterConverted || []
    for (var ci = 0; ci < convertedNow.length; ci++) delete pityNext[convertedNow[ci]]
    var armedNow = settle.shatterArmed || {}
    for (var ak in armedNow) {
      if (Object.prototype.hasOwnProperty.call(armedNow, ak)) {
        pityNext[ak] = Number(pityNext[ak] || 0) + Number(armedNow[ak] || 0)
      }
    }
    local.shatterPity = pityNext
    local.pulls = Number(local.pulls || 0) + result.results.length
    local.sinceTop = sinceTop
    local.owned = settle.owned
    local.shards = settle.shards
    local.duplicates = Number(local.duplicates || 0) + settle.duplicates

    // SP 保底开关：结论由 draw.js 的纯函数给出（与服务端同一份规则）。
    // 在**本池**上开或关，别的池子不受影响。
    var spAfter = result.spPity || { active: false, changed: false }
    local.spPity = Object.assign({}, local.spPity || {})
    if (spAfter.active) local.spPity[pool.id] = true
    else delete local.spPity[pool.id]

    /*
     * UR 保底：结论同样由 draw.js 的纯函数给出（用户 2026-09-22）。
     * 与服务端共享同一条规则，但与 spPity 有一个区别：`result.urPity.table` 是
     * **整张表**（含别的池子）—— 直接落盘即可，别在这里重新拼一张表出来
     * （拼的话就又出现了「两份实现」）。
     */
    var urAfter = result.urPity || { active: false, changed: false, table: null }
    local.urPity = urAfter.table && typeof urAfter.table === 'object'
      ? Object.assign({}, urAfter.table)
      : Object.assign({}, local.urPity || {})

    // 特殊工艺：把这一轮抽到的工艺记进「已拥有」。合并规则也在 draw.js 里
    //（foilsAfter 是纯函数），服务端同步时用的是同一份。
    var G2 = G()
    local.foils =
      G2 && G2.foilsAfter
        ? G2.foilsAfter(local.foils || {}, result.results)
        : Object.assign({}, local.foils || {})

    // 追梦计数：结论同样由 draw.js 的纯函数给出（抽到 SP 归零，否则 +1、封顶）
    var dreamAfterSteps = null
    if (on) {
      local.dream = Object.assign({}, local.dream || {})
      dreamAfterSteps = result.dreamSteps === null || result.dreamSteps === undefined
        ? dreamSteps(pool.id)
        : Number(result.dreamSteps)
      if (dreamAfterSteps > 0) local.dream[pool.id] = dreamAfterSteps
      else delete local.dream[pool.id]
    }

    var at = Date.now()
    var rows = settle.perCard.map(function (pc, idx) {
      return {
        cardId: pc.card.id,
        rarity: pc.rarity,
        at: at,
        index: local.pulls - settle.perCard.length + idx + 1,
        duplicate: pc.duplicate,
        shards: pc.shards,
        // 追梦池返的是点数（普通池返碎片）—— 记录页两种都要能显示
        points: pc.points,
        // 这一抽来自普通池还是追梦池：记录页要能把两者分开（用户要求）
        dream: !!on,
        guaranteed: !!(result.results[idx] && result.results[idx].guaranteed),
        // 这一张的工艺（空串 = 普通）—— 记录页要能标出「这张是闪的」
        finish: foilId(result.results[idx] && result.results[idx].finish),
      }
    })
    for (var j = rows.length - 1; j >= 0; j--) local.history.unshift(rows[j])
    local.history = local.history.slice(0, 500)
    saveLocal(local)

    // 把已确认的状态写回内存快照 —— 否则下一次抽卡的重复判定会读到一个空状态
    // （见 applyStateToSnapshot 的注释）
    applyStateToSnapshot({
      owned: local.owned,
      shards: local.shards,
      duplicates: local.duplicates,
      pulls: local.pulls,
      sinceTop: local.sinceTop,
      history: local.history,
      spPity: local.spPity,
      urPity: local.urPity,
      foils: local.foils,
      dream: local.dream,
      shatterPity: local.shatterPity,
      currency: local.currency,
      points: local.points,
      lastGift: local.lastGift,
    })

    // --- 展示用的本轮结果 ------------------------------------------------
    state.last = {
      poolId: pool.id,
      at: at,
      results: result.results.map(function (item, idx) {
        var pc = settle.perCard[idx] || {}
        return {
          card: item.card,
          rarityId: item.rarityId,
          forced: item.forced || '',
          guaranteed: !!item.guaranteed,
          guaranteeNote: item.guaranteeNote || '',
          isNew: !pc.duplicate,
          duplicate: !!pc.duplicate,
          shards: Number(pc.shards || 0),
          // 这一张的工艺（空串 = 普通）：结果格子与动画都要按它来显示
          finish: foilId(item.finish),
          // 红碎补偿补出来的那一张（结果格子上要标一下，否则读者不知道为什么多了张红碎）
          compensation: !!item.compensation,
        }
      }),
    }
    lsSet(LS.last, {
      poolId: pool.id,
      at: state.last.at,
      ids: state.last.results.map(function (r) { return r.card.id }),
      // 刷新后还要能还原「哪张是闪的」——只存 id 不够
      finishes: state.last.results.map(function (r) { return r.finish || '' }),
    })

    state.sinceTop = sinceTop

    // 提示要把「拿到多少碎片」说出来，别让人自己去数
    var shardTotal = 0
    var hrShardTotal = 0
    for (var k in settle.gainedShards) {
      if (!Object.prototype.hasOwnProperty.call(settle.gainedShards, k)) continue
      // HR 碎片单独数：它不是档位碎片，混进「返还 N 个碎片」会让读者以为
      // 那一档的碎片多了（用户 2026-09-19：重复全闪额外返 HR 碎片）
      if (k === HR_SHARD_KEY) hrShardTotal += settle.gainedShards[k]
      else shardTotal += settle.gainedShards[k]
    }
    /**
     * 追梦池重复卡返的是点数（普通池返碎片）—— 但**两个池子都可能额外拿点数**
     *（重复面闪再给一点点数，见 settleDraw）。所以这里按「实际拿到了什么」拼，
     * 不再按池子二选一：普通池那 1 点也该被说出来，否则读者只会觉得
     * 「说好的点数呢」。
     */
    var rewardParts = []
    if (shardTotal > 0) rewardParts.push(shardTotal + ' 个碎片')
    if (settle.gainedPoints > 0) rewardParts.push(settle.gainedPoints + ' 点')
    if (!rewardParts.length) rewardParts.push(on ? '0 点' : '0 个碎片')
    var toastText =
      settle.duplicates > 0
        ? (count > 1 ? '十连完成' : '抽到 ' + result.results[0].card.name) +
          ' · ' + settle.duplicates + ' 张重复，返还 ' + rewardParts.join(' + ')
        : count > 1
        ? '十连完成 · 全部是新卡！'
        : '抽到新卡 ' + result.results[0].card.name

    // 重复全闪额外给的 HR 碎片单独说清（它是换动态卡面的东西，藏在总数里没人看得懂）
    if (hrShardTotal > 0) toastText += ' · 额外 +' + fmt(hrShardTotal) + ' 个 HR 碎片'

    // 抽到闪卡要说一句 —— 否则读者只会觉得「这张图有点不一样」而错过
    var foilHit = null
    for (var fi = 0; fi < result.results.length; fi++) {
      var fid = foilId(result.results[fi].finish)
      if (fid) foilHit = fid
    }
    if (foilHit) toastText += ' · 特殊工艺：' + foilLabel(foilHit)

    // 红碎补偿：抽到已有的红碎 -> 返券 + 欠条；这一轮兑现了欠条也要说清
    //（这套机制不写在脸上就等于不存在，读者只会觉得「红碎怎么又给我一张」）
    if (Number(settle.tickets || 0) > 0) {
      toastText += ' · 红碎补偿：+' + fmt(settle.tickets) + ' 张抽卡券'
    }
    // 「这一档红碎已集齐」时按折价返还、不给欠条（用户要求：防止程序卡死）
    var fullNow = settle.shatterFull || []
    if (fullNow.length) {
      var fullLabels = fullNow.map(function (r) { return (rarityById(r) || {}).label || r })
      var converted = settle.shatterConverted || []
      toastText +=
        ' · ' + fullLabels.join(' / ') + ' 的红碎已经集齐：' +
        (converted.length ? '原欠的必出改成' : '改为') + '返还 ' + fmt(shatterCompCfg().fullTickets) + ' 张券（不再欠必出）'
    }
    if (result.compensation && result.compensation.length) {
      var compLabels = result.compensation.map(function (c) {
        return (rarityById(c.rarityId) || {}).label || c.rarityId
      })
      toastText += ' · 兑现红碎补偿 ' + result.compensation.length + ' 张（' + compLabels.join(' / ') + '）'
    }
    var idlePity = result.shatterPityIdle || []
    if (idlePity.length) {
      // 正常流程下走不到这里（结算时会把兑现不了的欠条折成券）——
      // 真出现了说明数据被手改过，必须点名
      toastText +=
        ' · 注意：' + idlePity.map(function (r) { return (rarityById(r) || {}).label || r }).join(' / ') +
        ' 的欠条没有可补偿的目标（会在下次结算时折算成券）'
    }

    // 追梦池：把「SP 涨到多少 / 刚刚重置」说出来 ——
    // 这套机制不写在脸上就等于不存在（读者只会觉得「概率好像不太对」）
    if (on && dreamAfterSteps !== null) {
      var dInfoAfter = g.dreamWeights(state.data, pool, dreamAfterSteps)
      var spLbl = (rarityById(dInfoAfter.spId) || {}).label || dInfoAfter.spId
      toastText +=
        ' · 追梦池：' +
        (dreamAfterSteps === 0
          ? '抽到 ' + spLbl + '，概率已重置'
          : spLbl + ' 概率已累计 ' + dreamAfterSteps + '/' + dInfoAfter.cap + ' 次（' + fmtRate(dInfoAfter.weights[dInfoAfter.spId] / 100) + '）')
    }

    /**
     * 动画放完（或没开动画时立刻）才渲染结果视图。
     *
     * 顺序很重要：先把 state.last 备好、但**不渲染**，让动画盖在抽卡页上；
     * 动画结束再渲染 —— 否则结果会先闪一下再被弹层盖住。
     */
    var showResults = function () {
      render()
      toast(toastText, 'ok')
    }

    var revealMod = window.GachaReveal
    if (animEnabled() && revealMod) {
      var items = state.last.results.map(function (r) {
        return {
          rarityId: r.rarityId,
          name: r.card && r.card.name,
          // 复用 cardFigure：动画里翻开的正面就是真正的卡（含占位与「读不到图」提示）
          // 闪卡的工艺也一起带过去 —— 动画里那张就该是闪的
          faceEl: cardFigure(r.card, { size: 'lg', finish: r.finish }),
        }
      })
      revealMod
        .play({
          mode: count > 1 ? 'ten' : 'single',
          items: items,
          rarities: rarityList(),
          reveal: revealConfig(),
          emojiUrls: emojiUrls(),
        })
        .then(function (how) {
          if (how === 'skipped') {
            // 动画没播（被关掉、或系统设了「减少动态效果」）—— 正常回结果视图
            console.info('[gacha] 抽卡动画未播放（%s），直接显示结果', how)
          }
          showResults()
        })
        .catch(function (err) {
          // 动画出错绝不能把抽卡结果一起吞掉 —— 卡已经抽到了，必须让用户看到
          console.error('[gacha] 抽卡动画出错，直接显示结果：', err)
          showResults()
        })
    } else {
      showResults()
    }

    // --- 同步到服务端（仅动态站 + 已解锁） --------------------------------
    // 服务端会用同一份规则**重新结算一遍**（它有自己的 owned 状态），
    // 所以这里只送卡牌 id 与工艺，不送碎片数 —— 让服务端算，避免两边对不上。
    if (BACKEND && state.unlocked) {
      request('/draw/sync', {
        method: 'POST',
        body: {
          poolId: pool.id,
          cost: cost,
          // 花的是哪种资源：普通池是点数、追梦池是抽卡券。
          // 服务端只记账，所以必须由前端说清扣哪一边（默认按券算，兼容老前端）。
          costCurrency: price.currency,
          reward: on ? 'points' : 'shards',
          sinceTop: sinceTop,
          // SP 保底开关按池子记，服务端没有别的来源 —— 整张表送上去
          spPity: local.spPity,
          // UR 保底同理（用户 2026-09-22 加的这一条）
          urPity: local.urPity || {},
          // 追梦计数同理（服务端不判抽卡，只记账）
          dream: local.dream || {},
          // 红碎补偿的欠条：与 spPity 同理，**整张表**送上去（服务端不判抽卡，
          // 它自己算会算漏「这一轮兑现掉的」那一半）
          shatterPity: local.shatterPity || {},
          mode: on ? 'dream' : 'normal',
          results: result.results.map(function (item) {
            return { cardId: item.card.id, finish: foilId(item.finish) }
          }),
        },
      })
        .then(function (res) {
          if (res && res.rejected && res.rejected.length) {
            // 服务端退回了条目 —— 这必须说出来，不能当没发生
            toast('服务端拒绝了 ' + res.rejected.length + ' 条记录：' + res.rejected[0].reason, 'error')
          }
          if (res && res.player && state.data) {
            // 服务端权威状态覆盖本地 —— 碎片数以它为准
            state.data.player = res.player
            // 本地也跟上，避免静态站/动态站来回切换时数字跳变
            var l2 = localState()
            l2.owned = res.player.owned || l2.owned
            l2.shards = res.player.shards || l2.shards
            l2.duplicates = Number(res.player.duplicates || 0)
            if (res.player.foils) l2.foils = res.player.foils
            if (res.player.points !== undefined) l2.points = Number(res.player.points || 0)
            if (res.player.currency !== undefined) l2.currency = Number(res.player.currency || 0)
            saveLocal(l2)
            render()
          }
        })
        .catch(function (err) {
          // 抽卡本身已经成功了（结果在本地），但账没记上 —— 要说清是「记账失败」
          toast('抽卡结果没能同步到服务端：' + err.message + '（本次结果仍显示在页面上）', 'error')
        })
    }
  }

  function renderDrawProblem(probs, pool) {
    var view = state.els.view
    clear(view)
    view.appendChild(
      sectionHead('抽不了 —— 卡池还没配好', '这不是你的操作问题。下面是具体缺什么，照着做即可。')
    )
    view.appendChild(
      el(
        'div',
        { class: 'panel panel-warn' },
        [
          el('div', { class: 'panel-title', text: '卡池「' + (pool ? pool.name : '(无)') + '」的问题' }),
          el('ul', { class: 'issue-list' }, probs.map(function (t) { return el('li', { text: t }) })),
          el('div', { class: 'panel-actions' }, [
            canEdit()
              ? el('button', { class: 'btn primary', type: 'button', 'data-bind': 'goto-admin' }, ['去后台管理'])
              : el('div', { class: 'panel-hint', text: READONLY ? '这是静态站，改卡池需要在本机的 DSH 页面里操作。' : '需要编辑秘钥才能改卡池。' }),
          ]),
        ]
      )
    )
    var b = view.querySelector('[data-bind="goto-admin"]')
    if (b) b.addEventListener('click', function () { go('#/admin') })
  }

  // -------------------------------------------------------------------------
  // ⑥ 板块：抽卡
  // -------------------------------------------------------------------------

  /**
   * 红碎补偿的配置（页面侧只读一份，用于文案里的数字）。
   * 规则本体在 draw.js 的 `shatterComp`，这里不另算一套口径。
   */
  function shatterCompCfg() {
    var g = G()
    if (g && typeof g.shatterComp === 'function') return g.shatterComp(state.data)
    return { enabled: true, tickets: 10, fullTickets: 20 }
  }

  /**
   * 「红碎补偿」的欠条提示（抽卡页顶栏那个 pill）。
   *
   * 用户 2026-09-19：抽到已经有了的红碎会返券，**并且**下次十连必出一张同档、
   * 自己还没有红碎的卡。欠条是按档位记次数的，所以这里把每一档都写出来。
   *
   * 一条都没有时返回 null（不渲染一个空的 pill）。
   */
  function shatterPityPill() {
    var g = G()
    var pool = currentPool()
    if (!g || typeof g.shatterPity !== 'function' || !pool) return null
    var pity = g.shatterPity(null, player())
    var parts = []
    for (var k in pity) {
      if (!Object.prototype.hasOwnProperty.call(pity, k)) continue
      var label = (rarityById(k) || {}).label || k
      parts.push(label + ' ×' + pity[k])
    }
    if (!parts.length) return null
    // 兜底说明：正常流程下欠条不会「补不了」（结算时会把兑现不了的折成券，
    // 见 draw.js 的 shatterCompAfter），所以这句只在数据被手改过时才会出现
    var idle = []
    for (var k2 in pity) {
      if (!Object.prototype.hasOwnProperty.call(pity, k2)) continue
      var have = g.shatterTargets ? g.shatterTargets(dataWithState(), pool, k2, player()).length : 1
      if (!have) idle.push((rarityById(k2) || {}).label || k2)
    }
    return el('span', {
      class: 'pill pill-comp',
      text: '红碎补偿：' + parts.join('、') + '（下次十连必出）',
      title:
        '你抽到过已经有了的红碎，所以欠你这几张「必定是未拥有的红碎」——' +
        '会在下一次**十连**里兑现，单抽不消耗欠条。' +
        (idle.length
          ? ' 注意：' + idle.join(' / ') + ' 的红碎已经集齐，这张欠条会在下次结算时折算成 ' + shatterCompCfg().fullTickets + ' 张券。'
          : ''),
    })
  }

  function viewDraw() {
    var g = G()
    var view = state.els.view
    var pool = currentPool()
    var probs = g ? g.issues(state.data, pool ? pool.id : '') : ['draw.js 没有加载']

    var wrap = el('div', { class: 'sec' })
    wrap.appendChild(
      sectionHead('抽卡', state.data.settings.subtitle || '抽卡 · 图鉴 · 卡池', [
        el('span', { class: 'pill', text: '累计 ' + fmt(player().pulls) + ' 抽' }),
        state.sinceTop !== undefined && state.data.settings.pull.pityMax > 0
          ? el('span', { class: 'pill', text: '保底 ' + fmt(state.sinceTop) + '/' + state.data.settings.pull.pityMax })
          : null,
        // SP 保底生效时要说出来 —— 否则读者会觉得「这几张 SP 怎么突然抽不到了」。
        // 这是**当前池子**的开关，切池子会跟着变。
        // ⚠️ 必须走 dataWithState()：静态站的快照里没有 player（状态在 localStorage），
        // 直接读 state.data 会让保底明明开着却不显示。
        pool && g && g.spPityActive(dataWithState(), pool.id)
          ? el('span', {
              class: 'pill pill-pity',
              text: 'SP 保底：下次出 SP 必是新卡',
              title: '你已经抽到过重复的 SP，而本池的 SP 还没集齐 —— 已拥有的 SP 暂时不在抽取范围内，直到下次抽出 SP 为止',
            })
          : null,
        /*
         * UR 保底（用户 2026-09-22）：挂着的时候必须说出来 ——
         * 否则读者只会发现「这几张 UR 怎么突然都抽不到了/抽到的都是新的」，
         * 而原因（他上一张 UR 是重复的）只有界面能告诉他。
         * 与 SP 那条同一套判据：走 dataWithState()，静态站才读得到本机状态。
         */
        pool && g && typeof g.urPityActive === 'function' && g.urPityActive(dataWithState(), pool.id)
          ? el('span', {
              class: 'pill pill-pity',
              text: 'UR 保底：下次出 UR 必是新卡',
              title: '你抽到过重复的 UR，而本池还有没拿到的 UR —— 已有的 UR 暂时不在抽取范围内，直到下次抽出 UR（或本池 UR 全部集齐）为止',
            })
          : null,
        // 红碎补偿的欠条：欠着就写清楚「下次十连必出哪一档的红碎」——
        // 不显示的话，读者只会觉得「上次说会补，怎么没动静」
        shatterPityPill(),
      ])
    )

    // ---- 卡池舞台：侧面选池 + 主视觉轮播 + 右下角抽卡键 ---------------------
    // 抽卡判定用的是池子的 `byRarity`，所以「选哪个池」就是「能抽到哪些卡」。
    // 版面按用户给的参考图：侧面竖排卡池（封面+名），主视觉占满，抽卡键压右下角。
    var stage = el('div', { class: 'draw-stage' })
    if (state.data.pools.length > 1) stage.appendChild(poolSwitcherColumn())

    var banner = el('div', { class: 'draw-banner' })
    var bannerUrls = pool && pool.bannerUrls ? pool.bannerUrls : []
    if (bannerUrls.length) {
      banner.appendChild(bannerTrack(bannerUrls, pool))
      // 有图却个别解析不出来时要说清楚，别让人怀疑「我放了三张怎么只轮播两张」
      var brokenBanners = (pool.banners || []).filter(function (b) { return !b.url })
      if (brokenBanners.length) {
        banner.appendChild(
          el('div', {
            class: 'banner-warn',
            text: brokenBanners.length + ' 张主视觉图找不到：' + brokenBanners.map(function (b) { return b.src }).join('、'),
          })
        )
      }
    } else {
      // 没配主视觉时不能留一块空白：说清「可以放图」，而不是让人以为加载失败
      banner.appendChild(
        el('div', { class: 'banner-empty' }, [
          el('div', { class: 'banner-empty-title', text: pool ? pool.name : '卡池' }),
          el('div', { class: 'banner-empty-hint', text: '这个卡池还没有主视觉图。在后台把横幅文件填进卡池（图片放在受控的「卡池 UI 目录」里）。' }),
        ])
      )
    }

    // 抽卡键：**放在主视觉外面**的一行（用户要求：不要压在封面卡片上）。
    // 主视觉保持 16:9 完整可见，按钮排在它下面、右对齐。
    var on = dreamOn(pool)
    var price1 = drawPrice(1, pool)
    var price10 = drawPrice(10, pool)
    var cost1 = price1.amount
    var cost10 = price10.amount
    // 两种资源分开看：普通花点数、追梦花券
    var havePoints = points()
    var haveTickets = tickets()
    var haveFor = function (cur) { return cur === 'tickets' ? haveTickets : havePoints }
    var disabled = probs.length > 0
    // 按钮上写的是这一档要花什么（普通=点数、追梦=抽卡券）
    var curName = price1.name

    var actions = el('div', { class: 'draw-actions' }, [
      // 模式切换：普通（花点数）/ 追梦池（花抽卡券、概率换一套）
      dreamSwitch(pool),
      el('div', { class: 'draw-action-btns' }, [
        el('button', {
          class: 'btn draw-btn draw-btn-primary',
          type: 'button',
          'data-bind': 'draw1',
          disabled: disabled || undefined,
        }, [
          el('span', { class: 'draw-btn-label', text: '单抽' }),
          el('span', { class: 'draw-btn-cost', text: cost1 ? curName + ' ×' + cost1 : '免费' }),
        ]),
        el('button', {
          class: 'btn draw-btn',
          type: 'button',
          'data-bind': 'draw10',
          disabled: disabled || undefined,
        }, [
          el('span', { class: 'draw-btn-label', text: '十连' }),
          el('span', { class: 'draw-btn-cost', text: cost10 ? curName + ' ×' + cost10 : '免费' }),
        ]),
      ]),
      // 不够时先说清楚，别让人点下去只看到一句「不够」
      cost1 > haveFor(price1.currency)
        ? el('div', {
            class: 'dream-warn',
            text:
              curName + '不够（现有 ' + haveFor(price1.currency) + '，单抽要 ' + cost1 + '）—— ' +
              (on ? '到「碎片兑换」把碎片换成抽卡券。' : '点数每天登陆会送，也可以在追梦池抽到重复卡时返还。'),
          })
        : null,
    ])
    // 现有资源压在主视觉左下角（小胶囊，不是按钮）
    banner.appendChild(
      el('span', {
        class: 'banner-have',
        text: '点数 ' + havePoints + ' · 抽卡券 ' + haveTickets,
      })
    )
    stage.appendChild(el('div', { class: 'draw-main' }, [banner, actions]))
    wrap.appendChild(stage)

    // 抽卡范围 + 出率表：信息仍然要能看到，但不再占主视觉的位置
    if (pool) wrap.appendChild(poolScopeLine(pool))

    if (probs.length) {
      wrap.appendChild(
        el('div', { class: 'panel panel-warn' }, [
          el('div', { class: 'panel-title', text: '卡池还没配好，现在抽不了' }),
          el('ul', { class: 'issue-list' }, probs.map(function (t) { return el('li', { text: t }) })),
          canEdit()
            ? el('button', { class: 'btn primary', type: 'button', 'data-bind': 'goto-admin2' }, ['去后台管理'])
            : el('div', { class: 'panel-hint', text: READONLY ? '这是静态站，改卡池需要在本机的 DSH 页面里操作。' : '需要编辑秘钥才能改卡池。' }),
        ])
      )
    } else {
      // 出率表：让人在抽之前就知道各档概率。
      // 追梦池的概率**随次数变化**，所以这里必须按当前次数算 ——
      // 显示「2.5%」而实际已经涨到 5% 属于骗人。
      var rates = g.rateTable(state.data, pool.id, { dream: on, steps: dreamSteps(pool.id) })
      wrap.appendChild(
        el('div', { class: 'rate-row' }, rates.map(function (x) {
          return el('div', { class: 'rate-cell' + (x.playable ? '' : ' rate-off') }, [
            rarityChip(x.rarity.id),
            el('div', { class: 'rate-num', text: fmtRate(x.rate) }),
            el('div', { class: 'rate-sub', text: x.count + ' 张' }),
          ])
        }))
      )
      // 追梦池：把「涨到多少了、还差几次封顶」写出来，否则读者看不到这套机制在跑
      var dInfo = dreamInfo(pool)
      if (dInfo) {
        var spLabel = (rarityById(dInfo.spId) || {}).label || dInfo.spId
        var fromLabel = (rarityById(dInfo.fromId) || {}).label || dInfo.fromId
        wrap.appendChild(
          el('div', { class: 'dream-note' }, [
            el('span', { class: 'dream-note-key', text: '追梦池' }),
            el('span', {
              text:
                '已累计 ' + dInfo.steps + ' / ' + dInfo.cap + ' 次：每抽一次 ' + spLabel + ' +0.1%、' +
                fromLabel + ' -0.1%，抽到 ' + spLabel + ' 就重置',
            }),
            el('span', { class: 'dream-note-cost', text: '本池需要抽卡券（单抽 ' + cost1 + ' / 十连 ' + cost10 + '）' }),
          ])
        )
      }
      // 特殊工艺的概率也要写出来：页面上多了一整套概率，不写清楚的话
      // 读者只会看到「有的卡在发光」，然后怀疑是不是显示坏了
      var foilLine = foilRateLine(on ? '追梦池' : '')
      if (foilLine) wrap.appendChild(foilLine)
    }

    // 动画开关：读者的偏好，存在他自己的浏览器里
    var animBox = el('input', { type: 'checkbox', 'data-bind': 'anim-toggle' })
    animBox.checked = animEnabled()
    var animLabel = el('label', { class: 'anim-toggle' }, [animBox, el('span', { text: '抽卡动画' })])
    wrap.appendChild(el('div', { class: 'draw-extra' }, [animLabel]))

    // 结果区
    if (state.last && state.last.results.length) {
      var res = el('div', { class: 'result-box' })
      res.appendChild(
        el('div', { class: 'result-head' }, [
          el('span', { text: '本次结果' }),
          el('span', { class: 'result-time', text: fmtTime(state.last.at) }),
          el('button', { class: 'btn ghost small', type: 'button', 'data-bind': 'clear-result' }, ['收起']),
        ])
      )
      var grid = el('div', { class: 'grid cards' })
      var dupCount = 0
      var shardGain = 0
      // 结果按**稀有度从高到低**排（同档保持抽到的先后）。
      // 用 reveal.js 的排序，两个视图的规则就是同一份实现。
      var rev = window.GachaReveal
      var ordered = rev
        ? rev.sortByRarity(state.last.results, rarityList())
        : state.last.results.slice()
      // 哪些档位的卡要发光：与「弹表情包」用同一张表（都是「值得庆祝的档位」）
      var glowList = revealConfig().emojiRarities || ['UR', '???']
      ordered.forEach(function (item) {
        var holder = el('div', { class: 'result-cell' })
        if (glowList.indexOf(item.rarityId) >= 0) {
          holder.classList.add('result-glow')
          // 越高的档位光越强（??? 比 UR 更亮），用 rank 递推
          var rk = rev ? rev.rankOf(item.rarityId, rarityList()) : 1
          holder.style.setProperty('--glow-step', String(Math.max(1, rk - 1)))
        }
        holder.appendChild(cardFigure(item.card, { size: 'lg', finish: item.finish }))
        // 这张抽到的是闪卡 —— 必须标出来，否则读者不知道自己抽到了特殊工艺
        if (item.finish) {
          holder.appendChild(
            el('div', {
              class: 'badge-foil badge-foil-' + item.finish,
              text: foilLabel(item.finish),
              title: '这张是「' + foilLabel(item.finish) + '」特殊工艺',
            })
          )
          holder.classList.add('result-foil')
        }
        if (item.isNew) {
          holder.appendChild(el('div', { class: 'badge-new', text: 'NEW' }))
        } else if (item.duplicate) {
          // 重复卡转成碎片 —— 必须画在卡上，否则「这张明明是我的」这种困惑无法解释
          var n = Number(item.shards || 0)
          dupCount++
          shardGain += n
          holder.appendChild(el('div', { class: 'badge-dup', text: '重复 +' + n + ' 碎片' }))
          holder.classList.add('result-dup')
        }
        if (item.guaranteed) holder.appendChild(el('div', { class: 'badge-guarantee', text: '保底' }))
        // 红碎补偿补出来的那一张：标出来，否则读者只会觉得「怎么突然多了张红碎」
        if (item.compensation) {
          holder.appendChild(
            el('div', {
              class: 'badge-comp',
              text: '红碎补偿',
              title: '你之前抽到过已经有了的红碎，所以这一张按补偿规则必定是「你还没有的红碎」',
            })
          )
          holder.classList.add('result-comp')
        }
        if (item.guaranteed === false && item.forced === 'tenpull-fallback') {
          // 保底档在池子里抽不出来 —— 如实说明，不假装保底成功
          holder.appendChild(el('div', { class: 'badge-note', text: '保底档不可抽', title: item.guaranteeNote }))
        }
        grid.appendChild(holder)
      })
      res.appendChild(grid)
      if (dupCount > 0) {
        res.appendChild(
          el('div', { class: 'result-summary' }, [
            el('span', { text: '本次 ' + dupCount + ' 张重复，转化为 ' + shardGain + ' 个碎片' }),
            el('a', { class: 'result-link', href: '#/shards', text: '去碎片兑换 →' }),
          ])
        )
      }
      wrap.appendChild(res)
    }

    view.appendChild(wrap)

    var d1 = view.querySelector('[data-bind="draw1"]')
    var d10 = view.querySelector('[data-bind="draw10"]')
    if (d1) d1.addEventListener('click', function () { runDraw(1) })
    if (d10) d10.addEventListener('click', function () { runDraw(10) })
    var cr = view.querySelector('[data-bind="clear-result"]')
    if (cr) cr.addEventListener('click', function () { state.last = null; render() })
    var ga = view.querySelector('[data-bind="goto-admin2"]')
    if (ga) ga.addEventListener('click', function () { go('#/admin') })

    // 动画开关：勾选立刻生效并记住（存在浏览器里，不管动态站还是静态站都一样）
    var toggle = view.querySelector('[data-bind="anim-toggle"]')
    if (toggle) {
      toggle.addEventListener('change', function () {
        var on = !!toggle.checked
        setAnimEnabled(on)
        toast(on ? '抽卡动画已打开' : '抽卡动画已关闭（抽卡结果照常显示）', 'ok')
      })
    }
  }


  // -------------------------------------------------------------------------
  // ⑥ 板块：图鉴
  // -------------------------------------------------------------------------

  /**
   * 图鉴分组。
   *
   * 规则（用户要求「系列卡在图鉴中一起显示」）：
   *   · 有 series 的卡：**同一个系列合成一组**，组内先按 seriesOrder 再按稀有度排。
   *     系列组排在最前面 —— 「一起显示」的意图就是它们要挨着。
   *   · 没有 series 的卡：按稀有度分组（原来的行为）。
   *   · 稀有度表里不认识的卡：单独一组，永远看得见（数据写错不该被藏起来）。
   *
   * @returns {Array<{kind:'series'|'rarity'|'unknown', key, label, cards}>}
   */
  /** 「不属于任何系列」在界面上的名字（数据里 series 为空串，`常驻` 是它的哨兵） */
  var PLAIN_SERIES_LABEL = '常驻'

  /**
   * 图鉴的两级分组：**卡池（一级） -> 系列（二级）**。
   *
   * 用户要求：
   *   · 一级 = 卡池，封面用**卡池封面**
   *   · 二级 = 系列，封面用**该系列里最高稀有度的第一张卡**
   *   · 系列「常驻」（也就是不属于任何系列的卡）**单独成一个一级目录，不并入卡池**
   *   · 点封面 = 原来的展开/收起
   *
   * 「卡池一览」页面因此删掉了 —— 它展示的就是这里第一层的内容，功能重复。
   *
   * 返回的结构：
   *   { kind:'pool', key, label, coverUrl, coverCard, cover, cards, children:[seriesGroup...] }
   *   seriesGroup = { kind:'series', key, label, cover, cards }
   *
   * ⚠️ `key` 必须带上卡池 id：同一个系列（例如「异界访客」）可能同时属于两个池子，
   * 只用系列名当键的话，收起一个会把另一个也收起来。
   */
  function collectionGroups(cards) {
    var ranks = {}
    rarityList().forEach(function (r) {
      ranks[r.id] = Number(r.rank || 0)
    })
    var rankOf = function (c) {
      return ranks[c.rarity] === undefined ? -1 : ranks[c.rarity]
    }
    var sortSeries = function (list) {
      return list.slice().sort(function (a, b) {
        var ao = Number(a.seriesOrder || 0)
        var bo = Number(b.seriesOrder || 0)
        if (ao !== bo) return ao - bo
        if (rankOf(a) !== rankOf(b)) return rankOf(a) - rankOf(b)
        return String(a.name).localeCompare(String(b.name))
      })
    }
    /** 组封面 = 组里最高稀有度的第一张（按组内顺序取第一张） */
    var coverOf = function (sorted) {
      var best = null
      for (var i = 0; i < sorted.length; i++) {
        if (!best || rankOf(sorted[i]) > rankOf(best)) best = sorted[i]
      }
      return best
    }
    var seriesGroup = function (label, key, list) {
      var sorted = sortSeries(list)
      return { kind: 'series', key: key, label: label, cards: sorted, cover: coverOf(sorted) }
    }

    var pools = (state.data.pools || []).slice()
    var inAnyPool = {}

    var groups = []
    pools.forEach(function (pool) {
      var ids = {}
      // 成员判定走**同一个** poolCardsAll（只用服务端算好的 byRarity），
      // 前端不另写一套筛选规则
      poolCardsAll(pool).forEach(function (c) {
        ids[c.id] = 1
        inAnyPool[c.id] = 1
      })
      var mine = cards.filter(function (c) {
        return ids[c.id]
      })
      // 「常驻」（不属于任何系列）不在卡池分组里出现 —— 它有自己的一个一级目录
      var named = mine.filter(function (c) {
        return !!c.series
      })
      var order = []
      var map = {}
      named.forEach(function (c) {
        if (!map[c.series]) {
          map[c.series] = []
          order.push(c.series)
        }
        map[c.series].push(c)
      })
      var children = order.map(function (name) {
        return seriesGroup(name, 'series:' + pool.id + ':' + name, map[name])
      })
      if (!named.length && !children.length) return
      groups.push({
        kind: 'pool',
        key: 'pool:' + pool.id,
        label: pool.name,
        desc: pool.desc || '',
        coverUrl: pool.coverCardUrl || '',
        coverCard: pool.coverCard || null,
        cover: coverOf(sortSeries(named)),
        cards: named,
        children: children,
      })
    })

    // 系列「常驻」：不属于任何系列的卡，单独一个一级目录（**不并入卡池**）。
    // 它按「平铺」渲染：一级头下面直接是卡，不再套一层同名的系列头。
    var plain = sortSeries(
      cards.filter(function (c) {
        return !c.series && !c.memorial
      })
    )
    if (plain.length) {
      groups.push({
        kind: 'pool',
        key: 'pool:__plain__',
        label: PLAIN_SERIES_LABEL,
        desc: '不属于任何系列的卡',
        coverUrl: '',
        coverCard: null,
        cover: coverOf(plain),
        cards: plain,
        children: [],
        flat: true,
      })
    }

    // 纪念卡：**不进任何卡池**，只有两条获取途径（用户 2026-09-20 起）：
    //   ① 重置存档时赠送（奇迹系列）
    //   ② **集齐指定系列**后自动获得（镜溯·渊与幽 -> 冥幽；系列扩编会回收，
    //      重新集齐再发一次。判定在 shards.js 的 reconcileMemorials）
    // 它们不能被算进「没挂到卡池的卡」那个警告组 —— 那是给「数据配错了」用的，
    // 而纪念卡不进池是**设计**。
    var memorial = sortSeries(
      cards.filter(function (c) {
        return !!c.memorial
      })
    )
    if (memorial.length) {
      groups.push({
        kind: 'pool',
        key: 'pool:__memorial__',
        label: '纪念',
        desc: '无法抽卡获得：重置存档时赠送，或集齐指定系列后获得',
        coverUrl: '',
        coverCard: null,
        cover: coverOf(memorial),
        cards: memorial,
        children: [],
        flat: true,
        note: '重置赠送 · 集齐系列获得',
      })
    }
    // 兜底：哪个池子都不收的卡也必须看得见 —— 否则它们会在图鉴里**静默消失**。
    // 只在数据配错时才会出现（新系列忘了挂到池子上）。
    var leftovers = cards.filter(function (c) {
      return !inAnyPool[c.id] && !c.memorial
    })
    if (leftovers.length) {
      var warnList = sortSeries(leftovers)
      groups.push({
        kind: 'pool',
        key: 'pool:__orphan__',
        label: '没挂到卡池的卡',
        desc: '这些卡的系列不在任何卡池的清单里，所以哪个池子都抽不到',
        coverUrl: '',
        coverCard: null,
        cover: coverOf(warnList),
        cards: warnList,
        children: [],
        flat: true,
        warn: true,
      })
    }

    return groups
  }

  /**
   * 「这张卡就按普通版显示」在 localStorage 里的哨兵值。
   *
   * 为什么不能直接把键删掉当「普通」：「没选过」的默认是**最好的那一种**，
   * 两者必须区分开，否则读者在大图里点了「普通」之后一关弹层又变回闪的。
   * 用一对下划线包住，避免和以后可能出现的工艺 id 撞名。
   */
  var PLAIN_PICK = '__plain__'

  /**
   * 特殊工艺（闪卡）的元数据 —— 定义在 page/draw.js 里（判定与显示共用一份）。
   * 拿不到就当没有这门功能：页面照常跑，只是不显示任何闪卡效果。
   */
  function foilKinds() {
    var g = G()
    return (g && g.FOIL_KINDS) || []
  }

  /** 校验一个工艺 id（不认识的返回 ''，绝不把未知值带进 DOM 类名） */
  function foilId(x) {
    var s = String(x == null ? '' : x)
    if (!s) return ''
    var kinds = foilKinds()
    for (var i = 0; i < kinds.length; i++) if (kinds[i].id === s) return s
    return ''
  }

  function foilLabel(id) {
    var kinds = foilKinds()
    for (var i = 0; i < kinds.length; i++) if (kinds[i].id === id) return kinds[i].label || kinds[i].id
    return id
  }

  /** 玩家拥有的工艺表：卡牌 id -> [工艺 id]（服务端与本地存储同名同形） */
  function foils() {
    var p = player()
    var m = (p && p.foils) || {}
    return typeof m === 'object' && m ? m : {}
  }

  /**
   * 这张卡拥有哪些工艺（按档次从小到大，界面取最后一个就是最好的）。
   *
   * ⚠️ 未拥有的卡一律返回空：用户要求「未拥有的闪卡在图鉴里不显示效果」。
   * 「拥有张数」与「工艺表」是**两份**数据（同步、后台改写都可能只动其中一份），
   * 所以这条规则钉在这里，而不是指望两份数据永远一致 —— 图鉴格子、角标、
   * 筛选、大图切换四处都走这个函数，规则就只有一份。
   */
  function ownedFoils(cardId) {
    if (!(Number(collection()[cardId] || 0) > 0)) return []
    var list = foils()[cardId]
    if (!Array.isArray(list)) return []
    var out = []
    for (var i = 0; i < list.length; i++) {
      var id = foilId(list[i])
      if (id && out.indexOf(id) < 0) out.push(id)
    }
    // 按 FOIL_KINDS 的顺序排（定义里就是从低到高）
    var kinds = foilKinds()
    out.sort(function (a, b) {
      var ia = -1
      var ib = -1
      for (var k = 0; k < kinds.length; k++) {
        if (kinds[k].id === a) ia = k
        if (kinds[k].id === b) ib = k
      }
      return ia - ib
    })
    return out
  }

  /**
   * 抽卡页上那行「特殊工艺」说明（概率 + 门槛）。
   *
   * 只在真的开着一门概率 > 0 的工艺时才渲染 —— 全关掉时留着这一行
   * 只会让人以为「有这个功能但我抽不到」。门槛写了个档位表里没有的档位时，
   * 这里照实把它写出来（判定那边也是「这一档出不来」）。
   *
   * @param {string} [variant] 非空时在标题上标出来（追梦池用的是另一套概率）
   */
  function foilRateLine(variant) {
    var g = G()
    var pool = currentPool()
    var cfg = (state.data && state.data.settings && state.data.settings.foils) || {}
    if (cfg.enabled === false) return null
    var rates = variant && g && g.dreamFoilRates ? g.dreamFoilRates(state.data, pool) : cfg.rates || {}
    var kinds = foilKinds()
    var parts = []
    for (var i = 0; i < kinds.length; i++) {
      var k = kinds[i]
      var p = Number(rates[k.id] || 0)
      if (!(p > 0)) continue
      var min = String((cfg.minRarity && cfg.minRarity[k.id]) || k.minRarity || '')
      var r = min ? rarityById(min) : null
      var where = min ? (r ? r.label || r.id : min) + ' 及以上' : '所有档位'
      // ⚠️ 配置里是**百分数**（20 = 20%），而 fmtRate 收的是分数（0.2）——
      // 直接传 20 会显示成「2000%」（出率表那条路径给的就是分数）。
      parts.push((k.label || k.id) + ' ' + fmtRate(p / 100) + '（' + where + '）')
    }
    if (!parts.length) return null
    return el('div', { class: 'foil-rate-line' }, [
      el('span', { class: 'foil-rate-key', text: '特殊工艺' + (variant ? ' · ' + variant : '') }),
      el('span', { text: parts.join(' / ') }),
      el('span', { class: 'foil-rate-note', text: '卡图不变，只是卡面质感不同；在图鉴里点开大图可以逐张切回原图看。' }),
    ])
  }

  /**
   * 「普通 / 追梦池」模式切换。
   *
   * 只在池子配了追梦模式时才出现（`dream.enabled: false` 的池子不显示）——
   * 显示一个点了没反应的开关比不显示更糟。
   * 两个按钮各自把**代价**写在脸上：普通是「免费」，追梦是「券 ×N」。
   */
  function dreamSwitch(pool) {
    if (!pool || !dreamAvailable(pool)) return null
    var on = dreamOn(pool)
    var d = (pool.dream || {})
    var label = d.label || '追梦池'
    var g = G()
    // ⚠️ 追梦那个按钮上的价格要**按追梦票价算**，不能用 drawCost()（它看当前模式，
    // 而现在多半是普通模式 -> 会显示「券 ×0」，等于告诉读者切过去也免费）
    var dreamPrice = g ? g.costFor(state.data, 1, { pool: pool, dream: true }) : 1
    function modeBtn(id, text, sub, active) {
      var b = el('button', {
        class: 'mode-btn' + (active ? ' is-on' : ''),
        type: 'button',
        'data-dream-mode': id,
        'aria-pressed': active ? 'true' : 'false',
        title: sub,
      }, [
        el('span', { class: 'mode-btn-label', text: text }),
        el('span', { class: 'mode-btn-sub', text: sub }),
      ])
      b.addEventListener('click', function () {
        setDreamOn(pool.id, id === 'dream')
        render()
        toast(id === 'dream' ? '已切到' + label + '（消耗抽卡券）' : '已切回普通模式（免费）', 'ok')
      })
      return b
    }
    return el('div', { class: 'dream-switch', 'data-pool': pool.id }, [
      modeBtn('normal', '普通', '免费', !on),
      modeBtn('dream', label, '券 ×' + dreamPrice, on),
    ])
  }

  /**
   * 图鉴里这张卡**现在该按哪种工艺显示**。
   *
   * 规则（用户要求）：
   *   · 没拥有过的工艺**不显示效果**（所以这里只在自己拥有的里面挑）
   *   · 拥有的话默认显示**最好的那一种**，读者可以在大图里逐张切换
   *   · 切换结果存在 localStorage（读者偏好，不写服务端）
   */
  function finishFor(cardId) {
    var owned = ownedFoils(cardId)
    if (!owned.length) return ''
    var picked = (state.foilView || {})[cardId]
    // 明确选了「普通」——这必须和「没选过」区分开：没选过要显示最好的那一种，
    // 选过普通就是要看原图。所以「普通」存的是一个哨兵值，不是把键删掉。
    if (picked === PLAIN_PICK) return ''
    var pid = foilId(picked)
    if (pid && owned.indexOf(pid) >= 0) return pid
    return owned[owned.length - 1]
  }

  function setFoilView(cardId, finish) {
    if (!cardId) return
    var m = state.foilView && typeof state.foilView === 'object' ? Object.assign({}, state.foilView) : {}
    if (String(finish) === '') m[cardId] = PLAIN_PICK
    else {
      var id = foilId(finish)
      if (id) m[cardId] = id
      else delete m[cardId]
    }
    state.foilView = m
    lsSet(LS.foilView, m)
  }

  /**
   * 一张卡是否匹配图鉴搜索词。
   *
   * 匹配范围：角色名 / 系列名 / 稀有度（id 与 label 都算）。
   * 为什么连系列名也匹配：用户搜「女仆系列」时想要的是那一组卡，
   * 而组里每张卡的**名字**里并没有「女仆系列」四个字 —— 只搜名字会让
   * 搜索看起来「明明有这个系列却搜不到」。
   */
  function cardMatches(card, q) {
    if (!q) return true
    var hay = [
      card.name,
      card.series,
      card.rarity,
      (rarityById(card.rarity) || {}).label,
    ]
    for (var i = 0; i < hay.length; i++) {
      if (hay[i] && String(hay[i]).toLowerCase().indexOf(q) !== -1) return true
    }
    return false
  }

  /** 图鉴里被收起的系列组（键就是 group.key），存本机浏览器 */
  function collapsedMap() {
    if (!state.collapsed || typeof state.collapsed !== 'object') state.collapsed = {}
    return state.collapsed
  }

  function setCollapsed(key, on) {
    var m = collapsedMap()
    if (on) m[key] = true
    else delete m[key]
    lsSet(LS.collapsed, m)
  }

  /**
   * 三种工艺各自的收集进度（图鉴顶部，跟在总进度条后面）。
   *
   * 用户 2026-09-18：「为卡片收集进度进行更新，新增面闪卡、全闪卡、红碎卡的收集进度」。
   *
   * 数字全部来自 `draw.js` 的 `foilCollection`（纯函数，与服务端判定同一套门槛），
   * 这里只负责画。三种情况不画：
   *   · 特殊工艺被关掉（`foils.enabled === false`）—— 一行 0 / 0 只会让人以为坏了
   *   · 分母全是 0（数据里没有卡，或者门槛把每一档都排除了）
   *   · 这一趟连卡都还没加载好
   */
  function foilProgressPanel() {
    var g = G()
    if (!g || typeof g.foilCollection !== 'function' || !state.data) return null
    var cfg = (state.data.settings && state.data.settings.foils) || {}
    if (cfg.enabled === false) return null
    var rows = g.foilCollection(dataWithState(), player())
    var anyTotal = false
    for (var i = 0; i < rows.length; i++) if (rows[i].total > 0) anyTotal = true
    if (!anyTotal) return null

    var box = el('div', { class: 'foil-progress' }, [
      el('div', { class: 'foil-progress-head' }, [
        el('span', { class: 'foil-progress-title', text: '特殊工艺收集' }),
        el('span', {
          class: 'foil-progress-note',
          text: '分母是「拿得到这门工艺的卡」：平闪不限档位，全闪 SSR 及以上，红碎 UR 及以上；分子只算已拥有、且真的抽到过这门工艺的卡。',
        }),
      ]),
    ])

    rows.forEach(function (r) {
      var pct = Math.round(r.pct * 1000) / 10
      var bar = el('div', { class: 'foil-progress-bar' }, [
        el('div', { class: 'foil-progress-fill foil-fill-' + r.id }),
      ])
      var fillEl = bar.querySelector('.foil-progress-fill')
      if (fillEl) fillEl.style.width = pct + '%'
      box.appendChild(
        el('div', { class: 'foil-progress-row', 'data-foil': r.id }, [
          el('span', { class: 'foil-progress-key foil-key-' + r.id, text: r.label }),
          el('span', { class: 'foil-progress-num', text: fmt(r.owned) + ' / ' + fmt(r.total) }),
          el('span', { class: 'foil-progress-pct', text: pct + '%' }),
          bar,
        ])
      )
    })

    // 全齐时给一句明确的话（否则「100%」和「还没抽到」在视觉上没区别）
    var allDone = rows.length > 0
    rows.forEach(function (r) {
      if (r.owned < r.total) allDone = false
    })
    if (allDone) {
      box.appendChild(el('div', { class: 'foil-progress-hint', text: '三种工艺都集齐了。' }))
    }
    return box
  }

  function viewCollection() {
    var view = state.els.view
    var wrap = el('div', { class: 'sec' })
    var allCards = state.data.cards.filter(function (c) { return !c.hidden })
    var owned = collection()
    var got = 0
    allCards.forEach(function (c) { if (Number(owned[c.id] || 0) > 0) got += 1 })
    var pct = allCards.length ? Math.round((got / allCards.length) * 100) : 0
    var seriesCount = {}
    allCards.forEach(function (c) {
      if (c.series) seriesCount[c.series] = (seriesCount[c.series] || 0) + 1
    })
    var seriesNames = Object.keys(seriesCount)

    wrap.appendChild(
      sectionHead('图鉴', '收集进度：已获得 ' + got + ' / ' + allCards.length + ' 张（' + pct + '%）', [
        el('span', { class: 'pill', text: '累计 ' + fmt(player().pulls) + ' 抽' }),
        Number(player().duplicates || 0) > 0
          ? el('span', { class: 'pill', text: '重复 ' + fmt(player().duplicates) + ' 张' })
          : null,
        seriesNames.length ? el('span', { class: 'pill', text: seriesNames.length + ' 个系列' }) : null,
      ])
    )

    // 进度条：没有内联样式，宽度用 CSSOM 设置
    var bar = el('div', { class: 'progress' }, [el('div', { class: 'progress-fill' })])
    var fill = bar.querySelector('.progress-fill')
    if (fill) fill.style.width = pct + '%'
    wrap.appendChild(bar)

    // 特殊工艺的收集进度（平闪 / 全闪 / 红碎）：与上面那条同一套口径
    var foilPanel = foilProgressPanel()
    if (foilPanel) wrap.appendChild(foilPanel)

    if (!allCards.length) {
      wrap.appendChild(emptyBox('图鉴是空的', ['还没有任何卡牌。']))
      view.appendChild(wrap)
      return
    }

    // ---- 搜索框 -----------------------------------------------------------
    //
    // ⚠️ 这个输入框**不能**在每次按键时触发整页 render()：
    // 那样会把它自己重建一遍，光标和焦点每次都丢，中文输入法还更容易断字。
    // 所以这里只重画下面的列表（paint），输入框节点始终是同一个。
    var searchInput = el('input', {
      class: 'coll-search',
      type: 'search',
      placeholder: '搜索角色名 / 系列名 / 稀有度',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': '搜索卡牌',
    })
    searchInput.value = state.collQuery || ''
    var foundNote = el('span', { class: 'coll-found' })
    /**
     * 动态 / 静态卡面开关（用户 2026-09-19）。
     *
     * 三条：① 只对有动态卡面**且已解锁 HR** 的卡生效（没解锁的格子一点都不变）；
     * ② 一张都没有解锁时按钮**禁用并说明原因** —— 一个点了没反应的开关最容易被
     * 当成「功能坏了」；③ 偏好存在 localStorage（读者自己的选择，不写服务端）。
     */
    var hrAll = hrCards()
    var hrMine = hrAll.filter(function (c) { return hrUnlocked(c.id) })
    var dynOn = dynamicMode()
    var dynBtn = el('button', {
      class: 'btn ghost coll-dynamic' + (dynOn ? ' on' : ''),
      type: 'button',
      'data-coll': 'dynamic',
      'aria-pressed': dynOn ? 'true' : 'false',
      title: hrMine.length
        ? '在格子里播放动态卡面（共 ' + hrMine.length + ' 张已解锁）'
        : hrAll.length
          ? '还没有解锁任何动态卡面：用 HR 碎片兑换之后这里就有用了'
          : '这本书里还没有配动态卡面的卡',
    }, [dynOn ? '动态卡面：开' : '动态卡面：关'])
    if (!hrMine.length) dynBtn.setAttribute('disabled', '')
    wrap.appendChild(
      el('div', { class: 'coll-toolbar' }, [
        el('div', { class: 'coll-search-box' }, [
          el('span', { class: 'coll-search-icon', 'aria-hidden': 'true', text: '⌕' }),
          searchInput,
        ]),
        foundNote,
        dynBtn,
        el('button', { class: 'btn ghost coll-expand', type: 'button', 'data-coll': 'expand' }, ['全部展开']),
        el('button', { class: 'btn ghost coll-expand', type: 'button', 'data-coll': 'collapse' }, ['全部收起']),
      ])
    )
    if (hrAll.length) {
      wrap.appendChild(
        el('div', { class: 'coll-dynamic-note' }, [
          el('span', {
            text:
              '动态卡面：共 ' + hrAll.length + ' 张，已解锁 ' + hrMine.length + ' 张' +
              (hrMine.length ? '（开开关后格子里会直接播视频，滚出屏幕就停）' : '（去「碎片兑换」用 20 个 HR 碎片换一张）'),
          }),
        ])
      )
    }

    /**
     * 稀有度筛选的判据（**唯一一份**）：网格过滤与筛选条的计数都用它。
     *
     * `HR` 是特例：它不是档位表里的一项，而是「这张卡配了动态卡面」。
     * 其余情况直接比档位 id。
     */
    function rarityMatches(card, want) {
      if (!want) return true
      if (want === 'HR') return !!card.dynamicUrl
      return String(card.rarity || '') === want
    }

    /** 档位 id -> 显示名（用档位表里的 label，所以 `???` 显示成「SP」） */
    function rarityText(id) {
      var r = rarityById(id)
      return (r && (r.label || r.id)) || id
    }

    /**
     * 列表容器：**收起时是一格卡片，展开时占满整行**。
     *
     * 这是用户 2026-09-19 的要求：原来的标题是一整行（封面 + 名字 + 计数），
     * 收起之后那一行还占着整个宽度，几十个系列就要滚很久；现在收起 = 一张
     * 与抽卡结果同款的卡片（封面 2:3 + 名字 + 进度），一行能放好几张。
     * 展开的组用 `grid-column: 1 / -1` 铺满，卡片网格本身不变。
     */
    function groupsBox(children) {
      return el('div', { class: 'coll-groups' }, children)
    }

    var listBox = groupsBox([])
    // 稀有度筛选条（作者要求：SR/SSR/UR/SP/HR）放在工艺筛选之前 ——
    // 「这张卡是什么档位」比「它有没有闪」更常用来找卡
    var rarityRow = rarityFilterRow()
    if (rarityRow) wrap.appendChild(rarityRow)
    // 工艺筛选条：只有真的抽到过闪卡才出现（否则是一排点了没反应的按钮）
    var filterRow = foilFilterRow()
    if (filterRow) wrap.appendChild(filterRow)
    wrap.appendChild(listBox)

    /**
     * 一级/二级组的封面。
     *
     * 卡池组用**卡池封面**（服务端算好的 `coverCardUrl`）；系列组用
     * **该系列里最高稀有度的第一张卡**（`cover.imageUrl`）。两者都可能缺
     *（没配封面 / 那张卡还没有图），那就画一个字母占位 ——
     * 不能留一个空洞让人以为「图加载失败了」。
     */
    function coverNode(cover, coverUrl, alt, className) {
      var src = coverUrl || (cover && cover.imageUrl) || ''
      if (src) {
        return el('span', { class: className }, [
          el('img', { referrerpolicy: 'no-referrer', class: 'group-cover-img', src: src, alt: alt || '', loading: 'lazy' }),
        ])
      }
      var ch = String(alt || '?').replace(/ 封面$/, '').slice(0, 1) || '?'
      return el('span', { class: className + ' group-cover-empty', 'aria-hidden': 'true', text: ch })
    }

    /** 卡面网格 + 「点图看大图」。一级（平铺）与二级共用。 */
    function groupBody(list) {
      return el('div', { class: 'grid cards' }, list.map(function (c) {
        var n = Number(owned[c.id] || 0)
        var holder = el('div', { class: 'coll-cell' + (n > 0 ? '' : ' coll-locked') })
        // 闪卡效果只在自己拥有时才显示（finishFor 只在自己拥有的工艺里挑）
        // 动态卡面：开关开着 **且** 这张卡解锁了 HR 才换成视频（没解锁的照旧静态）
        var dyn = dynamicMode() && !!c.dynamicUrl && hrUnlocked(c.id)
        holder.appendChild(cardFigure(c, { finish: finishFor(c.id), dynamic: dyn }))
        if (n > 0) holder.appendChild(el('div', { class: 'badge-owned', text: n > 1 ? '×' + n : '已获得' }))
        /*
         * 「集齐系列才有」的纪念卡：没拿到时把**还差多少**写在卡上。
         *
         * 不写的话这张卡与「重置就送」的纪念卡长得一模一样，读者只会以为
         * 「重置一下就有了」—— 而它恰恰是重置**拿不到**的那一类。
         */
        if (n <= 0) {
          var Sh = window.GachaShards
          var need = Sh && typeof Sh.memorialRequirement === 'function' ? Sh.memorialRequirement(state.data, c, owned) : null
          if (need) {
            holder.appendChild(
              el('div', {
                class: 'badge-need',
                text: '集齐' + need.series + ' ' + need.got + '/' + need.total,
                title: '集齐「' + need.series + '」系列（共 ' + need.total + ' 张）后自动获得，并附赠全部特殊工艺；系列加新卡时会暂时回收',
              })
            )
          }
        }
        // 拥有的闪卡在格子上挂一个小标签，一眼能扫出「这张我有工艺版本」
        var ownedFin = ownedFoils(c.id)
        if (ownedFin.length) {
          holder.appendChild(
            el('div', {
              class: 'badge-foil',
              text: ownedFin.map(foilLabel).join(' · '),
              title: '已拥有的特殊工艺：' + ownedFin.map(foilLabel).join('、'),
            })
          )
        }
        var open = el('button', {
          class: 'coll-open',
          type: 'button',
          'data-card': c.id,
          title: '看大图 / 合成：' + (c.name || c.id),
          'aria-label': '查看大图：' + (c.name || c.id),
        }, [el('span', { class: 'coll-open-hint', text: '看大图' })])
        open.addEventListener('click', function () { openCardDialog(c.id) })
        holder.appendChild(open)
        return holder
      }))
    }

    /**
     * 工艺筛选条：只列**自己真的抽到过**的工艺，点了只看那些卡。
     * 用户要求「同样仅能查看已经抽取出的特殊工艺卡」，所以每种工艺的计数
     * 也是按「拥有的卡」算的，而不是按整个名册。
     */
    function foilFilterRow() {
      var kinds = foilKinds()
      if (!kinds.length) return null
      var counts = {}
      var foilCards = 0
      allCards.forEach(function (c) {
        var ownedFin = ownedFoils(c.id)
        if (!ownedFin.length) return
        foilCards++
        ownedFin.forEach(function (f) {
          counts[f] = (counts[f] || 0) + 1
        })
      })
      if (!foilCards) return null
      var row = el('div', { class: 'foil-filter' })
      row.appendChild(el('span', { class: 'foil-filter-key', text: '特殊工艺' }))
      row.appendChild(chip('', '全部', null))
      kinds.forEach(function (k) {
        if (!counts[k.id]) return
        row.appendChild(chip(k.id, k.label, counts[k.id]))
      })
      syncChips()
      return row

      function chip(id, label, count) {
        var on = String(state.foilFilter || '') === id
        var b = el('button', {
          class: 'foil-chip' + (on ? ' is-on' : '') + (id ? ' foil-chip-' + id : ''),
          type: 'button',
          'data-foil-filter': id,
          'aria-pressed': on ? 'true' : 'false',
          title: '只看拥有' + (id ? '「' + label + '」' : '任意特殊工艺') + '的卡',
        }, [el('span', { text: label }), count === null ? null : el('span', { class: 'foil-chip-count', text: String(count) })])
        b.addEventListener('click', function () {
          state.foilFilter = id
          syncChips()
          paint()
        })
        return b
      }

      /**
       * 把「哪一个亮着」对齐到 state.foilFilter。
       *
       * 整条筛选条是**建视图时画一次**，而点 chip 只重画下面的列表 ——
       * 不自己更新的话，列表变了而按钮还亮在「全部」上，看起来像点了没生效。
       */
      function syncChips() {
        var cur = String(state.foilFilter || '')
        var all = row.querySelectorAll('[data-foil-filter]')
        for (var i = 0; i < all.length; i++) {
          var on = String(all[i].getAttribute('data-foil-filter') || '') === cur
          all[i].className = all[i].className.replace(/\s*\bis-on\b/, '') + (on ? ' is-on' : '')
          all[i].setAttribute('aria-pressed', on ? 'true' : 'false')
        }
      }
    }

    /**
     * 稀有度筛选条（用户 2026-09-19：「在筛选中新增筛选稀有度（SR/SSR/UR/SP/HR）」）。
     *
     * 档位来自**档位表**（标签用表里的 `label`，所以 SP 显示成「SP」而不是它的 id `???`），
     * 另外多一个 `HR`：它不是档位，而是「**这张卡有动态卡面**」的状态
     *（见 state.rarityFilter 的说明）—— 判据与网格共用 `rarityMatches`，
     * 所以「筛选出来的张数」不会和实际显示的对不上。
     */
    function rarityFilterRow() {
      var list = (state.data && state.data.rarities) || []
      if (!list.length) return null
      var counts = {}
      var total = 0
      var hrCount = 0
      allCards.forEach(function (c) {
        total++
        if (c.dynamicUrl) hrCount++
        counts[c.rarity] = (counts[c.rarity] || 0) + 1
      })
      var row = el('div', { class: 'rarity-filter' })
      row.appendChild(el('span', { class: 'foil-filter-key', text: '稀有度' }))
      row.appendChild(chip('', '全部', total))
      // 档位表里的顺序就是强弱顺序（rank 升序），直接用，别在界面里再排一遍
      list.forEach(function (r) {
        if (!counts[r.id]) return
        row.appendChild(chip(r.id, r.label || r.id, counts[r.id]))
      })
      // HR 永远显示（哪怕当前一张都没配）—— 它是「这个站有没有动态卡面」的唯一入口，
      // 藏起来的话作者会以为筛选坏了
      row.appendChild(chip('HR', 'HR', hrCount))
      syncChips()
      return row

      function chip(id, label, count) {
        var on = String(state.rarityFilter || '') === id
        var b = el('button', {
          class: 'foil-chip rarity-chip' + (on ? ' is-on' : '') + (id ? ' rarity-chip-' + id : ''),
          type: 'button',
          'data-rarity-filter': id,
          'aria-pressed': on ? 'true' : 'false',
          title: id === 'HR' ? '只看有动态卡面（HR）的卡' : '只看 ' + label + ' 档位的卡',
        }, [el('span', { text: label }), count === null ? null : el('span', { class: 'foil-chip-count', text: String(count) })])
        b.addEventListener('click', function () {
          state.rarityFilter = id
          syncChips()
          paint()
        })
        return b
      }

      /** 与工艺筛选条同样的理由：那条是建视图时画一次，点 chip 只重画列表 */
      function syncChips() {
        var cur = String(state.rarityFilter || '')
        var all = row.querySelectorAll('[data-rarity-filter]')
        for (var i = 0; i < all.length; i++) {
          var on = String(all[i].getAttribute('data-rarity-filter') || '') === cur
          all[i].className = all[i].className.replace(/\s*\bis-on\b/, '') + (on ? ' is-on' : '')
          all[i].setAttribute('aria-pressed', on ? 'true' : 'false')
        }
      }
    }

    function paint() {
      clear(listBox)
      var q = String(state.collQuery || '').trim().toLowerCase()
      var ff = String(state.foilFilter || '')
      var rf = String(state.rarityFilter || '')
      /**
       * 有任何筛选在生效时要**强制展开**：搜到了/筛出来了却还收着，
       * 看起来就像「搜不到」—— 这一条原来只对搜索词成立，现在筛选也算。
       */
      var filtering = !!q || !!ff || !!rf
      var groups = collectionGroups(allCards)
      var shownGroups = 0
      var shownSeries = 0
      var shownCards = 0

      /** 可收起的标题（点它、点封面都是同一个动作）。 */
      function toggleHead(opts) {
        var head = el('button', {
          class: 'group-head group-toggle ' + opts.className,
          type: 'button',
          'aria-expanded': opts.collapsed ? 'false' : 'true',
          'data-coll-key': opts.key,
          title: opts.title || '',
        }, [
          el('span', { class: 'group-caret', 'aria-hidden': 'true', text: opts.collapsed ? '▸' : '▾' }),
          coverNode(opts.cover, opts.coverUrl, opts.coverAlt, opts.coverClass),
          el('span', { class: 'group-text' }, [
            el('span', { class: opts.nameClass, text: opts.label }),
            el('span', { class: 'group-meta', text: opts.meta }),
            opts.note ? el('span', { class: 'group-note', text: opts.note }) : null,
          ]),
        ])
        // 事件直接绑在按钮上，不用委托：委托要靠冒泡 + closest()，
        // 而测试用的 DOM shim 两样都没有 —— 那样写出来的代码在测试里
        // 「点了没反应」，于是收起功能根本测不到。
        head.addEventListener('click', function () {
          var m = collapsedMap()
          setCollapsed(opts.key, !m[opts.key])
          paint()
          // paint() 重建了整个列表，刚才那个按钮已经不在文档里了 ——
          // 不把焦点还给新节点，键盘用户点一下就掉焦点。
          var again = listBox.querySelector('[data-coll-key="' + opts.key + '"]')
          if (again && typeof again.focus === 'function') again.focus()
        })
        return head
      }

      groups.forEach(function (g) {
        // 先按搜索词 + 工艺筛选 + 稀有度筛选过滤：一级组里只剩匹配的卡/子组
        var keep = function (c) {
          if (!cardMatches(c, q)) return false
          if (!rarityMatches(c, rf)) return false
          if (!ff) return true
          // 工艺筛选用的是**拥有的工艺**，不是「现在显示的那一种」——
          // 读者切到普通版看原图时，筛选不该把他筛掉。
          return ownedFoils(c.id).indexOf(ff) >= 0
        }
        var children = (g.children || [])
          .map(function (sg) {
            return { sg: sg, list: sg.cards.filter(keep) }
          })
          .filter(function (x) { return x.list.length })
        var gCards = g.flat ? g.cards.filter(keep) : children.reduce(function (acc, x) { return acc.concat(x.list) }, [])
        if (!gCards.length) return

        shownGroups++
        shownSeries += g.flat ? 0 : children.length
        shownCards += gCards.length

        var gotHere = gCards.filter(function (c) { return Number(owned[c.id] || 0) > 0 }).length
        // 搜索时强制展开：搜到了却还收着，看起来就像「搜不到」
        var poolCollapsed = !filtering && !!collapsedMap()[g.key]

        var poolHead = toggleHead({
          key: g.key,
          label: g.label,
          className: 'pool-head' + (g.warn ? ' group-warn' : ''),
          collapsed: poolCollapsed,
          cover: g.cover,
          coverUrl: g.coverUrl,
          coverAlt: g.label + ' 封面',
          coverClass: 'group-cover pool-cover',
          nameClass: 'pool-name',
          meta:
            gotHere + ' / ' + gCards.length + ' 张' +
            (g.flat || !children.length ? '' : ' · ' + children.length + ' 个系列'),
          note: g.desc || '',
          title: g.desc || '',
        })

        if (g.flat) {
          listBox.appendChild(
            el('div', { class: 'group group-pool' + (poolCollapsed ? ' is-collapsed' : '') + (g.warn ? ' group-warn' : '') }, [
              poolHead,
              groupBody(gCards),
            ])
          )
          return
        }

        var seriesBoxes = children.map(function (x) {
          var sg = x.sg
          var list = x.list
          var sgGot = list.filter(function (c) { return Number(owned[c.id] || 0) > 0 }).length
          var sgCollapsed = !filtering && !!collapsedMap()[sg.key]
          return el('div', { class: 'group group-series' + (sgCollapsed ? ' is-collapsed' : '') }, [
            toggleHead({
              key: sg.key,
              label: sg.label,
              className: 'series-head',
              collapsed: sgCollapsed,
              cover: sg.cover,
              coverAlt: sg.label + ' 封面',
              coverClass: 'group-cover series-cover',
              nameClass: 'series-chip',
              meta: sgGot + ' / ' + list.length,
            }),
            groupBody(list),
          ])
        })

        listBox.appendChild(
          el('div', { class: 'group group-pool' + (poolCollapsed ? ' is-collapsed' : '') }, [
            poolHead,
            // 二级也用同一个「收起即卡片」的容器
            groupsBox(seriesBoxes),
          ])
        )
      })

      if (!shownGroups) {
        // 空结果的原因要**说清是哪一种**：搜索词、工艺筛选、稀有度筛选各自怎么退出来，
        // 读者才知道下一步点哪里（一句「没有匹配」会让人以为站点坏了）
        var why = []
        if (q) why.push('搜索词「' + state.collQuery + '」')
        if (rf) why.push('稀有度筛选「' + (rf === 'HR' ? 'HR' : rarityText(rf)) + '」')
        if (ff) why.push('工艺筛选「' + foilLabel(ff) + '」')
        if (rf === 'HR' && !hrCards().length) {
          why.push('（这本书目前还没有配动态卡面的卡）')
        }
        listBox.appendChild(
          emptyBox('没有匹配的卡牌', [
            why.length ? '当前条件：' + why.join(' + ') + '。' : '没有卡牌符合当前条件。',
            '点筛选条上的「全部」、或清空搜索框，就会恢复全部 ' + allCards.length + ' 张。',
          ])
        )
      }
      // 措辞按**用了哪种方式**分开：搜索说「找到」，胶囊筛选说「筛选后」——
      // 两者混在一起时读者分不清「是我搜的词起作用了，还是筛选还开着」
      var chipFiltering = !!ff || !!rf
      foundNote.textContent = chipFiltering
        ? '筛选后 ' + shownCards + ' 张' + (shownSeries ? '（' + shownSeries + ' 个系列）' : '')
        : q
          ? '找到 ' + shownCards + ' 张' + (shownSeries ? '（' + shownSeries + ' 个系列）' : '')
          : '共 ' + allCards.length + ' 张 · ' + seriesNames.length + ' 个系列'
    }

    paint()

    // 输入：只重画列表，输入框本身不动
    searchInput.addEventListener('input', function () {
      state.collQuery = searchInput.value
      paint()
    })
    searchInput.addEventListener('keydown', function (ev) {
      if (ev && ev.key === 'Escape' && searchInput.value) {
        searchInput.value = ''
        state.collQuery = ''
        paint()
      }
    })

    // 点标题收起/展开、点卡片看大图：**都直接绑在各自的节点上**（见 paint 里的注释，
    // 委托要靠冒泡与 closest()，测试用的 shim 没有）。这里只剩两个全局按钮。

    // 全部展开 / 全部收起 / 动态卡面开关
    // 两级都要收：只收二级的话，一级还开着，看起来像「收了但没收干净」。
    wrap.querySelectorAll('[data-coll]').forEach(function (b) {
      b.addEventListener('click', function () {
        var mode = b.getAttribute('data-coll')
        if (mode === 'dynamic') {
          // 这个开关只重画列表（不整页 render）：整页 render 会把开关自己重建，
          // 焦点丢掉、滚动位置也回到顶部 —— 而读者刚才是滚到某处才点的。
          lsSet(LS.dynamic, !dynamicMode())
          paint()
          return
        }
        var m = {}
        if (mode === 'collapse') {
          collectionGroups(allCards).forEach(function (g) {
            m[g.key] = true
            ;(g.children || []).forEach(function (sg) {
              m[sg.key] = true
            })
          })
        }
        state.collapsed = m
        lsSet(LS.collapsed, m)
        paint()
      })
    })

    view.appendChild(wrap)
  }

  // -------------------------------------------------------------------------
  // ⑥ 板块：碎片兑换
  // -------------------------------------------------------------------------

  /**
   * HR 碎片区块（用户 2026-09-19）。
   *
   * 「动态卡牌归属于 HR 的稀有度，同样不可以抽取，但是可以合成，需要消耗 HR 碎片」
   * ＋「使用 20 张 HR 碎片，即可兑换对应卡牌的 HR 动态卡面，动态卡面与原卡面
   *   共享特殊工艺」。
   *
   * 为什么单独一块、而不是混进上面那张档位表：HR **不是档位**（档位表里多一项，
   * 概率表/卡池一览/动画配色就会各多出一档永远 0 张的幽灵档）。它是第四种碎片，
   * 所以这里单独列出「有多少、能换什么、还差多少」。
   * 同样明确写出：**HR 碎片不能换抽卡券**（它只有兑换动态卡面这一个用途）——
   * 不写的话，读者会以为它漏进了换券表里。
   */
  function hrShardPanel() {
    var g = G()
    var cfg = g && typeof g.hrConfig === 'function' ? g.hrConfig(dataWithState()) : { enabled: true, shards: 20 }
    // 红碎兑换的价目（UR / SP 两档）—— 提示语里要报出来，否则读者不知道要攒多少
    var shatterCost =
      g && typeof g.shatterExchangeConfig === 'function'
        ? g.shatterExchangeConfig(dataWithState()).cost
        : { UR: 30, '???': 50 }
    var cards = hrCards()
    var have = Math.max(0, Number((shards() || {})[HR_SHARD_KEY] || 0))
    /**
     * ⚠️ 判据是「**有卡可以换 或 手上有碎片**」，不是「有卡可以换」。
     *
     * 只按卡片判断的话，读者会遇到一个自相矛盾的页面：他明明攒了 25 个 HR 碎片
     * （重复全闪返的），碎片页上却**一个 HR 字样都没有** —— 看起来像碎片凭空消失，
     * 而这正是用户 2026-09-19 报的问题（他在线上站看到的情况就是这一条：
     * 静态站当时一张动态卡面都没导出，于是整块 HR 都没了）。
     * 没卡可换的时候要**说清楚原因**，而不是把这一块藏起来。
     */
    if (!cards.length && have <= 0) return null
    var unlocked = cards.filter(function (c) { return hrUnlocked(c.id) }).length
    var rows = cards.map(function (c) {
      var done = hrUnlocked(c.id)
      var check = g && typeof g.canUnlockHr === 'function' ? g.canUnlockHr(dataWithState(), c.id) : null
      var btn = el('button', {
        class: 'btn ghost hr-unlock',
        type: 'button',
        'data-card': c.id,
      }, [done ? '已解锁' : check && check.ok ? '兑换（' + cfg.shards + '）' : '兑换'])
      // 已解锁、或规则模块没加载、或碎片不够：三种都不能点，
      // 但**原因分别写在 title 上**（糊成一句「不能兑换」等于没说）
      if (done) btn.disabled = true
      else if (!check) btn.disabled = true
      else {
        btn.disabled = !check.ok
        if (!check.ok) btn.setAttribute('title', check.reason)
      }
      return el('div', { class: 'hr-row' + (done ? ' hr-row-done' : '') }, [
        el('span', { class: 'hr-row-name', text: c.name || c.id }),
        el('span', { class: 'hr-row-state', text: done ? '动态卡面已解锁' : check && check.ok ? '可以兑换' : (check ? check.reason : '规则模块没加载') }),
        btn,
      ])
    })
    return el('div', { class: 'panel hr-panel' }, [
      el('div', { class: 'panel-title', text: 'HR 碎片 → 动态卡面' }),
      el('p', {
        class: 'panel-hint',
        text:
          '现有 ' + fmt(have) + ' 个 HR 碎片。' + cfg.shards + ' 个可以兑换一张卡的动态卡面（HR），' +
          '兑换后图鉴里可以切「动态卡面」，大图与格子都能播；' +
          '动态卡面与原卡面**共享特殊工艺**（原卡有平闪/全闪/红碎，动态形态也一样）。',
      }),
      cards.length
        ? el('p', {
            class: 'panel-hint',
            text:
              '共 ' + fmt(cards.length) + ' 张卡配了动态卡面，已解锁 ' + fmt(unlocked) + ' 张。' +
              'HR 碎片**不能**换抽卡券 —— 它只有这一个用途；来源是抽到重复的**全闪**卡（普通池与逐梦池都返）。',
          })
        : el('p', {
            class: 'panel-hint',
            text:
              '⚠️ 这本书目前**还没有配动态卡面（HR 视频）的卡**，所以现在没有可以兑换的东西 —— ' +
              '碎片先留着，作者放进视频之后这里就会出现可兑换的卡。' +
              'HR 碎片**不能**换抽卡券，它只有这一个用途；来源是抽到重复的**全闪**卡。',
          }),
      el('div', { class: 'hr-rows' }, rows),
      have >= cfg.shards || !cards.length ? null : el('p', { class: 'panel-hint', text: '还差 ' + fmt(cfg.shards - have) + ' 个碎片才能换第一张。' }),
      /*
       * 红碎兑换的说明（用户 2026-09-22）。它不复用上面那张「有动态卡面」的表 ——
       * 两个用途的候选卡片是完全不同的两批（一个是配了视频的卡，一个是「已经抽到全闪
       * 的 UR/SP」），混在一张表里读者会以为换红碎也必须先有动态卡面。
       */
      el('p', {
        class: 'panel-hint',
        text:
          'HR 碎片还有第二个用途：**红碎兑换** —— 拥有某张 UR/SP 的' + foilLabel('full') +
          '之后，可以在图鉴里点开它的大图，用 ' + fmt(shatterCost.UR) + '（UR）/ ' +
          fmt(shatterCost['???']) + '（SP）个 HR 碎片直接换它的' + foilLabel('shatter') + '工艺。',
      }),
    ])
  }

  /**
   * 碎片兑换。
   *
   * 规则来自 page/shards.js（与服务端权威兑换同一份源码），这里只负责画与点。
   *
   * ⚠️ 动态站 + 已解锁 -> 走服务端 `POST api/shards.json`（权威）。
   *    静态站（GitHub Pages）没有服务端，所以只能本地记账 —— 这一点必须在页面上
   *    说清楚，否则「在静态站换的碎片换完就没了」会变成一个说不清的 bug。
   */
  function viewShards() {
    var view = state.els.view
    var wrap = el('div', { class: 'sec' })
    var S = window.GachaShards

    wrap.appendChild(
      sectionHead('碎片兑换', '抽到重复的卡会转化成对应稀有度的碎片。' + shardRules().costForCard + ' 个碎片可以换一张同档卡牌，或换成更高一级的碎片。', [
        el('span', { class: 'pill', text: '重复 ' + fmt(player().duplicates || 0) + ' 张' }),
      ])
    )

    if (!S) {
      wrap.appendChild(
        emptyBox('碎片模块没有加载', [
          'page/shards.js 没有加载成功，所以这里无法判断能不能兑换。',
          '看浏览器 Console 的报错（多半是资源 404 或 CSP 拦了）。',
        ])
      )
      view.appendChild(wrap)
      return
    }

    // 动态站需要已解锁才能走服务端权威兑换；静态站本地记账
    var serverMode = BACKEND && state.unlocked
    if (BACKEND && !state.unlocked) {
      wrap.appendChild(
        el('div', { class: 'panel' }, [
          el('div', { class: 'panel-title', text: '提示：兑换需要先解锁秘钥' }),
          el('p', { class: 'panel-hint', text: '碎片兑换会改动你的收集进度，所以动态站上要求先输编辑秘钥。你现在可以看，但点兑换会被拒。' }),
        ])
      )
    }
    if (READONLY) {
      wrap.appendChild(
        el('div', { class: 'panel' }, [
          el('div', { class: 'panel-title', text: '这是静态站：兑换只存在你自己的浏览器里' }),
          el('p', { class: 'panel-hint', text: '静态站没有服务端，所以碎片与兑换记录都保存在本机浏览器（localStorage）。换台机器/清缓存就没了 —— 这是静态站的固有限制，不是 bug。' }),
        ])
      )
    }

    var status = S.status(dataWithState())
    // ⚠️ 「有没有碎片」不能只看档位表：HR 碎片不在这张表里，
    // 只看档位的话「有 25 个 HR 碎片」的人会看到「还没有任何碎片」（自相矛盾的页面）
    var anyShards = status.some(function (r) { return r.have > 0 }) || hrShardTotal() > 0
    if (!anyShards) {
      wrap.appendChild(
        emptyBox('还没有任何碎片', [
          '抽到重复的卡才会产生碎片。',
          '当前卡池与图鉴都在，去「抽卡」页抽几次就会出现重复卡。',
        ])
      )
    }

    // ---- HR 碎片 → 动态卡面（用户 2026-09-19）----
    var hrPanel = hrShardPanel()
    if (hrPanel) wrap.appendChild(hrPanel)

    // ---- 碎片 -> 抽卡券（用户要求 SR 5:1 / SSR 1:1 / UR 1:5 / SP 1:25）----
    //
    // 追梦池要花券，所以这里是券的唯一来源。**整批换**：
    // SR 是 5:1，按单个碎片算除不尽，所以按钮是「换 1 批 / 全部换」。
    if (typeof S.ticketStatus === 'function') {
      var tks = S.ticketStatus(dataWithState())
      var ticketPanel = el('div', { class: 'panel' }, [
        el('div', { class: 'panel-title', text: '碎片 → 抽卡券' }),
        el('p', {
          class: 'panel-hint',
          text:
            '抽卡券用在「追梦池」（普通模式依旧免费）。比例：' +
            tks.map(function (x) { return (x.label || x.rarityId) + ' ' + x.perShards + ':' + x.perTickets }).join(' / ') +
            '。整批兑换：例如 SR 每 ' + ((tks[0] && tks[0].perShards) || 5) + ' 个碎片换 1 张券。',
        }),
        el('div', { class: 'ticket-rows' }, tks.map(function (x) {
          var can = !x.disabled && x.batches > 0
          var row = el('div', { class: 'ticket-row', 'data-rarity': x.rarityId }, [
            rarityChip(x.rarityId),
            el('span', { class: 'ticket-have', text: fmt(x.have) + ' 个' }),
            el('span', { class: 'ticket-arrow', text: '→' }),
            el('span', { class: 'ticket-gain', text: can ? fmt(x.ticketsGain) + ' 张券' : '0 张' }),
            el('span', {
              class: 'ticket-hint' + (can ? '' : ' ticket-hint-off'),
              text: x.disabled
                ? '这一档不开放兑换'
                : can
                ? '可换 ' + x.batches + ' 批'
                : '还差 ' + x.missing + ' 个（' + x.perShards + ' 个换 ' + x.perTickets + ' 张）',
            }),
          ])
          var one = el('button', {
            class: 'btn small',
            type: 'button',
            'data-ticket-action': 'one',
            'data-rarity': x.rarityId,
            disabled: can ? undefined : true,
          }, ['换 1 批（' + x.perShards + ' → ' + x.perTickets + '）'])
          var all = el('button', {
            class: 'btn small',
            type: 'button',
            'data-ticket-action': 'all',
            'data-rarity': x.rarityId,
            disabled: can ? undefined : true,
          }, ['全部换（→ ' + fmt(x.ticketsGain) + '）'])
          var actions = el('div', { class: 'ticket-actions' }, [one, all])
          var box = el('div', { class: 'ticket-item' }, [row, actions])
          return box
        })),
        el('p', {
          class: 'panel-hint',
          text: '现有 ' + fmt(player().currency || 0) + ' ' + (player().currencyName || '抽卡券') + '。' +
            (READONLY ? '静态站上这些都记在你这台浏览器里。' : ''),
        }),
      ])
      wrap.appendChild(ticketPanel)
    }

    status.forEach(function (row) {
      var body = el('div', { class: 'shard-row' }, [
        rarityChip(row.rarity.id, { big: true }),
        el('div', { class: 'shard-count' }, [
          el('span', { class: 'shard-num', text: fmt(row.have) }),
          el('span', { class: 'shard-unit', text: '个碎片' }),
        ]),
      ])

      // 合成：兑卡已改为**指定**，所以这里不再有「随机换一张」的按钮 ——
      // 换哪张由图鉴决定。留一个随机入口会让人以为兑换还是随机的。
      var goBtn = el('button', {
        class: 'btn primary',
        type: 'button',
        'data-shard-action': 'goto-collection',
        'data-rarity': row.rarity.id,
        disabled: row.canRedeemCard ? undefined : true,
      }, ['去图鉴选一张 ' + (row.rarity.label || row.rarity.id) + ' 合成']) 

      var cardHint
      if (row.canRedeemCard) {
        cardHint = el('div', { class: 'shard-hint', text: '同档共 ' + row.cardCount + ' 张。到「图鉴」点开想换的那一张，下面就有合成按钮' })
      } else if (row.cardCount === 0) {
        cardHint = el('div', { class: 'shard-hint shard-hint-off', text: '这一档还没有任何卡牌，碎片换不了' })
      } else {
        cardHint = el('div', { class: 'shard-hint shard-hint-off', text: '还差 ' + row.missingForCard + ' 个碎片' })
      }

      var actions = el('div', { class: 'shard-actions' }, [goBtn, cardHint])

      // 升档
      if (row.isTop) {
        actions.appendChild(el('div', { class: 'shard-hint shard-hint-off', text: '已经是最高档，没有更高一级可以升' }))
      } else {
        var upBtn = el('button', {
          class: 'btn',
          type: 'button',
          'data-shard-action': 'upgrade',
          'data-rarity': row.rarity.id,
          disabled: row.canUpgrade ? undefined : true,
        }, ['换 1 个 ' + (row.nextRarity.label || row.nextRarity.id) + ' 碎片（' + row.costForUpgrade + '）'])
        actions.appendChild(upBtn)
        actions.appendChild(
          el('div', {
            class: 'shard-hint' + (row.canUpgrade ? '' : ' shard-hint-off'),
            text: row.canUpgrade ? '升到更高一级的碎片' : '还差 ' + row.missingForUpgrade + ' 个碎片',
          })
        )
      }

      body.appendChild(actions)
      wrap.appendChild(el('div', { class: 'group shard-group' }, [body]))
    })

    // 兑换记录（碎片怎么少掉的要能查）
    var exchanges = state.shardLog || []
    if (exchanges.length) {
      wrap.appendChild(
        el('div', { class: 'panel' }, [
          el('div', { class: 'panel-title', text: '本次会话的兑换记录' }),
          el('div', { class: 'hist' }, exchanges.map(function (x) {
            return el('div', { class: 'hist-row' }, [
              rarityChip(x.rarity),
              el('span', { class: 'hist-name', text: x.text }),
              el('span', { class: 'hist-time', text: fmtTime(x.at) }),
            ])
          })),
        ])
      )
    }

    view.appendChild(wrap)

    view.querySelectorAll('[data-shard-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var action = btn.getAttribute('data-shard-action')
        if (action === 'goto-collection') {
          // 兑卡是指定的，所以这里只负责把人送到能选卡的地方
          go('#/collection')
          toast('点开想合成的那一张卡，大图下面有合成按钮', 'ok')
          return
        }
        doExchange(btn.getAttribute('data-rarity'), action)
      })
    })

    // 碎片 -> 抽卡券
    view.querySelectorAll('[data-ticket-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var rarityId = btn.getAttribute('data-rarity')
        var S2 = window.GachaShards
        var rows = S2 && S2.ticketStatus ? S2.ticketStatus(dataWithState()) : []
        var row = null
        for (var i = 0; i < rows.length; i++) if (rows[i].rarityId === rarityId) row = rows[i]
        if (!row) return
        var batches = btn.getAttribute('data-ticket-action') === 'all' ? row.batches : 1
        doTicketExchange(rarityId, batches)
      })
    })

    // HR 碎片 -> 动态卡面（与图鉴大图里那个「兑换动态卡面」是同一件事、同一个函数）
    view.querySelectorAll('.hr-unlock').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var cardId = btn.getAttribute('data-card')
        if (cardId) doUnlockHr(cardId)
      })
    })
  }

  /**
   * 执行一次「碎片 -> 抽卡券」。两条通路与兑换一样：动态站走服务端（权威），
   * 静态站本地记账。规则本身在 page/shards.js 里只有一份。
   */
  function doTicketExchange(rarityId, batches) {
    var S = window.GachaShards
    if (!S || typeof S.exchangeTickets !== 'function') {
      toast('碎片模块没有加载，无法换券', 'error')
      return
    }
    var check = S.canExchangeTickets(dataWithState(), rarityId, batches)
    if (!check.ok) {
      toast(check.error, 'error')
      return
    }

    if (BACKEND) {
      if (!state.unlocked) {
        toast('需要先解锁编辑秘钥才能兑换（右上角「解锁」）', 'error')
        return
      }
      request('/shards.json', {
        method: 'POST',
        body: { rarity: rarityId, action: 'ticket', batches: batches },
      })
        .then(function (res) {
          if (res.player && state.data) state.data.player = res.player
          pushTicketLog(rarityId, res.cost || check.cost, res.gain || check.gain)
          render()
          toast('换到 ' + (res.gain || check.gain) + ' 张' + (player().currencyName || '抽卡券'), 'ok')
        })
        .catch(function (err) {
          toast('换券失败：' + err.message, 'error')
        })
      return
    }

    // 静态站：本地记账。**券要一起写**（只改碎片的话等于白换）
    var result = S.exchangeTickets(dataWithState(), rarityId, batches)
    if (!result.ok) {
      toast(result.error, 'error')
      return
    }
    var local = localState()
    local.shards = result.shards
    local.currency = result.currency
    saveLocal(local)
    applyStateToSnapshot({ shards: local.shards, currency: local.currency, owned: local.owned })
    pushTicketLog(rarityId, result.cost, result.gain)
    render()
    toast('换到 ' + result.gain + ' 张' + (local.currencyName || '抽卡券') + '（记在这台浏览器上）', 'ok')
  }

  function pushTicketLog(rarityId, cost, gain) {
    if (!state.shardLog) state.shardLog = []
    var r = rarityById(rarityId)
    var label = r ? r.label || r.id : rarityId
    state.shardLog.unshift({
      rarity: rarityId,
      at: Date.now(),
      text: label + ' 碎片 -' + cost + ' -> +' + gain + ' 张抽卡券',
    })
    state.shardLog = state.shardLog.slice(0, 30)
  }

  // -------------------------------------------------------------------------
  // 「清空缓存」= 重置存档（用户要求：二级确认 + 等 5 秒才能确认）
  // -------------------------------------------------------------------------

  /** 第二级确认要等多久才能点「确认清除」 */
  var RESET_WAIT_MS = 5000

  /** 打开二级确认：倒计时跑完之前确认键是禁用的 */
  function openResetDialog() {
    var dlg = state.els.resetDialog
    if (!dlg) return
    var confirmBtn = state.els.resetConfirm
    var countEl = state.els.resetCount
    var outEl = state.els.resetOut
    if (outEl) {
      outEl.textContent = ''
      outEl.className = 'panel-out'
    }
    if (confirmBtn) confirmBtn.disabled = true
    if (state.resetTimer) {
      window.clearInterval(state.resetTimer)
      state.resetTimer = 0
    }
    if (countEl) countEl.hidden = false
    var left = Math.ceil(RESET_WAIT_MS / 1000)
    var paint = function () {
      if (countEl) {
        countEl.textContent = left > 0 ? '请等 ' + left + ' 秒…' : '可以确认了'
        countEl.classList.toggle('is-ready', left <= 0)
      }
    }
    paint()
    // ⚠️ 倒计时用 setInterval 而不是「点的时候就记个时间、确认时比一下」：
    // 后者在用户切走标签页再回来时会出现「看着能点、点下去却被拒」的怪状态。
    state.resetTimer = window.setInterval(function () {
      left -= 1
      paint()
      if (left <= 0) {
        window.clearInterval(state.resetTimer)
        state.resetTimer = 0
        if (confirmBtn) confirmBtn.disabled = false
      }
    }, 1000)
    showModal(dlg)
  }

  function closeResetDialog() {
    if (state.resetTimer) {
      window.clearInterval(state.resetTimer)
      state.resetTimer = 0
    }
    hide(state.els.resetDialog)
  }

  /**
   * 真的清空。
   *
   * 两条路：动态站 + 已解锁 -> 服务端权威重置（`POST api/player/reset`，
   * 规则在 page/shards.js 的 `resetPlayer`，两边同一份）；
   * 静态站（GitHub Pages）-> 只能本地重置（这也是线上读者的实际路径）。
   */
  function doReset() {
    var S = window.GachaShards
    var outEl = state.els.resetOut
    var confirmBtn = state.els.resetConfirm
    if (!S || typeof S.resetPlayer !== 'function') {
      if (outEl) {
        outEl.textContent = '碎片模块没加载，无法重置。'
        outEl.className = 'panel-out panel-out-err'
      }
      return
    }
    if (confirmBtn) confirmBtn.disabled = true

    var finish = function (player, gift, where) {
      if (player && state.data) {
        state.data.player = player
        applyStateToSnapshot({
          owned: player.owned,
          shards: player.shards,
          duplicates: player.duplicates,
          pulls: player.pulls,
          sinceTop: player.sinceTop,
          history: player.history,
          spPity: player.spPity,
          // 重置之后「下一张 UR 必为未拥有」也一并归零（resetPlayer 给的是一张空表）
          urPity: player.urPity,
          foils: player.foils,
          dream: player.dream,
          currency: player.currency,
          points: player.points,
          lastGift: player.lastGift,
        })
      }
      closeResetDialog()
      closeCardDialog()
      render()
      var names = (gift || []).map(function (g) {
        return g.card.name + (g.finish ? '（' + foilLabel(g.finish) + '）' : '')
      })
      toast(
        '已清空并重置：点数 ' + Math.round(Number(player && player.points) || 0) +
          '、抽卡券 ' + Math.round(Number(player && player.currency) || 0) +
          (names.length ? '，赠送纪念卡：' + names.join('、') : '') +
          (where ? '（' + where + '）' : ''),
        'ok'
      )
    }

    if (BACKEND) {
      if (!state.unlocked) {
        if (outEl) {
          outEl.textContent = '动态站上重置需要先解锁编辑秘钥（右上角「解锁」）。静态站（GitHub Pages）可以直接重置。'
          outEl.className = 'panel-out panel-out-err'
        }
        if (confirmBtn) confirmBtn.disabled = false
        return
      }
      request('/player/reset', { method: 'POST', body: { confirm: true } })
        .then(function (res) {
          if (!res || !res.player) throw new Error('服务端没有返回新的玩家状态')
          var l = localState()
          l.owned = res.player.owned || {}
          l.shards = res.player.shards || {}
          l.duplicates = Number(res.player.duplicates || 0)
          l.pulls = Number(res.player.pulls || 0)
          l.sinceTop = Number(res.player.sinceTop || 0)
          l.history = res.player.history || []
          l.spPity = res.player.spPity || {}
          l.foils = res.player.foils || {}
          l.dream = res.player.dream || {}
          l.currency = Number(res.player.currency || 0)
          l.points = Number(res.player.points || 0)
          l.lastGift = String(res.player.lastGift || '')
          saveLocal(l)
          finish(res.player, res.gift || [], '服务端已重置')
        })
        .catch(function (err) {
          if (outEl) {
            outEl.textContent = '重置失败：' + err.message
            outEl.className = 'panel-out panel-out-err'
          }
          if (confirmBtn) confirmBtn.disabled = false
        })
      return
    }

    // 静态站：本地重置（线上读者的路径）
    var r = S.resetPlayer(dataWithState())
    var fresh = localState()
    var next = Object.assign({}, fresh, r.player)
    saveLocal(next)
    finish(next, r.gift, '只改了这台浏览器')
  }

  /**
   * 执行一次兑换。两条通路：动态站走服务端，静态站本地记账。
   *
   * @param {string} rarityId 碎片档位
   * @param {'card'|'upgrade'} action
   * @param {string} [cardId] action==='card' 时**必须**给（指定合成哪一张）
   */
  function doExchange(rarityId, action, cardId) {
    var S = window.GachaShards
    if (!S) {
      toast('碎片模块没有加载，无法兑换', 'error')
      return
    }
    // 先本地判一次：把「为什么换不了」立刻说出来，而不是等接口回一个 400
    var check = S.canExchange(dataWithState(), rarityId, action, cardId)
    if (!check.ok) {
      toast(check.error, 'error')
      return
    }

    if (BACKEND) {
      if (!state.unlocked) {
        toast('需要先解锁编辑秘钥才能兑换（右上角「解锁」）', 'error')
        return
      }
      var body = { rarity: rarityId, action: action }
      if (action === 'card') body.cardId = cardId
      request('/shards.json', { method: 'POST', body: body })
        .then(function (res) {
          if (res.player && state.data) state.data.player = res.player
          pushShardLog(rarityId, action, check.cost, res.card, res.gainedShard)
          closeCardDialog()
          render()
          toast(
            action === 'card' && res.card
              ? '合成到 ' + res.card.name
              : '换到 1 个 ' + ((res.gainedShard && res.gainedShard.rarity) || '更高档') + ' 碎片',
            'ok'
          )
        })
        .catch(function (err) {
          toast('兑换失败：' + err.message, 'error')
        })
      return
    }

    // 静态站：本地记账
    var result = S.exchange(dataWithState(), rarityId, action, cardId)
    if (!result.ok) {
      toast(result.error, 'error')
      return
    }
    var local = localState()
    local.shards = result.shards
    if (result.card) {
      local.owned = Object.assign({}, local.owned)
      local.owned[result.card.id] = Number(local.owned[result.card.id] || 0) + 1
    }
    saveLocal(local)
    // 同步写回内存快照（否则连续兑换两次时第二次读到的还是旧碎片数）
    applyStateToSnapshot({ owned: local.owned, shards: local.shards, duplicates: local.duplicates })

    pushShardLog(rarityId, action, result.cost, result.card, result.gainedShard)
    closeCardDialog()
    render()
    toast(
      result.card ? '合成到 ' + result.card.name + '（记在这台浏览器上）' : '换到 1 个 ' + result.gainedShard.rarity + ' 碎片',
      'ok'
    )
  }

  function pushShardLog(rarityId, action, cost, card, gainedShard) {
    if (!state.shardLog) state.shardLog = []
    var r = rarityById(rarityId)
    var label = r ? r.label || r.id : rarityId
    state.shardLog.unshift({
      rarity: rarityId,
      at: Date.now(),
      text:
        label + ' 碎片 -' + cost + ' -> ' +
        (card ? '卡牌「' + card.name + '」' : '1 个 ' + ((gainedShard && gainedShard.rarity) || '?') + ' 碎片'),
    })
    state.shardLog = state.shardLog.slice(0, 30)
  }


  // -------------------------------------------------------------------------
  // ⑥ 板块：抽卡记录
  // -------------------------------------------------------------------------

  /**
   * 每日签到（用户 2026-09-19）。
   *
   * 原话：「每日登录赠送的点数改为签到领取，签到按钮每天凌晨 3 点刷新。
   *   签到的时候，会从已拥有的卡牌中随机挑选一张 UR/SP 卡牌（纪念卡无法被抽取），
   *   根据卡牌种类获得额外点数：A 乘以 B。A=2/5（UR/SP），B=1/2/5/15
   *   （平卡/面闪/全闪/红碎）。这个卡牌抽取结果可以进行三次重抽，重抽后也保留
   *   原本的卡，相当于用户可以自行从四张卡中选择。」
   *
   * 规则全部在 `page/draw.js`（`checkinState` / `checkinRoll` / `checkinClaimAfter`），
   * 页面只负责画与点 —— 静态站与动态站、浏览器与服务端都是同一份。
   */
  function viewCheckin() {
    var view = state.els.view
    var wrap = el('div', { class: 'sec' })
    var g = G()
    var now = Date.now()
    if (!g || typeof g.checkinState !== 'function') {
      wrap.appendChild(
        emptyBox('规则模块没有加载', [
          'page/draw.js 没有加载成功，所以现在算不出今天能不能签到。',
          '看浏览器 Console 的报错（多半是资源 404 或 CSP 拦了）。',
        ])
      )
      view.appendChild(wrap)
      return
    }
    var st = g.checkinState(dataWithState(), now)
    var serverMode = BACKEND && state.unlocked

    wrap.appendChild(
      sectionHead('每日签到', '每天可以领一次点数：基础 ' + fmt(st.base) + ' 点，外加一张已有 UR / SP 卡按种类给的点数。', [
        el('span', { class: 'pill', text: '凌晨 ' + fmt(dailyRefreshHour()) + ' 点刷新' }),
      ])
    )

    if (!st.enabled) {
      wrap.appendChild(emptyBox('签到已经关闭', ['作者把每日点数关掉了（后台「每日签到」一节）。']))
      view.appendChild(wrap)
      return
    }

    if (READONLY) {
      wrap.appendChild(
        el('div', { class: 'panel' }, [
          el('div', { class: 'panel-title', text: '这是静态站：签到记录只存在你自己的浏览器里' }),
          el('p', { class: 'panel-hint', text: '静态站没有服务端，所以「今天领过了没有」保存在本机（localStorage）。换台机器/清缓存就能再领一次 —— 这是静态站的固有限制，不是 bug。' }),
        ])
      )
    }
    if (BACKEND && !state.unlocked) {
      wrap.appendChild(
        el('div', { class: 'panel' }, [
          el('div', { class: 'panel-title', text: '提示：签到需要先解锁秘钥' }),
          el('p', { class: 'panel-hint', text: '签到会改动你的点数，所以动态站上要求先输编辑秘钥。你现在可以看，但点签到会被拒。' }),
        ])
      )
    }

    // ---- 候选卡 -----------------------------------------------------------
    var cardsBox = el('div', { class: 'checkin-cards' })
    if (st.rolls.length) {
      st.rolls.forEach(function (r, i) {
        var card = cardById(r.cardId)
        var cell = el('div', { class: 'checkin-card' + (st.claimed === r.cardId ? ' checkin-card-picked' : '') })
        // 卡面用静态图（这里不是图鉴，不需要视频；动态形态去图鉴看）
        if (card) cell.appendChild(cardFigure(card, { finish: finishFor(card.id) }))
        cell.appendChild(
          el('div', { class: 'checkin-card-meta' }, [
            el('div', { class: 'checkin-card-name', text: (card && card.name) || r.cardId }),
            el('div', { class: 'checkin-card-kind', text: checkinKindLabel(r) }),
            el('div', { class: 'checkin-card-points', text: '+' + fmt(r.points) + ' 点' }),
          ])
        )
        if (st.claimed === r.cardId) {
          cell.appendChild(el('div', { class: 'checkin-picked', text: '已选这张' }))
        } else if (!st.claimed) {
          var take = el('button', {
            class: 'btn primary checkin-take',
            type: 'button',
            'data-card': r.cardId,
            'data-index': String(i),
          }, ['领这一张'])
          take.addEventListener('click', function () { doCheckinClaim(r.cardId) })
          cell.appendChild(take)
        }
        cardsBox.appendChild(cell)
      })
    }

    // ---- 操作区 -----------------------------------------------------------
    var actions = el('div', { class: 'checkin-actions' })
    if (st.done) {
      actions.appendChild(
        el('div', { class: 'checkin-note' }, [
          '今天已经领过了，下次刷新：' + fmtDate(st.nextRefreshAt) + '。',
        ])
      )
    } else if (st.poolSize === 0) {
      // 一张 UR/SP 都没有：**只能领基础点数**，并说清为什么没有额外点数
      actions.appendChild(
        el('div', { class: 'checkin-note' }, [
          '你还没有 UR / SP 的卡，所以这次只有基础 ' + fmt(st.base) + ' 点（额外点数是按已有卡的档位与工艺给的）。',
        ])
      )
      var baseBtn = el('button', { class: 'btn primary checkin-roll', type: 'button' }, ['签到领取 ' + fmt(st.base) + ' 点'])
      baseBtn.addEventListener('click', function () { doCheckinClaim('') })
      actions.appendChild(baseBtn)
    } else {
      var rollBtn = el('button', {
        class: 'btn primary checkin-roll',
        type: 'button',
        'data-rolls-left': String(st.rollsLeft),
      }, [st.rolls.length ? '重抽（还剩 ' + fmt(st.rollsLeft) + ' 次）' : '签到'])
      // 开满了或不能开 -> 禁用并说明（点了没反应的按钮最像坏了）
      if (!st.canRoll) {
        rollBtn.disabled = true
        rollBtn.textContent = '4 张都开出来了'
      } else {
        rollBtn.addEventListener('click', function () { doCheckinRoll() })
      }
      actions.appendChild(rollBtn)
      actions.appendChild(
        el('div', { class: 'checkin-note' }, [
          st.rolls.length
            ? '还可以重抽 ' + fmt(st.rollsLeft) + ' 次；重抽**不会**丢掉已经开出来的卡，最后从这几张里挑一张领。'
            : '点「签到」开第一张；之后可以重抽 3 次，一共 4 张里挑一张领。',
        ])
      )
    }
    /**
     * 旧机制留下的标记要说一句。
     *
     * 2026-09-19 之前是「打开页面自动送 300 点」，那个标记（`player.lastGift`）
     * 可能存在于**任何今天来过的人**的存档里。新签到不认它（见 draw.js 的
     * checkinState），但读者如果刚好记得「今天已经领过 300 点了」，会觉得这是 bug ——
     * 所以明说一句，顺便解释点数为什么会多一份。
     */
    if (st.legacyGiftToday) {
      actions.appendChild(
        el('div', { class: 'checkin-note' }, [
          '（旧版的「打开就送 300 点」今天已经发过一次；签到是另一个入口，今天照样可以领一次。）',
        ])
      )
    }
    wrap.appendChild(actions)
    wrap.appendChild(cardsBox)

    // ---- 规则说明（写清 A×B，读者才知道自己在挑什么）----------------------
    var cfg = g.dailyConfig(dataWithState())
    // 工艺清单取自 draw.js（唯一真源）；拿不到时退回三档 —— 与别处同一条纪律
    var kindKeys = [''].concat(Array.isArray(g.FOIL_IDS) ? g.FOIL_IDS : ['flat', 'full', 'shatter'])
    wrap.appendChild(
      el('div', { class: 'panel checkin-rules' }, [
        el('div', { class: 'panel-title', text: '额外点数怎么算' }),
        el('p', {
          class: 'panel-hint',
          text:
            '额外点数 = A（卡牌档位）× B（卡牌种类）。' +
            'A：' + cfg.rarities.map(function (rid) {
              var r = rarityById(rid)
              return ((r && (r.label || r.id)) || rid) + ' = ' + fmt(cfg.rarityFactor[rid] || 0)
            }).join(' / ') +
            '；B：' + kindKeys.map(function (k) {
              return (k ? foilLabel(k) : '平卡') + ' = ' + fmt(cfg.foilFactor[k] || 0)
            }).join(' / ') + '。',
        }),
        el('p', {
          class: 'panel-hint',
          text: '一张卡同时拥有多种工艺时按**最高的那一档**算（红碎 > 全闪 > 面闪 > 平卡）。纪念卡不参与抽取。',
        }),
      ])
    )

    view.appendChild(wrap)
  }

  /** 签到里那张卡的「种类」文案：平卡 / 平闪 / 全闪 / 红碎 + 档位 label（SP 不是 ???） */
  function checkinKindLabel(roll) {
    var fin = roll && roll.finish ? String(roll.finish) : ''
    var rid = (roll && roll.rarity) || ''
    var r = rarityById(rid)
    return (fin ? foilLabel(fin) : '平卡') + ' · ' + ((r && (r.label || r.id)) || rid)
  }

  /** 签到刷新的小时（读者看的那句话里要用，缺配置时按 3 点） */
  function dailyRefreshHour() {
    var g = G()
    if (g && typeof g.dailyConfig === 'function') return g.dailyConfig(dataWithState()).refreshHour
    var d = (state.data && state.data.settings && state.data.settings.daily) || {}
    return Number(d.refreshHour === undefined ? 3 : d.refreshHour)
  }

  /** 时间戳 -> 「9 月 20 日 03:00」（签到页显示下次刷新用） */
  function fmtDate(ts) {
    var d = new Date(Number(ts) || Date.now())
    var p = function (n) { return (n < 10 ? '0' : '') + n }
    return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }

  /**
   * 开一张签到候选（重抽也是它）。
   *
   * **本地先开、再同步**（与抽卡同一条架构）：随机在浏览器里，服务端负责校验与记账。
   * 之所以不「等服务端开完再用」，是因为服务端那条路由要重启才存在 ——
   * 而页面刷新就生效的那些改动不该被一个还没重启的后端卡住。同步失败时
   * **本机照样记着**，并用 toast 说清「本机记了、服务端没记」。
   */
  function doCheckinRoll() {
    var g = G()
    if (!g || typeof g.checkinRoll !== 'function') {
      toast('规则模块没加载，暂时不能签到', 'error')
      return
    }
    var st = g.checkinState(dataWithState(), Date.now())
    if (!st.canRoll) {
      toast(st.done ? '今天已经领过了' : st.poolSize === 0 ? '还没有 UR / SP 的卡可以开' : '重抽次数用完了', 'error')
      return
    }
    // 候选不重复：把今天已经开出来的卡 id 传进去（池子小的时候才不会开出两张一样的）
    var already = st.rolls.map(function (r) { return r.cardId })
    var roll = g.checkinRoll(dataWithState(), Math.random, already)
    if (!roll) {
      toast('候选已经全部开过了（池子里没有别的 UR / SP）', 'error')
      return
    }
    var local = localState()
    // `done: false` 是**明确写的**：开奖不改变「今天领过没有」，但也不能顺手把
    // 一个 true（比如旧版的遗留状态）带进去 —— 那会让领取被判成「已经领过了」
    local.checkin = { date: st.day, rolls: st.rolls.concat([roll]), claimed: '', done: false }
    saveLocal(local)
    applyStateToSnapshot({ checkin: local.checkin })
    render()
    if (BACKEND && state.unlocked) {
      // 服务端会**重算点数**并校验这张卡真的在候选池里（不信前端送的数字）
      request('/player/checkin', { method: 'POST', body: { action: 'roll', roll: roll } })
        .then(function (res) { if (res && res.player && state.data) state.data.player = res.player })
        .catch(function (err) {
          console.warn('[gacha] 签到开奖同步失败（候选已记在本机）：', err && err.message)
          toast('已在打开这张，但同步到服务端失败：' + ((err && err.message) || err), 'error')
        })
    }
  }

  /**
   * 领取某一张（`cardId` 为空串 = 池子里没有 UR/SP，只领基础点数）。
   *
   * 三道校验都在 `checkinClaimAfter` 里（今天领过没有、这张卡在不在今天的候选里、
   * 功能开着没有），本地与**服务端**用的是同一个函数 —— 点两次按钮不会翻倍。
   * 同样是「本地先记、再同步」。
   */
  function doCheckinClaim(cardId) {
    var g = G()
    if (!g || typeof g.checkinClaimAfter !== 'function') {
      toast('规则模块没加载，暂时不能签到', 'error')
      return
    }
    var after = g.checkinClaimAfter(dataWithState(), cardId, Date.now())
    if (!after.ok) {
      toast(after.reason, 'error')
      return
    }
    var local = localState()
    local.points = Math.max(0, Number(local.points || 0)) + after.points
    local.lastGift = after.date
    local.checkin = after.checkin
    saveLocal(local)
    applyStateToSnapshot({ points: local.points, lastGift: local.lastGift, checkin: local.checkin })
    render()
    toast('签到成功：+' + fmt(after.points) + ' 点' + (after.bonus ? '（额外 ' + fmt(after.bonus) + ' 点）' : ''), 'ok')
    if (BACKEND && state.unlocked) {
      request('/player/checkin', { method: 'POST', body: { action: 'claim', cardId: cardId || '' } })
        .then(function (res) { if (res && res.player && state.data) state.data.player = res.player })
        .catch(function (err) {
          console.warn('[gacha] 签到领取同步失败（点数已记在本机）：', err && err.message)
          toast('点数已记在本机，但同步到服务端失败：' + ((err && err.message) || err), 'error')
        })
    }
  }

  function viewHistory() {
    var view = state.els.view
    var wrap = el('div', { class: 'sec' })
    var hist = (player().history || []).slice()

    wrap.appendChild(
      sectionHead('抽卡记录', '最新的在最上面，最多保留 500 条。', [
        canEdit()
          ? el('button', { class: 'btn ghost small', type: 'button', 'data-bind': 'reset-player' }, ['清空记录与计数'])
          : null,
      ])
    )

    if (!hist.length) {
      wrap.appendChild(emptyBox('还没有抽过卡', ['到「抽卡」页面抽一次，这里就会列出来。']))
      view.appendChild(wrap)
      return
    }

    var stats = {}
    var dupTotal = 0
    var shardTotal = 0
    var dreamTotal = 0
    var normalTotal = 0
    hist.forEach(function (h) {
      stats[h.rarity] = (stats[h.rarity] || 0) + 1
      if (h.dream) dreamTotal++
      else normalTotal++
      if (h.duplicate) {
        dupTotal++
        shardTotal += Number(h.shards || 0)
      }
    })
    wrap.appendChild(
      el('div', { class: 'rate-row' }, rarityList().map(function (r) {
        return el('div', { class: 'rate-cell' }, [
          rarityChip(r.id),
          el('div', { class: 'rate-num', text: fmt(stats[r.id] || 0) }),
          el('div', { class: 'rate-sub', text: '次' }),
        ])
      }))
    )
    wrap.appendChild(
      el('div', { class: 'hist-summary' }, [
        el('span', { text: '重复 ' + dupTotal + ' 张' }),
        el('span', { text: '累计获得碎片 ' + shardTotal + ' 个' }),
        // 普通池 / 追梦池分开计数：两边的代价与返还都不是一套
        el('span', { class: 'hist-sum-mode', text: '普通池 ' + normalTotal + ' 抽' }),
        el('span', { class: 'hist-sum-mode', text: '追梦池 ' + dreamTotal + ' 抽' }),
        el('a', { class: 'result-link', href: '#/shards', text: '去碎片兑换 →' }),
      ])
    )

    var rows = el('div', { class: 'hist' })
    hist.slice(0, 200).forEach(function (h) {
      var card = cardById(h.cardId)
      var row = el('div', { class: 'hist-row' + (h.dream ? ' hist-dream' : '') }, [
        el('span', { class: 'hist-idx', text: '#' + fmt(h.index) }),
        // 这一抽是普通池还是追梦池（用户要求分开）——两种的代价与返还都不一样
        el('span', {
          class: 'badge-mode ' + (h.dream ? 'badge-mode-dream' : 'badge-mode-normal'),
          text: h.dream ? '追梦池' : '普通池',
          title: h.dream ? '追梦池：花抽卡券，重复卡返还点数' : '普通池：花点数，重复卡返还碎片',
        }),
        rarityChip(h.rarity),
        el('span', { class: 'hist-name', text: card ? card.name : h.cardId + '（这张卡已不在名册里）' }),
        // 这一张是闪卡：记录里也要标出来，否则「我明明抽到过红碎」查不到证据
        foilId(h.finish) ? el('span', { class: 'badge-foil-hist badge-foil-' + h.finish, text: foilLabel(h.finish) }) : null,
        h.duplicate
          ? el('span', {
              class: 'badge-dup small',
              text: h.dream
                ? '重复 +' + fmt(h.points || 0) + ' 点数'
                : '重复 +' + fmt(h.shards || 0) + ' 碎片',
            })
          : el('span', { class: 'badge-new small', text: 'NEW' }),
        h.guaranteed ? el('span', { class: 'badge-guarantee small', text: '保底' }) : null,
        el('span', { class: 'hist-time', text: fmtTime(h.at) }),
      ])
      if (!card) row.className += ' hist-missing'
      rows.appendChild(row)
    })
    wrap.appendChild(rows)
    if (hist.length > 200) {
      wrap.appendChild(el('div', { class: 'panel-hint', text: '只显示最近 200 条，共 ' + hist.length + ' 条。' }))
    }

    view.appendChild(wrap)
    var rp = view.querySelector('[data-bind="reset-player"]')
    if (rp) {
      rp.addEventListener('click', function () {
        if (!window.confirm('清空抽卡记录、累计抽数与保底计数？收集进度会重置，卡池本身不受影响。')) return
        resetPlayer()
      })
    }
  }

  function resetPlayer() {
    // 动态站清服务端，静态站清本地 —— 两边都要清，否则会出现「清了一半」
    var local = localState()
    local.pulls = 0
    local.sinceTop = 0
    local.history = []
    local.owned = {}
    local.shards = {}
    local.duplicates = 0
    // SP 保底开关也是玩家状态的一部分：收集进度清了，保底自然也该回到初始
    local.spPity = {}
    // UR 保底同理（不一起清的话，重置之后第一张 UR 会被一条没有来源的保底顶掉）
    local.urPity = {}
    saveLocal(local)
    state.last = null
    state.sinceTop = 0
    state.shardLog = []
    applyStateToSnapshot({
      owned: local.owned,
      shards: local.shards,
      duplicates: local.duplicates,
      pulls: local.pulls,
      sinceTop: local.sinceTop,
      history: local.history,
      spPity: local.spPity,
      urPity: local.urPity,
    })

    function done() {
      render()
      toast('已清空抽卡记录、收集进度与碎片', 'ok')
    }
    if (BACKEND && state.unlocked) {
      request('/player.json', { method: 'POST', body: { action: 'reset' } })
        .then(function (res) {
          if (res && res.player && state.data) state.data.player = res.player
          done()
        })
        .catch(function (err) {
          render()
          toast('本地已清空，但服务端没清成功：' + err.message, 'error')
        })
    } else {
      done()
    }
  }

  // -------------------------------------------------------------------------
  // ⑤a 公告弹窗：缺纪念卡时引导去重置（每次打开最多一次）
  // -------------------------------------------------------------------------

  /**
   * 纪念卡的持有情况。
   *
   * 🔑 **两类纪念卡的获取途径完全不同，必须分开算**（用户 2026-09-20 之后）：
   *   · `reset`  —— 重置存档时赠送（奇迹系列）。「缺不缺」只按这一批判断：
   *                公告弹窗承诺的是「重置会送全部 N 张」，把「集齐系列」的那张
   *                算进来就等于**劝读者做一件没用的事**（重置完它立刻被回收）。
   *   · `series` —— 集齐指定系列后获得，附带「还差几张」的进度。
   */
  function memorialStatus() {
    var S = window.GachaShards
    var all = S && typeof S.memorialCards === 'function' ? S.memorialCards(state.data) : []
    var resetOnes = S && typeof S.resetMemorialCards === 'function' ? S.resetMemorialCards(state.data) : all
    var seriesOnes = S && typeof S.seriesMemorialCards === 'function' ? S.seriesMemorialCards(state.data) : []
    var have = collection()
    var pick = function (list) {
      var owned = []
      var missing = []
      for (var i = 0; i < list.length; i++) {
        var c = list[i]
        if (Number(have[c.id] || 0) > 0) owned.push(c)
        else missing.push(c)
      }
      return { owned: owned, missing: missing }
    }
    var r = pick(resetOnes)
    var series = seriesOnes.map(function (c) {
      var need = S && typeof S.memorialRequirement === 'function' ? S.memorialRequirement(state.data, c, have) : null
      return { card: c, owned: Number(have[c.id] || 0) > 0, progress: need }
    })
    return {
      total: resetOnes.length,
      owned: r.owned,
      missing: r.missing,
      series: series,
      allTotal: all.length,
    }
  }

  /**
   * 这一次「打开网站」是否已经弹过。
   *
   * 两层标记缺一不可：
   *   · 内存：同一次打开里 render() 会跑很多次，只有内存标记能保证不再弹；
   *   · sessionStorage：刷新页面是**同一次打开**，不该重弹（关掉标签页才归零）。
   * 存储不可用时（隐私模式/被禁用）只靠内存标记，退化成「刷新会再弹一次」——
   * 比整个弹窗失效要好，而且不会报错。
   */
  function noticeSeen() {
    if (state.noticeShown) return true
    return ssGet(SS.notice, false) === true
  }

  function noticeMarkSeen() {
    state.noticeShown = true
    ssSet(SS.notice, true)
  }

  function closeNotice() {
    hide(state.els.noticeDialog)
  }

  /**
   * 公告：缺纪念卡 -> 引导重置。
   *
   * 只在启动时判断一次（用户要求「每次网站打开最多只弹出一次」）。
   * 判断依据是**读者自己的收藏**：动态站看服务端 player，静态站看 localStorage。
   */
  function noticeOnce() {
    var dlg = state.els.noticeDialog
    if (!dlg || !state.data) return false
    if (noticeSeen()) return false

    var st = memorialStatus()
    if (!st.total) return false // 数据里一张「重置赠送」的纪念卡都没有 —— 不弹
    if (!st.missing.length) return false // 重置那批已经集齐

    var e = state.els
    if (e.noticeTitle) e.noticeTitle.textContent = '你还没有集齐纪念卡'
    if (e.noticeLead) {
      e.noticeLead.textContent =
        '本站共有 ' + st.total + ' 张「重置赠送」的纪念卡，你已拥有 ' + st.owned.length + ' 张。' +
        '它们不在任何卡池里，也不能用碎片合成 —— 只能通过「清空缓存（重置存档）」赠送。' +
        (st.series.length
          ? '（另有 ' + st.series.length + ' 张是**集齐指定系列**获得的，重置拿不到，见图鉴「纪念」分组。）'
          : '')
    }
    if (e.noticeList) {
      clear(e.noticeList)
      st.missing.forEach(function (c) {
        e.noticeList.appendChild(el('span', { class: 'notice-item', text: '缺：' + c.name }))
      })
    }
    // 赠送的数字必须与 resetPlayer 实际给的一致 —— 两处共用 shards.js 的 resetGift
    var S = window.GachaShards
    var rs = S && typeof S.resetGift === 'function' ? S.resetGift(state.data) : { points: 0, tickets: 0 }
    if (e.noticeWarn) {
      e.noticeWarn.textContent =
        '⚠️ 重置会清空你现在的卡牌、碎片、点数与抽卡券，无法撤销。' +
        '重置后会赠送：点数 ' + rs.points +
        '、抽卡券 ' + rs.tickets +
        ' 张，以及全部 ' + st.total + ' 张纪念卡（每张同时拥有平闪 / 全闪 / 红碎）。'
    }

    noticeMarkSeen()
    showModal(dlg)
    return true
  }

  // -------------------------------------------------------------------------
  // ⑤b 板块：关注安叶喵
  // -------------------------------------------------------------------------

  /**
   * 只认 http(s) 的地址。
   *
   * 为什么必须挡：`javascript:` 与 `data:` 开头的地址塞进 href 就是一个可点的
   * XSS 入口；而这里的内容是作者在后台填的自由文本。挡下来之后**不能静默**——
   * 页面上要显示「这个链接不是 http(s)，没启用点击」（见 linkCard），
   * 否则作者只会以为「我填了但没生效」。
   */
  function httpHref(raw) {
    var s = String(raw == null ? '' : raw).trim()
    if (!s) return ''
    if (!/^https?:\/\//i.test(s)) return ''
    return s
  }

  /**
   * 「关注安叶喵」板块（参考 dsh-magical-girl-catalog 的「关注安叶！」）。
   *
   * 图片 URL 一律由服务端/导出脚本算好（`imageUrl` / `iconUrl`），前端不拼路径
   * —— 与卡面 / 卡池横幅 / 表情包同一套纪律：拼路径的规则写两份必然错位。
   */
  function viewFollow() {
    var view = state.els.view
    var wrap = el('div', { class: 'sec' })
    var links = (state.data && state.data.links) || []
    var shown = links.filter(function (ln) {
      return ln && !ln.hidden
    })

    wrap.appendChild(
      sectionHead('关注安叶喵', '找到作者与作品。世界观、角色图鉴、小说原文都从这里走。', [
        el('span', { class: 'pill', text: shown.length + ' 个入口' }),
      ])
    )

    if (!shown.length) {
      wrap.appendChild(
        emptyBox('这里还没有链接', [
          '数据里的 links 是空的，或者每一条都被标成了「隐藏」。',
          BACKEND
            ? '在「后台管理」的「关注安叶喵」一块里加一条，保存后这里就有内容。'
            : '这是静态站：内容由作者在本机改完后重新发布，读者这边改不了。',
        ])
      )
      view.appendChild(wrap)
      return
    }

    var grid = el('div', { class: 'link-grid' })
    shown.forEach(function (ln) {
      grid.appendChild(linkCard(ln))
    })
    wrap.appendChild(grid)

    // 被隐藏的条目只对作者提一句：读者看不到，也就不会怀疑「我明明加了」
    var hiddenCount = links.length - shown.length
    if (hiddenCount > 0 && canEdit()) {
      wrap.appendChild(
        el('p', { class: 'panel-hint', text: '另有 ' + hiddenCount + ' 条链接被标为「隐藏」，读者看不到（下面是全部已显示的）。' })
      )
    }

    view.appendChild(wrap)
  }

  /**
   * 一张链接卡片。三种形态，别混：
   *   · 有 http(s) 链接 -> 整张卡是可点的 `<a>`（新标签打开，rel=noopener noreferrer）
   *   · 没链接但有配图  -> 不可点，把配图放大展示（番茄小说那种扫码入口）
   *   · 链接不合法      -> 不可点，并**说明为什么**（填错时一眼看得出）
   */
  function linkCard(ln) {
    var href = httpHref(ln.url)
    var kids = [
      ln.iconUrl
        ? el('img', { referrerpolicy: 'no-referrer', class: 'link-icon-img', src: ln.iconUrl, alt: '', loading: 'lazy', draggable: 'false' })
        : el('div', { class: 'link-icon', text: ln.icon || '🔗' }),
      el('div', { class: 'link-main' }, [
        el('div', { class: 'link-title' }, [
          el('span', { class: 'link-name', text: ln.title || '（未命名链接）' }),
          ln.badge ? el('span', { class: 'link-badge', text: ln.badge }) : null,
        ]),
        ln.url ? el('div', { class: 'link-url', text: ln.url }) : null,
        ln.desc ? el('div', { class: 'link-desc', text: ln.desc }) : null,
      ]),
    ]

    // 配图单独占一行：和文字并排会被挤得很小，而扫码需要它够大
    if (ln.imageUrl) {
      kids.push(
        el('div', { class: 'link-qr' }, [
          el('img', { referrerpolicy: 'no-referrer',
            class: 'link-qr-img',
            src: ln.imageUrl,
            alt: (ln.title || '链接') + ' 的配图',
            loading: 'lazy',
            draggable: 'false',
          }),
          el('div', { class: 'link-qr-hint', text: ln.badge || '扫码打开' }),
        ])
      )
    }

    var card = href
      ? el('a', { class: 'link-card is-clickable', href: href, target: '_blank', rel: 'noopener noreferrer' }, kids)
      : el('div', { class: 'link-card is-static' }, kids)

    var holder = el('div', { class: 'link-cell' }, [card])
    // 填了地址但不合法：不做成可点的，但要把原因写在脸上
    if (ln.url && !href) {
      holder.appendChild(el('div', { class: 'link-warn', text: '⚠️ 这个地址不是 http(s)，没有启用点击：' + ln.url }))
    }
    // 既没有链接也没有配图：这张卡什么也做不了，明说
    if (!ln.url && !ln.imageUrl) {
      holder.appendChild(el('div', { class: 'link-warn', text: '⚠️ 这条既没有链接也没有配图，所以点了没有反应。' }))
    }
    return holder
  }

  // -------------------------------------------------------------------------
  // ⑥ 板块：后台管理
  // -------------------------------------------------------------------------

  function viewAdmin() {
    var view = state.els.view
    var wrap = el('div', { class: 'sec' })
    wrap.appendChild(sectionHead('后台管理', '改卡池、稀有度、图片目录与抽卡参数。'))

    if (READONLY) {
      wrap.appendChild(
        emptyBox('这是静态导出版，没有后台', [
          '静态站没有服务端，所以没有可写的地方 —— 所有编辑入口都已隐藏（不是权限不足）。',
          '要改内容请打开本机的 DSH 页面。',
        ])
      )
      view.appendChild(wrap)
      return
    }

    if (!state.unlocked) {
      wrap.appendChild(
        emptyBox('需要编辑秘钥', ['输对秘钥后才能改卡池与设置。', BACKEND ? '点右上角「解锁」。' : '这个页面没有配置后端。'], [
          el('div', { class: 'panel-actions' }, [
            el('button', { class: 'btn primary', type: 'button', 'data-bind': 'admin-unlock' }, ['输入秘钥']),
          ]),
        ])
      )
      view.appendChild(wrap)
      var bu = view.querySelector('[data-bind="admin-unlock"]')
      if (bu) bu.addEventListener('click', openUnlock)
      return
    }

    // 只读站绝不显示对话框
    if (state.els.pickDialog && state.els.pickDialog.open) hide(state.els.pickDialog)

    // --- 扫描卡池 ---------------------------------------------------------
    wrap.appendChild(
      el('div', { class: 'panel' }, [
        el('div', { class: 'panel-title', text: '① 扫描卡池' }),
        el('p', { class: 'panel-hint', text: '把受控目录里的图片扫成卡牌，角色名取自图片文件名。只补新图，不动已有条目的名字与稀有度。' }),
        el('div', { class: 'panel-actions' }, [
          el('button', { class: 'btn primary', type: 'button', 'data-bind': 'scan-add' }, ['扫描并补入新图']),
          el('button', { class: 'btn', type: 'button', 'data-bind': 'scan-replace' }, ['扫描并重建整个名册']),
          el('button', { class: 'btn ghost', type: 'button', 'data-bind': 'scan-images' }, ['看看目录里有哪些图']),
        ]),
        el('div', { class: 'panel-out', 'data-bind': 'scan-out' }),
      ])
    )

    // --- 设置 -------------------------------------------------------------
    // 这些字段都按「可能缺失」处理：服务端 normalize 会补齐它们，但前端不该因为
    // 一个可选字段缺失就整页崩掉（实测 s.imageDirs.join 会让整个后台白屏）。
    var s = state.data.settings || {}
    var imageDirs = Array.isArray(s.imageDirs) ? s.imageDirs : []
    wrap.appendChild(
      el('div', { class: 'panel' }, [
        el('div', { class: 'panel-title', text: '② 站点设置' }),
        field('标题', input('text', s.title, 'set-title')),
        field('副标题', input('text', s.subtitle, 'set-subtitle')),
        field('首页背景图（文件名或绝对路径）', input('text', s.coverImage, 'set-cover')),
        field('卡面比例（形如 2/3 或 832/1216）', input('text', s.cardRatio || '2/3', 'set-ratio')),
        field('图片目录（一行一个，受控白名单）', textarea(imageDirs.join('\n'), 3, 'set-dirs')),
        // 图片镜像：国内直连 GitHub Pages 慢/超时的解法（只有静态站用得上）。
        // 留空 = 关掉。填错（不是 http(s)）时脚本会打印一次警告并当作没填。
        field('图片镜像基址（可空，例 https://gitee.com/用户/仓库/raw/main/）', input('text', s.imageMirror, 'set-mirror')),
        field('图片镜像回退基址（可空，镜像挂了时用）', input('text', s.imageFallback, 'set-mirror-fallback')),
        field('页脚说明', input('text', s.footerNote, 'set-foot')),
        el('div', { class: 'panel-actions' }, [
          el('button', { class: 'btn primary', type: 'button', 'data-bind': 'save-settings' }, ['保存设置']),
        ]),
      ])
    )

    // --- 抽卡参数 ---------------------------------------------------------
    var pull = s.pull || {}
    wrap.appendChild(
      el('div', { class: 'panel' }, [
        el('div', { class: 'panel-title', text: '③ 抽卡参数' }),
        field('单抽消耗', input('number', pull.costSingle, 'pull-single')),
        field('十连消耗（留空 = 单抽 × 10）', input('number', pull.costTen === null ? '' : pull.costTen, 'pull-ten')),
        field(
          '十连保底档位（留空 = 不保底）',
          select(
            [''].concat(rarityList().map(function (r) { return r.id })),
            pull.tenPullGuarantee || '',
            'pull-guarantee'
          )
        ),
        field('保底抽数（0 = 不启用）', input('number', pull.pityMax, 'pull-pity')),
        field('是否允许重复获得（关掉会让碎片系统失效）', select(['true', 'false'], String(pull.allowDuplicates !== false), 'pull-dup')),
        el('div', { class: 'panel-actions' }, [
          el('button', { class: 'btn primary', type: 'button', 'data-bind': 'save-pull' }, ['保存抽卡参数']),
        ]),
        el('p', { class: 'panel-hint', text: '出率权重在下面的卡池里改。' }),
      ])
    )

    // --- 碎片规则 ---------------------------------------------------------
    var shardCfg = s.shards || {}
    var ticketCfg = shardCfg.tickets || {}
    wrap.appendChild(
      el('div', { class: 'panel' }, [
        el('div', { class: 'panel-title', text: '③-2 碎片规则' }),
        el('p', { class: 'panel-hint', text: '抽到重复的卡（图鉴里已解锁过）会转化成对应稀有度的碎片。' }),
        field('每张重复卡给几个碎片', input('number', shardCfg.perDuplicate, 'shard-per')),
        field('兑换一张同档卡牌需要几个碎片', input('number', shardCfg.costForCard, 'shard-card')),
        field('升一级稀有度需要几个碎片', input('number', shardCfg.costForUpgrade, 'shard-up')),
        el('p', { class: 'panel-hint', text: '碎片 → 抽卡券（抽卡券用在追梦池；填 0 张 = 这一档不开放兑换）：' }),
        el('div', { class: 'panel-sub' }, rarityList().map(function (r) {
          // 快照里没配这一档时显示**默认比例**（而不是空框）—— 留空会让人以为
          // 「这一档没配」，而实际生效的是默认值
          var raw = ticketCfg[r.id] || (window.GachaShards && window.GachaShards.TICKET_DEFAULTS && window.GachaShards.TICKET_DEFAULTS[r.id]) || {}
          return field(
            (r.label || r.id) + ' · 几个碎片',
            input('number', raw.shards === undefined ? '' : raw.shards, 'ticket-shards-' + r.id, r.id)
          )
        })),
        el('div', { class: 'panel-sub' }, rarityList().map(function (r) {
          var raw = ticketCfg[r.id] || (window.GachaShards && window.GachaShards.TICKET_DEFAULTS && window.GachaShards.TICKET_DEFAULTS[r.id]) || {}
          return field(
            (r.label || r.id) + ' · 换几张券',
            input('number', raw.tickets === undefined ? '' : raw.tickets, 'ticket-gain-' + r.id, r.id)
          )
        })),
        el('div', { class: 'panel-actions' }, [
          el('button', { class: 'btn primary', type: 'button', 'data-bind': 'save-shards' }, ['保存碎片规则']),
        ]),
        el('p', { class: 'panel-hint', text: '升档是「N 个碎片 -> 1 个更高一级的碎片」。如果你的意思是「N 个碎片 -> N 个更高一级的碎片」，把上面的升档数改成 1 即可。' }),
      ])
    )

    // --- 表情包与抽卡动画 -------------------------------------------------
    //
    // 这两块以前只能改 data.json 或跑命令行（`import-art.mjs --emoji-dir`）——
    // 属于「功能在、但读者够不着」。它们的形状都是「一组按档位来的值 + 几个全局数值」，
    // 所以放一块儿。
    //
    // ⚠️ 表情包目录是**受控白名单**：只有列在这里的目录里的图才会被转发。
    // 与 `图片目录` 分开是本项目的既有约束 —— 合在一起的话「扫描卡池」会把表情包
    // 当成卡牌扫进名册（见 lib/data.js 的 scanningImageRoots）。
    var emojiDirs = Array.isArray(s.emojiDirs) ? s.emojiDirs : []
    var poolUiDirs = Array.isArray(s.poolUiDirs) ? s.poolUiDirs : []
    var emojiMap = s.emoji || {}
    var rv = s.reveal || {}
    var rvColors = rv.colors || {}
    var emojiRarities = Array.isArray(rv.emojiRarities) ? rv.emojiRarities : []
    var rarityOpts = rarityList()
    wrap.appendChild(
      el('div', { class: 'panel' }, [
        el('div', { class: 'panel-title', text: '③-3 表情包与抽卡动画' }),
        el('p', { class: 'panel-hint', text: '表情包目录是受控白名单：只有列在这里的目录里的图才会被转发（与「图片目录」分开，否则扫描卡池会把表情包当成卡牌）。' }),
        field('表情包目录（一行一个，受控白名单）', textarea(emojiDirs.join('\n'), 3, 'emoji-dirs')),
        // 卡池 UI（横幅）目录：和表情包一样必须与「图片目录」分开 ——
        // 合在一起的话「扫描卡池」会把横幅当成卡牌扫进名册。
        field('卡池 UI 目录（主视觉/横幅，一行一个，受控白名单）', textarea(poolUiDirs.join('\n'), 3, 'pool-ui-dirs')),
        // 关注页配图目录：同样只转发、不扫描（放 imageDirs 里会被扫成一张卡）
        field('关注页配图目录（扫码图等，一行一个，受控白名单）', textarea((Array.isArray(s.linkDirs) ? s.linkDirs : []).join('\n'), 2, 'link-dirs')),
        // 动态卡面（HR）目录：视频走 api/media，同样只转发、不扫描
        field('动态卡面（HR）目录（mp4 / webm，一行一个，受控白名单）', textarea((Array.isArray(s.dynamicDirs) ? s.dynamicDirs : []).join('\n'), 2, 'dynamic-dirs')),
        el('div', { class: 'panel-sub' }, rarityOpts.map(function (r) {
          return field(
            '表情包 · ' + (r.label || r.id) + '（文件名，留空 = 这一档不弹）',
            input('text', emojiMap[r.id] || '', 'emoji-file-' + r.id, r.id)
          )
        })),
        field('抽卡动画（关掉就点一下直接出结果）', select(['true', 'false'], String(rv.enabled !== false), 'reveal-enabled')),
        el('div', { class: 'panel-sub' }, [
          field('背景暗度 · 起始（0~1）', input('number', rv.backdropBase, 'reveal-backdrop-base')),
          field('背景暗度 · 每张递增（0~1）', input('number', rv.backdropStep, 'reveal-backdrop-step')),
          field('拖动时放大（0~1）', input('number', rv.dragScale, 'reveal-drag-scale')),
          field('最高档拖动时放大（0~1）', input('number', rv.dragScaleTop, 'reveal-drag-scale-top')),
        ]),
        el('div', { class: 'panel-sub' }, rarityOpts.map(function (r) {
          return field('纯色卡颜色 · ' + (r.label || r.id) + '（#rrggbb）', input('text', rvColors[r.id] || '', 'reveal-color-' + r.id, r.id))
        })),
        el('div', { class: 'field' }, [
          el('span', { class: 'field-label', text: '哪些档位弹表情包' }),
          el('div', { class: 'checks' }, rarityOpts.map(function (r) {
            var box = el('input', { type: 'checkbox', 'data-bind': 'reveal-emoji-' + r.id, 'data-key': r.id })
            box.checked = emojiRarities.indexOf(r.id) >= 0
            return el('label', { class: 'check' }, [box, el('span', { text: r.label || r.id })])
          })),
        ]),
        el('div', { class: 'panel-actions' }, [
          el('button', { class: 'btn primary', type: 'button', 'data-bind': 'save-reveal' }, ['保存表情包与动画']),
        ]),
        el('p', { class: 'panel-hint', text: '表情包文件名写相对路径或受控目录内的绝对路径都行；转发 URL 由服务端算好下发。' }),
      ])
    )

    // --- 特殊工艺（闪卡）--------------------------------------------------
    //
    // 概率与门槛以前只能改 data.json —— 功能在，但作者够不着。它们的形状是
    // 「一门工艺一组值」，所以和表情包那块一样，按 FOIL_KINDS 铺一行一个。
    //
    // ⚠️ 门槛用**档位 id**，判定时比的是档位表里的 rank。写了档位表里没有的 id
    // 时刻意**不改成「不限制」**（那会把稀有工艺放给所有卡），而是让这门工艺出不来；
    // 这里把它当成一个选项显示出来，作者一眼能看出是哪一档写错了。
    var foilCfg = s.foils || {}
    var foilRates = foilCfg.rates || {}
    var foilMins = foilCfg.minRarity || {}
    var foilKindsUi = foilKinds()
    /**
     * 一门工艺的「最低稀有度」下拉框。
     *
     * 当前值**不在档位表里**时，额外加一个把它原样显示出来的选项：
     * 不加的话下拉框会静默落到第一个选项（= 不限制），作者一保存就把
     * 「这一档不会出」这个事实改成了「所有卡都能出」—— 稀有工艺会突然泛滥，
     * 而且没有任何迹象表明是保存按钮干的。
     */
    function foilMinSelect(k) {
      var ids = rarityList().map(function (r) { return r.id })
      var cur = String(foilMins[k.id] === undefined ? k.minRarity || '' : foilMins[k.id] || '')
      var sel = el('select', { 'data-bind': 'foil-min-' + k.id })
      var none = el('option', { value: '', text: '不限制（所有档位都能出）' })
      none.selected = !cur
      sel.appendChild(none)
      rarityList().forEach(function (r) {
        var o = el('option', { value: r.id, text: (r.label || r.id) + ' 及以上' })
        if (r.id === cur) o.selected = true
        sel.appendChild(o)
      })
      if (cur && ids.indexOf(cur) < 0) {
        var bad = el('option', { value: cur, text: cur + '（档位表里没有这一档 —— 这一档不会出）' })
        bad.selected = true
        sel.appendChild(bad)
      }
      return sel
    }
    wrap.appendChild(
      el('div', { class: 'panel' }, [
        el('div', { class: 'panel-title', text: '③-4 特殊工艺（闪卡）' }),
        el('p', {
          class: 'panel-hint',
          text:
            '只改视觉，卡图不动。判定是「一掷定档」：先看最稀有的那一档，再看低一档 —— ' +
            '所以每一档的实测概率就是这里填的数。某一档因为稀有度门槛不适用时，' +
            '它的概率**不会**并到低档去（低档卡拿不到高档工艺）。',
        }),
        field('开启特殊工艺（关掉 = 永远出普通卡）', select(['true', 'false'], String(foilCfg.enabled !== false), 'foil-enabled')),
        el('div', { class: 'panel-sub' }, foilKindsUi.map(function (k) {
          return field(
            (k.label || k.id) + ' · 概率（%，0 = 不出这一档）',
            input('number', String(foilRates[k.id] === undefined ? '' : foilRates[k.id]), 'foil-rate-' + k.id, k.id)
          )
        })),
        el('div', { class: 'panel-sub' }, foilKindsUi.map(function (k) {
          return field((k.label || k.id) + ' · 最低稀有度', foilMinSelect(k))
        })),
        foilKindsUi.length ? null : el('p', { class: 'panel-hint', text: 'page/draw.js 没加载成功，读不到工艺定义。' }),
        el('div', { class: 'panel-actions' }, [
          el('button', { class: 'btn primary', type: 'button', 'data-bind': 'save-foils' }, ['保存特殊工艺']),
        ]),
        el('p', { class: 'panel-hint', text: '概率是百分数，和出率表同一套写法：20 = 每一百张里约二十张。留空按 0 处理。' }),
      ])
    )

    // --- 概率自检（用户要求：检测真实概率是否与标称概率一致）----------------
    //
    // 为什么放在后台：这是一把**尺子**，不是给读者看的东西。
    // 它当场跑几万次模拟，把每个池子（含追梦模式）的实测出率与标称并排摆出来。
    // 追梦池的概率是随次数变化的，所以基准取 `dreamLongRunRates` 的**解析长期平均**
    // （拿「第 0 次的 2.5%」去比会得出一堆假偏差 —— 那正是这套机制自带的坑）。
    wrap.appendChild(
      el('div', { class: 'panel' }, [
        el('div', { class: 'panel-title', text: '③-5 概率自检（模拟抽卡，实测 vs 标称）' }),
        el('p', {
          class: 'panel-hint',
          text:
            '在这里跑一批纯模拟抽卡（不消耗你的券、不改你的记录），把每一档的实测出率与标称摆在一起。' +
            '容差 = 3σ + 0.3 个百分点（σ 是二项分布标准差），极小概率的档位不会因为抖动被判失败。',
        }),
        el('div', { class: 'panel-actions' }, [
          field('模拟抽数', input('number', 200000, 'audit-draws')),
          el('button', { class: 'btn primary', type: 'button', 'data-bind': 'run-audit' }, ['跑一次概率自检']),
        ]),
        el('div', { class: 'panel-out audit-out', 'data-bind': 'audit-out' }),
      ])
    )

    // --- 卡池 -------------------------------------------------------------
    state.data.pools.forEach(function (p) {
      var weightRows = rarityList().map(function (r) {
        return field(
          '权重 · ' + (r.label || r.id),
          input('number', p.weights && p.weights[r.id] !== undefined ? p.weights[r.id] : '', 'w-' + p.id + '-' + r.id, r.id)
        )
      })
      // 系列清单 = 这个池子收哪些系列（一行一个 / 逗号分隔）。
      // 「常驻」是「不属于任何系列」的哨兵 —— 美术目录里写的就是 `（常驻）`。
      var seriesArea = el('textarea', { class: 'input series-input', rows: '4', spellcheck: 'false' })
      seriesArea.value = (p.series || []).join('\n')
      seriesArea.setAttribute('data-bind', 'pool-series-' + p.id)
      // 封面的候选项就是名册里所有卡（按系列分组，方便找）
      var coverSel = el('select', { class: 'input' })
      coverSel.setAttribute('data-bind', 'pool-cover-' + p.id)
      coverSel.appendChild(el('option', { value: '', text: '（不设封面）' }))
      state.data.cards.forEach(function (c) {
        var o = el('option', { value: c.id, text: (c.name || c.id) + '　' + (c.series ? '[' + c.series + ']' : '[常驻]') })
        if (p.coverCardId === c.id) o.setAttribute('selected', '')
        coverSel.appendChild(o)
      })
      var playableNow = Object.keys(p.byRarity || {}).reduce(function (n, k) {
        return n + ((p.byRarity[k] || []).length)
      }, 0)
      // 排除规则：一行一条，`系列` 或 `系列:档位1,档位2`。
      // 例：`常驻:SR,SSR` = 收「常驻」这个系列，但不要它的 SR 与 SSR。
      var excludeArea = el('textarea', { class: 'input series-input', rows: '2', spellcheck: 'false', 'data-bind': 'pool-exclude-' + p.id })
      excludeArea.value = (p.exclude || [])
        .map(function (r) {
          var rs = Array.isArray(r.rarities) ? r.rarities : []
          return rs.length ? r.series + ':' + rs.join(',') : r.series
        })
        .join('\n')
      wrap.appendChild(
        el('div', { class: 'panel' }, [
          el('div', { class: 'panel-title' }, [
            el('span', { text: '卡池：' }),
            input('text', p.name, 'pool-name-' + p.id),
            el('span', { class: 'panel-hint', text: '  可抽 ' + playableNow + ' 张' }),
          ]),
          field('说明', input('text', p.desc, 'pool-desc-' + p.id)),
          field('收哪些系列（一行一个；「常驻」= 不属于任何系列；留空 = 收全部）', seriesArea),
          field('不要哪些（一行一个：`系列` 或 `系列:档位1,档位2`，例 `常驻:SR,SSR`；留空 = 不排除）', excludeArea),
          field('封面卡', coverSel),
          el('div', { class: 'weight-grid' }, weightRows),
          // 追梦池：每个池子一份（出率 / 工艺概率 / 票价 / 动态概率步进）
          dreamFields(p),
          el('div', { class: 'panel-actions' }, [
            el('button', { class: 'btn primary', type: 'button', 'data-bind': 'save-pool-' + p.id }, ['保存这个卡池']),
            el('button', { class: 'btn ghost', type: 'button', 'data-bind': 'del-pool-' + p.id }, ['删除']),
          ]),
        ])
      )
    })
    /**
     * 一个卡池的「追梦池」配置区（用户要求：为现有卡池增加追梦池的切换选项）。
     *
     * 折在一个 `<details>` 里：普通出率那块是天天要看的，追梦这块是偶尔调的，
     * 摊平会把卡池面板撑得找不到重点。
     */
    function dreamFields(p) {
      var d = p.dream || {}
      var dw = d.weights || {}
      var dr = d.foilRates || {}
      var dc = d.cost || {}
      var box = el('details', { class: 'dream-admin' }, [
        el('summary', { text: '追梦池设置（切换项 · 另一套概率 · 花抽卡券）' }),
        el('p', {
          class: 'panel-hint',
          text:
            '读者在抽卡页可以把这个池子切到「追梦池」：出率换成下面这套、工艺概率上调、' +
            '并且按这里的票价扣抽卡券（普通模式依旧免费）。' +
            '动态概率：每抽一次最高档 +' + (d.spStep === undefined ? 0.1 : d.spStep) + '%、' +
            (d.spFrom || 'SR') + ' -同样多，最多累计 ' + (d.spMaxSteps === undefined ? 75 : d.spMaxSteps) + ' 次，抽到最高档重置。',
        }),
        field('提供追梦池切换项（关掉 = 这个池子只有普通模式）', select(['true', 'false'], String(d.enabled !== false), 'dream-on-' + p.id)),
        el('div', { class: 'panel-sub' }, rarityList().map(function (r) {
          return field(
            '追梦权重 · ' + (r.label || r.id),
            input('number', dw[r.id] === undefined ? '' : dw[r.id], 'dream-w-' + p.id + '-' + r.id, r.id)
          )
        })),
        el('div', { class: 'panel-sub' }, foilKinds().map(function (k) {
          return field(
            '追梦工艺概率 · ' + (k.label || k.id) + '（%）',
            input('number', dr[k.id] === undefined ? '' : dr[k.id], 'dream-foil-' + p.id + '-' + k.id, k.id)
          )
        })),
        el('div', { class: 'panel-sub' }, [
          field('单抽要几张券', input('number', dc.single === undefined ? 1 : dc.single, 'dream-cost1-' + p.id)),
          field('十连要几张券', input('number', dc.ten === undefined ? 10 : dc.ten, 'dream-cost10-' + p.id)),
        ]),
        el('div', { class: 'panel-sub' }, [
          field('每次涨多少（百分点）', input('number', d.spStep === undefined ? 0.1 : d.spStep, 'dream-step-' + p.id)),
          field('从哪一档扣', select(rarityList().map(function (r) { return r.id }), d.spFrom || 'SR', 'dream-from-' + p.id)),
          field('最多累计几次', input('number', d.spMaxSteps === undefined ? 75 : d.spMaxSteps, 'dream-max-' + p.id)),
        ]),
      ])
      return box
    }

    wrap.appendChild(
      el('div', { class: 'panel-actions' }, [
        el('button', { class: 'btn', type: 'button', 'data-bind': 'add-pool' }, ['新建一个卡池']),
      ])
    )

    // --- 卡牌名册 ---------------------------------------------------------
    var allSeries = Array.from(
      new Set(
        state.data.cards
          .map(function (c) { return c.series })
          .filter(Boolean)
      )
    )
    var seriesList = el('datalist', { id: 'gacha-series-list' })
    allSeries.forEach(function (nm) {
      var opt = el('option', { value: nm })
      seriesList.appendChild(opt)
    })

    wrap.appendChild(
      el('div', { class: 'panel' }, [
        el('div', { class: 'panel-title', text: '④ 卡牌名册（' + state.data.cards.length + ' 张）' }),
        el('p', { class: 'panel-hint', text: '系列：填了同一个系列名的卡在图鉴里会**一起显示**（系列组排在最前）。系列内序用来控制组内顺序，小的在前。' }),
        seriesList,
        el('div', { class: 'table-wrap' }, [
          buildCardTable(),
        ]),
      ])
    )

    // --- 关注安叶喵（链接卡片） -------------------------------------------
    //
    // 「关注安叶喵」板块的内容源。整份一起存（`POST api/links.json`）：链接最多
    // 几十条，一条一条做增删改反而会出现「删了 A 又加了 B，顺序乱了」这类问题。
    //
    // ⚠️ 「新增一条」是**就地插一行**，不是重新渲染整个后台：后台里还有几十个
    // 输入框（卡池权重、卡牌表），重画一次就会把作者刚填、还没保存的内容全丢掉。
    var linkRows = el('div', { class: 'link-admin-rows', 'data-bind': 'link-rows' })
    ;(Array.isArray(state.data.links) ? state.data.links : []).forEach(function (ln) {
      linkRows.appendChild(linkAdminRow(ln))
    })
    wrap.appendChild(
      el('div', { class: 'panel' }, [
        el('div', { class: 'panel-title', text: '④-2 关注安叶喵（链接卡片）' }),
        el('p', {
          class: 'panel-hint',
          text:
            '顶栏「关注安叶喵」页面上的卡片。配图要放在上面的「关注页配图目录」里（只转发、不会被当成卡牌扫进名册）；' +
            '图标位填 emoji 就画 emoji，填图片文件名就画图。',
        }),
        linkRows,
        el('div', { class: 'panel-actions' }, [
          el('button', { class: 'btn', type: 'button', 'data-bind': 'link-add' }, ['新增一条']),
          el('button', { class: 'btn primary', type: 'button', 'data-bind': 'save-links' }, ['保存链接']),
        ]),
      ])
    )

    // --- 红碎补偿 ---------------------------------------------------------
    // 用户 2026-09-19：「抽到已经有了的红碎 -> 返 10 张抽卡券 + 下次十连必出
    // 一张同品质的未拥有红碎」。返券数写成可配（0 = 只给欠条不给券）。
    var scCfg = s.shatterComp || {}
    wrap.appendChild(
      el('div', { class: 'panel' }, [
        el('div', { class: 'panel-title', text: '③-6 红碎补偿' }),
        el('p', {
          class: 'panel-hint',
          text:
            '抽到**已经有了的红碎**时：返下面这个数量的抽卡券，并且欠你一张「下次十连必出的、' +
            '同档位且你还没有的红碎」。UR 的红碎欠 UR，SP 的红碎欠 SP。' +
            '如果这一档的红碎**已经集齐**（给不出未拥有的了），就改按「已集齐时返还」那个数量返券，不再欠必出 —— ' +
            '这是为了防止欠条永远兑现不了。',
        }),
        field('启用', select(['true', 'false'], String(scCfg.enabled !== false), 'comp-on')),
        field('每次返还几张抽卡券', input('number', scCfg.tickets === undefined ? 10 : scCfg.tickets, 'comp-tickets')),
        field('这一档红碎已集齐时返还几张', input('number', scCfg.fullTickets === undefined ? 20 : scCfg.fullTickets, 'comp-full-tickets')),
        el('div', { class: 'panel-actions' }, [
          el('button', { class: 'btn primary', type: 'button', 'data-bind': 'save-comp' }, ['保存红碎补偿']),
        ]),
        el('p', { class: 'panel-hint', text: '欠条是按档位记次数的；单抽不会消耗欠条（用户说的是「下次十连」）。' }),
      ])
    )

    // --- 每日签到 / HR / 重复闪卡返还（用户 2026-09-19 那一批）-------------
    var dailyCfg = s.daily || {}
    var hrCfg2 = s.hr || {}
    // 红碎兑换价（按档位）：缺字段时用 30 / 50（与 lib/data.js 的 defaultHr 一致）
    var shatterCostCfg = hrCfg2.shatterCost && typeof hrCfg2.shatterCost === 'object' ? hrCfg2.shatterCost : {}
    var dupCfg = s.dupReward || {}
    var rf = dailyCfg.rarityFactor || {}
    var ff = dailyCfg.foilFactor || {}
    var A_IDS = Array.isArray(dailyCfg.rarities) && dailyCfg.rarities.length ? dailyCfg.rarities : ['UR', '???']
    wrap.appendChild(
      el('div', { class: 'panel' }, [
        el('div', { class: 'panel-title', text: '③-7 每日签到 / HR 动态卡面 / 重复闪卡返还' }),
        el('p', {
          class: 'panel-hint',
          text:
            '每日点数改成**签到领取**（不再自动发放）：基础点数额度 + 从已拥有的 UR/SP 里随机开一张，' +
            '按「A（档位）× B（工艺）」给额外点数；可以重抽几次，最后从开出来的那几张里挑一张领。' +
            '凌晨按下面的小时刷新（本地时间）。',
        }),
        field('启用签到', select(['true', 'false'], String(dailyCfg.enabled !== false), 'daily-on')),
        field('每天基础点数', input('number', dailyCfg.points === undefined ? 400 : dailyCfg.points, 'daily-points')),
        field('重抽次数（1 + 这个数 = 候选张数）', input('number', dailyCfg.rerolls === undefined ? 3 : dailyCfg.rerolls, 'daily-rerolls')),
        field('几点刷新（0~23）', input('number', dailyCfg.refreshHour === undefined ? 3 : dailyCfg.refreshHour, 'daily-hour')),
        el('div', { class: 'panel-sub', text: 'A：档位系数（只有下面这两档能被开出来）' }),
        field('A · ' + ((rarityById('UR') || {}).label || 'UR') + '（UR）', input('number', rf.UR === undefined ? 2 : rf.UR, 'daily-a-UR')),
        field('A · ' + ((rarityById('???') || {}).label || 'SP') + '（SP）', input('number', rf['???'] === undefined ? 5 : rf['???'], 'daily-a-sp')),
        el('div', { class: 'panel-sub', text: 'B：工艺系数' }),
        field('B · 平卡（没有任何工艺）', input('number', ff[''] === undefined ? 1 : ff[''], 'daily-b-none')),
        field('B · ' + foilLabel('flat'), input('number', ff.flat === undefined ? 2 : ff.flat, 'daily-b-flat')),
        field('B · ' + foilLabel('full'), input('number', ff.full === undefined ? 5 : ff.full, 'daily-b-full')),
        field('B · ' + foilLabel('shatter'), input('number', ff.shatter === undefined ? 15 : ff.shatter, 'daily-b-shatter')),
        el('p', {
          class: 'panel-hint',
          text:
            'HR 动态卡面：**不能抽取**，只能用 HR 碎片兑换（下面这个数量）。' +
            '动态卡面与原卡面共享特殊工艺 —— 原卡有平闪/全闪/红碎，动态形态也一样。',
        }),
        field('兑换一张动态卡面要几个 HR 碎片', input('number', hrCfg2.shards === undefined ? 20 : hrCfg2.shards, 'hr-shards')),
        field('启用 HR 兑换', select(['true', 'false'], String(hrCfg2.enabled !== false), 'hr-on')),
        el('p', {
          class: 'panel-hint',
          text:
            '红碎兑换：拥有某张 UR/SP 的**全闪**之后，可以在图鉴大图里花 HR 碎片直接换它的红碎工艺。' +
            '（用户 2026-09-22：「消耗 30/50 点 HR 碎片兑换对应的红碎工艺」。）',
        }),
        field('换 UR 的红碎要几个 HR 碎片', input('number', shatterCostCfg.UR === undefined ? 30 : shatterCostCfg.UR, 'shatter-cost-ur')),
        field('换 SP 的红碎要几个 HR 碎片', input('number', shatterCostCfg['???'] === undefined ? 50 : shatterCostCfg['???'], 'shatter-cost-sp')),
        el('p', {
          class: 'panel-hint',
          text:
            '重复的**闪卡**额外返还（普通池与逐梦池都给）：面闪再给一点点数，全闪再给 1 个 HR 碎片（HR 碎片是换动态卡面用的）。',
        }),
        field('重复' + foilLabel('flat') + '额外返几点', input('number', dupCfg.flatPoints === undefined ? 1 : dupCfg.flatPoints, 'dup-flat-points')),
        field('重复' + foilLabel('full') + '额外返几个 HR 碎片', input('number', dupCfg.fullHrShards === undefined ? 1 : dupCfg.fullHrShards, 'dup-full-hr')),
        el('div', { class: 'panel-actions' }, [
          el('button', { class: 'btn primary', type: 'button', 'data-bind': 'save-daily' }, ['保存这一组']),
        ]),
        el('p', { class: 'panel-hint', text: '当前能被开出来的档位：' + A_IDS.map(function (rid) {
          var r = rarityById(rid)
          return (r && (r.label || r.id)) || rid
        }).join(' / ') + '（用户要求只有 UR / SP；要改档位清单请直接改 data.json 的 settings.daily.rarities）。' }),
      ])
    )

    // --- 秘钥 -------------------------------------------------------------
    wrap.appendChild(
      el('div', { class: 'panel' }, [
        el('div', { class: 'panel-title', text: '⑤ 编辑秘钥' }),
        el('p', { class: 'panel-hint', text: '换一枚新秘钥会让旧秘钥与所有已解锁的浏览器立即失效。' }),
        el('div', { class: 'panel-actions' }, [
          el('button', { class: 'btn', type: 'button', 'data-bind': 'rotate-key' }, ['换一枚新秘钥']),
          el('button', { class: 'btn ghost', type: 'button', 'data-bind': 'lock' }, ['锁定当前浏览器']),
        ]),
        el('div', { class: 'panel-out', 'data-bind': 'key-out' }),
      ])
    )

    view.appendChild(wrap)
    wireAdmin(view)
  }

  function field(label, control) {
    return el('label', { class: 'field' }, [
      el('span', { class: 'field-label', text: label }),
      control,
    ])
  }

  function input(type, value, bind, dataKey) {
    var attrs = { type: type, value: value === undefined || value === null ? '' : value, 'data-bind': bind }
    if (dataKey) attrs['data-key'] = dataKey
    return el('input', attrs)
  }

  function textarea(value, rows, bind) {
    var t = el('textarea', { rows: rows || 3, 'data-bind': bind })
    t.value = value === undefined || value === null ? '' : String(value)
    return t
  }

  function select(options, value, bind) {
    var s = el('select', { 'data-bind': bind })
    options.forEach(function (o) {
      var opt = el('option', { value: o, text: o === '' ? '(不保底)' : o })
      if (String(o) === String(value)) opt.selected = true
      s.appendChild(opt)
    })
    return s
  }

  /**
   * 后台里的一条「关注安叶喵」链接行。
   *
   * 抽成模块级函数（而不是写在 viewAdmin 里）是因为**两个地方都要用它**：
   * 渲染已有条目（viewAdmin）与「新增一条」（wireAdmin）。写在 viewAdmin 里的话，
   * 新增按钮就只能靠重新渲染整个后台来显示新行 —— 那会把作者刚填、还没保存的
   * 内容全部丢掉。
   *
   * 每个输入框都带 `data-bind` 名字（不带序号）：读取时是**按行**查
   * （row.querySelector），所以同名不会互相干扰。
   */
  function linkAdminRow(ln) {
    var src = ln || {}
    var row = el('div', { class: 'panel-sub link-admin', 'data-link-row': '', 'data-link-id': src.id || '' }, [
      field('名称', input('text', src.title, 'link-title')),
      field('链接（http:// 或 https:// 开头；留空 = 不可点，只展示配图）', input('text', src.url, 'link-url')),
      field('图标（一个 emoji，或图片文件名）', input('text', src.icon, 'link-icon')),
      field('角标（如「扫码阅读」，留空则不显示）', input('text', src.badge, 'link-badge')),
      field('说明', textarea(src.desc, 2, 'link-desc')),
      field('配图（文件名或绝对路径，例如 番茄小说分享图.jpg）', input('text', src.image, 'link-image')),
      field('隐藏（读者看不到）', select(['false', 'true'], String(!!src.hidden), 'link-hidden')),
      el('div', { class: 'panel-actions' }, [
        el('button', { class: 'btn ghost', type: 'button', 'data-link-del': '' }, ['删除这一条']),
      ]),
    ])
    var del = row.querySelector('[data-link-del]')
    if (del) {
      del.addEventListener('click', function () {
        row.remove()
      })
    }
    return row
  }

  function buildCardTable() {
    var table = el('table', { class: 'table' })
    table.appendChild(
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: '卡面' }),
          el('th', { text: '角色名' }),
          el('th', { text: '稀有度' }),
          el('th', { text: '系列' }),
          el('th', { text: '系列内序' }),
          el('th', { text: '图片' }),
          el('th', { text: '动态卡面' }),
          el('th', { text: '状态' }),
          el('th', { text: '操作' }),
        ]),
      ])
    )
    var body = el('tbody')
    var rarities = rarityList()
    // 已用过的系列名：做成 datalist 提示，避免同一个系列因为多打一个空格被拆成两组
    var seriesNames = Array.from(
      new Set(
        state.data.cards
          .map(function (c) { return c.series })
          .filter(Boolean)
      )
    )
    state.data.cards.forEach(function (c) {
      var thumb = el('div', { class: 'thumb' })
      if (c.imageUrl) thumb.appendChild(el('img', { referrerpolicy: 'no-referrer', src: c.imageUrl, alt: c.name, loading: 'lazy' }))
      else thumb.appendChild(el('span', { class: 'thumb-none', text: '无图' }))

      var sel = el('select', { 'data-card-rarity': c.id })
      var none = el('option', { value: '', text: '(未设置)' })
      if (!c.rarity) none.selected = true
      sel.appendChild(none)
      rarities.forEach(function (r) {
        var o = el('option', { value: r.id, text: r.label || r.id })
        if (r.id === c.rarity) o.selected = true
        sel.appendChild(o)
      })

      var seriesInput = input('text', c.series, 'card-series-' + c.id)
      if (seriesNames.length) {
        seriesInput.setAttribute('list', 'gacha-series-list')
        seriesInput.setAttribute('placeholder', seriesNames[0])
      }

      body.appendChild(
        el('tr', { class: c.hidden ? 'row-hidden' : '' }, [
          el('td', {}, [thumb]),
          el('td', {}, [input('text', c.name, 'card-name-' + c.id)]),
          el('td', {}, [sel]),
          el('td', {}, [seriesInput]),
          el('td', {}, [input('number', c.seriesOrder || 0, 'card-order-' + c.id)]),
          el('td', { class: 'cell-img', text: c.image || '(未填)' }),
          // 动态卡面（HR）：填视频文件名（放在「动态卡面（HR）目录」里）。
          // 留空 = 这张没有动态卡面，大图里只显示静态图。
          el('td', {}, [input('text', c.dynamic, 'card-dynamic-' + c.id)]),
          el('td', {}, [
            c.hidden ? el('span', { class: 'chip chip-warn', text: '已隐藏' }) : el('span', { class: 'chip', text: '显示中' }),
            c.rarityKnown ? null : el('div', { class: 'cell-warn', text: '稀有度不认识' }),
          ]),
          el('td', { class: 'cell-actions' }, [
            el('button', { class: 'btn ghost small', type: 'button', 'data-card-save': c.id }, ['保存']),
            el('button', { class: 'btn ghost small', type: 'button', 'data-card-hide': c.id }, [c.hidden ? '显示' : '隐藏']),
            el('button', { class: 'btn ghost small', type: 'button', 'data-card-pick': c.id }, ['选图']),
            el('button', { class: 'btn ghost small danger', type: 'button', 'data-card-del': c.id }, ['删除']),
          ]),
        ])
      )
    })
    table.appendChild(body)
    return table
  }

  // -------------------------------------------------------------------------
  // ⑦ 后台交互
  // -------------------------------------------------------------------------

  function wireAdmin(view) {
    function q(bind) {
      return view.querySelector('[data-bind="' + bind + '"]')
    }
    function out(bind, text, isErr) {
      var node = q(bind)
      if (!node) return
      node.textContent = text
      node.className = 'panel-out' + (isErr ? ' panel-out-err' : '')
    }

    function afterWrite(res, okMsg) {
      if (res && res.data && state.data) {
        // 服务端回传了完整快照 —— 直接换掉，避免本地推算与服务端不一致
        state.data = normalizeSnapshot(res.data)
      }
      render()
      toast(okMsg, 'ok')
    }

    function fail(err) {
      toast(err.message, 'error')
      return null
    }

    var scanAdd = q('scan-add')
    if (scanAdd) {
      scanAdd.addEventListener('click', function () {
        out('scan-out', '正在扫描…')
        request('/scan.json', { method: 'POST', body: { replace: false } })
          .then(function (res) {
            out('scan-out', '扫描到 ' + res.scanned + ' 张图，新增 ' + res.added + ' 张，已登记跳过 ' + res.skipped + ' 张。\n' + (res.hint || ''), false)
            afterWrite(res, '已补入 ' + res.added + ' 张新卡')
          })
          .catch(function (err) {
            out('scan-out', '扫描失败：' + err.message, true)
            fail(err)
          })
      })
    }

    var scanReplace = q('scan-replace')
    if (scanReplace) {
      scanReplace.addEventListener('click', function () {
        if (!window.confirm('重建会把整个卡牌名册替换成目录扫描结果 —— 你改过的角色名与稀有度都会丢失。继续？')) return
        out('scan-out', '正在重建…')
        request('/scan.json', { method: 'POST', body: { replace: true } })
          .then(function (res) {
            out('scan-out', '重建完成：' + res.added + ' 张。\n' + (res.hint || ''), false)
            afterWrite(res, '名册已重建')
          })
          .catch(function (err) {
            out('scan-out', '重建失败：' + err.message, true)
            fail(err)
          })
      })
    }

    var scanImages = q('scan-images')
    if (scanImages) {
      scanImages.addEventListener('click', function () {
        out('scan-out', '正在读取图片清单…')
        request('/images.json')
          .then(function (res) {
            var lines = ['受控目录：'].concat((res.dirs || []).map(function (d) { return '  ' + d }))
            lines.push('共 ' + (res.images || []).length + ' 张图：')
            ;(res.images || []).slice(0, 40).forEach(function (i) { lines.push('  ' + i.rel) })
            if ((res.images || []).length > 40) lines.push('  …（只列前 40 个）')
            if (res.hint) lines.push(res.hint)
            out('scan-out', lines.join('\n'), false)
          })
          .catch(function (err) {
            out('scan-out', '读取失败：' + err.message, true)
          })
      })
    }

    // 关注安叶喵：新增一行 / 保存整份
    var linkAdd = q('link-add')
    if (linkAdd) {
      linkAdd.addEventListener('click', function () {
        var rows = q('link-rows')
        if (!rows) return
        // 就地插一行，**不重新渲染**（见 linkAdminRow 的说明）
        rows.appendChild(linkAdminRow({ icon: '🔗' }))
      })
    }

    var saveLinks = q('save-links')
    if (saveLinks) {
      saveLinks.addEventListener('click', function () {
        var rows = q('link-rows')
        var list = []
        var fields = rows ? rows.querySelectorAll('[data-link-row]') : []
        for (var i = 0; i < fields.length; i++) {
          var row = fields[i]
          var val = function (bind) {
            var node = row.querySelector('[data-bind="' + bind + '"]')
            return node ? String(node.value == null ? '' : node.value) : ''
          }
          var title = val('link-title').trim()
          var url = val('link-url').trim()
          var image = val('link-image').trim()
          // 名称、链接、配图全空的条目直接丢掉：那多半是点了「新增一条」又没填。
          // 存进去会在页面上变成一张「（未命名链接）」的空卡。
          if (!title && !url && !image) continue
          list.push({
            id: row.getAttribute('data-link-id') || '',
            title: title,
            url: url,
            icon: val('link-icon').trim(),
            badge: val('link-badge').trim(),
            desc: val('link-desc'),
            image: image,
            hidden: val('link-hidden') === 'true',
          })
        }
        request('/links.json', { method: 'POST', body: { links: list } })
          .then(function (res) { afterWrite(res, '链接已保存（' + list.length + ' 条）') })
          .catch(fail)
      })
    }

    var saveComp = q('save-comp')
    if (saveComp) {
      saveComp.addEventListener('click', function () {
        var readNum = function (bind, fallback) {
          var node = q(bind)
          var v = node ? String(node.value).trim() : ''
          if (v === '') return fallback
          var n = Number(v)
          return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null
        }
        var n = readNum('comp-tickets', 10)
        var full = readNum('comp-full-tickets', 20)
        if (n === null) {
          window.alert('返还的抽卡券要写成 0 或正整数，现在是：' + (q('comp-tickets') ? q('comp-tickets').value : ''))
          return
        }
        if (full === null) {
          window.alert('「已集齐时返还」要写成 0 或正整数，现在是：' + (q('comp-full-tickets') ? q('comp-full-tickets').value : ''))
          return
        }
        var sel = q('comp-on')
        request('/settings.json', {
          method: 'POST',
          body: {
            shatterComp: {
              enabled: sel ? sel.value !== 'false' : true,
              tickets: n,
              fullTickets: full,
            },
          },
        })
          .then(function (res) { afterWrite(res, '红碎补偿已保存') })
          .catch(fail)
      })
    }

    /**
     * ③-7 那一组：签到 / HR / 重复闪卡返还。
     *
     * 与 ③-6 同一套做法：**先全部校验、再一次性提交** ——
     * 写一半的配置（比如 A 改对了、B 写错了）会让签到算出来的点数悄悄不对，
     * 而页面上只显示一个数字。
     */
    var saveDaily = q('save-daily')
    if (saveDaily) {
      saveDaily.addEventListener('click', function () {
        var readNum = function (bind, label) {
          var node = q(bind)
          var raw = node ? String(node.value).trim() : ''
          var n = raw === '' ? 0 : Number(raw)
          if (!Number.isFinite(n) || n < 0) {
            window.alert(label + ' 要写成 0 或正整数，现在是：' + raw)
            return null
          }
          return Math.floor(n)
        }
        var vals = {}
        var specs = [
          ['daily-points', '每天基础点数'],
          ['daily-rerolls', '重抽次数'],
          ['daily-hour', '刷新小时'],
          ['daily-a-UR', 'A · UR'],
          ['daily-a-sp', 'A · SP'],
          ['daily-b-none', 'B · 平卡'],
          ['daily-b-flat', 'B · ' + foilLabel('flat')],
          ['daily-b-full', 'B · ' + foilLabel('full')],
          ['daily-b-shatter', 'B · ' + foilLabel('shatter')],
          ['hr-shards', '兑换动态卡面要几个 HR 碎片'],
          ['shatter-cost-ur', '换 UR 的红碎要几个 HR 碎片'],
          ['shatter-cost-sp', '换 SP 的红碎要几个 HR 碎片'],
          ['dup-flat-points', '重复面闪额外返几点'],
          ['dup-full-hr', '重复全闪额外返几个 HR 碎片'],
        ]
        for (var i = 0; i < specs.length; i++) {
          var v = readNum(specs[i][0], specs[i][1])
          if (v === null) return
          vals[specs[i][0]] = v
        }
        if (vals['daily-hour'] > 23) {
          window.alert('刷新小时要写在 0~23 之间（现在是 ' + vals['daily-hour'] + '）')
          return
        }
        if (vals['daily-rerolls'] > 20) {
          window.alert('重抽次数最多 20（现在是 ' + vals['daily-rerolls'] + '）')
          return
        }
        if (vals['hr-shards'] < 1) {
          window.alert('兑换动态卡面的碎片数至少要 1（现在是 ' + vals['hr-shards'] + '）')
          return
        }
        if (vals['shatter-cost-ur'] < 1 || vals['shatter-cost-sp'] < 1) {
          window.alert('红碎兑换的碎片数至少要 1（现在是 UR ' + vals['shatter-cost-ur'] + ' / SP ' + vals['shatter-cost-sp'] + '）')
          return
        }
        var dailyOn = q('daily-on')
        var hrOn = q('hr-on')
        // 档位清单**原样带回去**：它决定「谁能被开出来」，而这里没有对应的输入框。
        // 不回传的话会被归一化退回默认的 UR/SP —— 看起来没事，但作者手改过的
        // 清单会在下一次保存时被悄悄覆盖掉。
        // ⚠️ 这个数组在 `viewAdmin` 的作用域里（渲染时算的），保存这里是另一个函数，
        // 拿不到它 —— 必须就地重算（第一版直接用了 `A_IDS`，一点保存就 ReferenceError）
        var curDaily = (state.data && state.data.settings && state.data.settings.daily) || {}
        var aIds = Array.isArray(curDaily.rarities) && curDaily.rarities.length ? curDaily.rarities.slice() : ['UR', '???']
        request('/settings.json', {
          method: 'POST',
          body: {
            daily: {
              enabled: dailyOn ? dailyOn.value !== 'false' : true,
              points: vals['daily-points'],
              rerolls: vals['daily-rerolls'],
              refreshHour: vals['daily-hour'],
              // 档位清单不在这里改（它决定「谁能被开出来」，改错了会静默改掉规则）
              rarities: aIds,
              rarityFactor: { UR: vals['daily-a-UR'], '???': vals['daily-a-sp'] },
              foilFactor: {
                '': vals['daily-b-none'],
                flat: vals['daily-b-flat'],
                full: vals['daily-b-full'],
                shatter: vals['daily-b-shatter'],
              },
            },
            hr: {
              enabled: hrOn ? hrOn.value !== 'false' : true,
              shards: vals['hr-shards'],
              // 红碎兑换价（按档位）。只送这两个档 —— 别的档位本来就不开放兑换
              shatterCost: { UR: vals['shatter-cost-ur'], '???': vals['shatter-cost-sp'] },
            },
            dupReward: { enabled: true, flatPoints: vals['dup-flat-points'], fullHrShards: vals['dup-full-hr'] },
          },
        })
          .then(function (res) { afterWrite(res, '签到 / HR / 重复返还已保存') })
          .catch(fail)
      })
    }
    var saveSettings = q('save-settings')
    if (saveSettings) {
      saveSettings.addEventListener('click', function () {
        var ratioRaw = q('set-ratio') ? String(q('set-ratio').value).trim() : ''
        // 比例格式在保存前先验一次 —— 存进去一个 "2:3"（冒号）的话页面会静默用默认值，
        // 那属于「改了没生效」这类最难查的问题
        if (ratioRaw && !/^\d+(\.\d+)?\s*\/\s*\d+(\.\d+)?$/.test(ratioRaw)) {
          window.alert('卡面比例要写成 "2/3" 或 "832/1216" 这种（斜杠），现在是：' + ratioRaw)
          return
        }
        var mirrorRaw = q('set-mirror') ? String(q('set-mirror').value).trim() : ''
        var mirrorFallbackRaw = q('set-mirror-fallback') ? String(q('set-mirror-fallback').value).trim() : ''
        // 镜像基址同样先验一次：写错一个字符，读者那边的图就全变成坏地址
        //（页面会退回站内相对路径，所以不会白屏，但镜像等于白配了）
        if (mirrorRaw && !/^https?:\/\//i.test(mirrorRaw)) {
          window.alert('图片镜像基址要以 http:// 或 https:// 开头，现在是：' + mirrorRaw)
          return
        }
        if (mirrorFallbackRaw && !/^https?:\/\//i.test(mirrorFallbackRaw)) {
          window.alert('回退基址要以 http:// 或 https:// 开头，现在是：' + mirrorFallbackRaw)
          return
        }
        var body = {
          title: q('set-title').value,
          subtitle: q('set-subtitle').value,
          coverImage: q('set-cover').value.trim(),
          cardRatio: ratioRaw || '2/3',
          footerNote: q('set-foot').value,
          imageMirror: mirrorRaw,
          imageFallback: mirrorFallbackRaw,
          imageDirs: q('set-dirs')
            .value.split('\n')
            .map(function (x) { return x.trim() })
            .filter(Boolean),
        }
        request('/settings.json', { method: 'POST', body: body })
          .then(function (res) { afterWrite(res, '设置已保存') })
          .catch(fail)
      })
    }

    var savePull = q('save-pull')
    if (savePull) {
      savePull.addEventListener('click', function () {
        var ten = q('pull-ten').value.trim()
        var dupSel = q('pull-dup')
        var allowDup = dupSel ? dupSel.value !== 'false' : true
        if (!allowDup) {
          // 关掉重复会让碎片系统失去来源 —— 这必须提醒，不能让人自己踩
          if (!window.confirm('关掉「允许重复获得」后，抽卡永远不会出重复卡，碎片也就永远攒不到、碎片兑换会变成死功能。确定要关吗？')) return
        }
        var body = {
          pull: {
            costSingle: Number(q('pull-single').value || 0),
            costTen: ten === '' ? null : Number(ten),
            tenPullGuarantee: q('pull-guarantee').value,
            pityMax: Number(q('pull-pity').value || 0),
            allowDuplicates: allowDup,
          },
        }
        request('/settings.json', { method: 'POST', body: body })
          .then(function (res) { afterWrite(res, '抽卡参数已保存') })
          .catch(fail)
      })
    }

    var saveShards = q('save-shards')
    if (saveShards) {
      saveShards.addEventListener('click', function () {
        function intOf(bind, fallback) {
          var node = q(bind)
          var n = Number(node ? String(node.value).trim() : '')
          return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback
        }
        // 碎片 -> 抽卡券：`shards` 必须 >= 1（0 会变成除零）；`tickets` 允许 0
        //（= 这一档不开放兑换，这是**有意义**的配置，不能当成填错而回落）。
        var tickets = {}
        rarityList().forEach(function (r) {
          var sNode = q('ticket-shards-' + r.id)
          var gNode = q('ticket-gain-' + r.id)
          var sv = sNode ? String(sNode.value).trim() : ''
          var gv = gNode ? String(gNode.value).trim() : ''
          var sh = sv === '' ? 1 : Number(sv)
          var tk = gv === '' ? 0 : Number(gv)
          if (!Number.isFinite(sh) || sh < 1 || !Number.isFinite(tk) || tk < 0) {
            window.alert('碎片换券的比例要写成「几个碎片（≥1）换几张券（≥0）」，现在是：' + (r.label || r.id) + ' = ' + sv + ' : ' + gv)
            return
          }
          tickets[r.id] = { shards: Math.floor(sh), tickets: Math.floor(tk) }
        })
        request('/settings.json', {
          method: 'POST',
          body: {
            shards: {
              perDuplicate: intOf('shard-per', 1),
              costForCard: intOf('shard-card', 5),
              costForUpgrade: intOf('shard-up', 5),
              tickets: tickets,
            },
          },
        })
          .then(function (res) { afterWrite(res, '碎片规则已保存') })
          .catch(fail)
      })
    }

    // ---- 概率自检：跑模拟，把「实测 vs 标称」摆出来 -------------------------
    var runAudit = q('run-audit')
    if (runAudit) {
      runAudit.addEventListener('click', function () {
        var g = G()
        // ⚠️ 用后台自己的 q()（在 view 里查），不要用 state.els：后台那些面板是
        // 渲染时才建出来的，boot 时的 cacheEls() 根本看不到它们。
        var out = q('audit-out')
        if (!g || !out) {
          window.alert('draw.js 没有加载成功，跑不了自检')
          return
        }
        var draws = Math.floor(Number(q('audit-draws') ? q('audit-draws').value : 200000))
        if (!Number.isFinite(draws) || draws < 1000 || draws > 2000000) {
          window.alert('模拟抽数请填 1000 ~ 2000000 之间（现在填的是 ' + draws + '）')
          return
        }
        clear(out)
        out.appendChild(el('div', { class: 'audit-head', text: '正在跑 ' + fmt(draws) + ' 抽……' }))
        // 让浏览器先把「正在跑」画出来，再做这批同步计算
        //（几万到几十万次纯函数调用大约几十到几百毫秒）
        window.setTimeout(function () {
          try {
            clear(out)
            var d = state.data
            var lines = []
            lines.push(el('div', { class: 'audit-head', text: '概率自检：' + fmt(draws) + ' 抽 / 每个池子（含追梦模式）' }))
            var pools = d.pools || []
            var allOk = true
            for (var pi = 0; pi < pools.length; pi++) {
              var pool = pools[pi]
              var modes = [{ dream: false, label: '普通' }]
              if (g.dreamAvailable(pool)) modes.push({ dream: true, label: (pool.dream && pool.dream.label) || '追梦池' })
              for (var mi = 0; mi < modes.length; mi++) {
                var mode = modes[mi]
                var sim = g.simulate(d, { poolId: pool.id, draws: draws, count: 10, dream: mode.dream, seed: 20260918, freezeSteps: false })
                if (!sim.ok) {
                  allOk = false
                  lines.push(el('div', { class: 'audit-row audit-bad', text: pool.name + ' / ' + mode.label + '：' + sim.error }))
                  continue
                }
                // 标称：普通池是常量；追梦池要用**解析长期平均**（概率逐次变化）
                var expected = {}
                if (mode.dream) {
                  var lr = g.dreamLongRunRates(d, pool)
                  if (lr) for (var rid1 in lr.rates) expected[rid1] = lr.rates[rid1]
                } else {
                  var rt = g.rateTable(d, pool.id)
                  for (var ri = 0; ri < rt.length; ri++) expected[rt[ri].rarity.id] = rt[ri].rate * 100
                }
                var rows = g.compareRates(sim.rarityRate, expected, sim.draws)
                var block = el('div', { class: 'audit-block' }, [
                  el('div', {
                    class: 'audit-title',
                    text: pool.name + ' · ' + mode.label + '（' + fmt(sim.draws) + ' 抽' +
                      (mode.dream ? '，含动态概率；平均 ' + (Number.isFinite(sim.drawsPerSp) ? Math.round(sim.drawsPerSp) : '∞') + ' 抽一张 ' + ((rarityById(lr && lr.spId) || {}).label || 'SP') : '') + '）',
                  }),
                  el('div', { class: 'audit-grid' }, [
                    el('div', { class: 'audit-cell audit-h', text: '档位' }),
                    el('div', { class: 'audit-cell audit-h', text: '标称' }),
                    el('div', { class: 'audit-cell audit-h', text: '实测' }),
                    el('div', { class: 'audit-cell audit-h', text: '偏差' }),
                    el('div', { class: 'audit-cell audit-h', text: '容差' }),
                  ]),
                ])
                rows.forEach(function (row) {
                  if (!row.ok) allOk = false
                  var label = (rarityById(row.id) || {}).label || row.id
                  block.appendChild(
                    el('div', { class: 'audit-grid' + (row.ok ? '' : ' audit-bad') }, [
                      el('div', { class: 'audit-cell', text: label }),
                      el('div', { class: 'audit-cell', text: row.expected.toFixed(2) + '%' }),
                      el('div', { class: 'audit-cell', text: row.measured.toFixed(2) + '%' }),
                      el('div', { class: 'audit-cell', text: (row.diff >= 0 ? '+' : '') + row.diff.toFixed(2) }),
                      el('div', { class: 'audit-cell', text: '±' + row.tolerance.toFixed(2) }),
                    ])
                  )
                })
                // 工艺概率也一起自检（追梦池是 40/10/1）
                var foilExpected = {}
                var foilTable = mode.dream ? g.dreamFoilRates(d, pool) : ((d.settings.foils && d.settings.foils.rates) || {})
                for (var fi2 = 0; fi2 < g.FOIL_IDS.length; fi2++) {
                  var fid2 = g.FOIL_IDS[fi2]
                  foilExpected[fid2] = Number(foilTable[fid2] || 0)
                }
                var foilRows = g.compareRates(sim.finishRate, foilExpected, sim.draws)
                block.appendChild(el('div', { class: 'audit-sub', text: '特殊工艺（只统计各档门槛允许的情况）' }))
                foilRows.forEach(function (row) {
                  var label = ({ flat: '平闪', full: '全闪', shatter: '红碎' })[row.id] || row.id
                  // 红碎/全闪有稀有度门槛，实测必然低于配置值 —— 那一档不判失败，
                  // 只把数字摆出来让人看到「门槛确实在拦」
                  var gated = row.id !== 'flat'
                  if (!row.ok && !gated) allOk = false
                  block.appendChild(
                    el('div', { class: 'audit-grid' + (row.ok ? '' : gated ? ' audit-gated' : ' audit-bad') }, [
                      el('div', { class: 'audit-cell', text: label }),
                      el('div', { class: 'audit-cell', text: row.expected.toFixed(2) + '%' }),
                      el('div', { class: 'audit-cell', text: row.measured.toFixed(2) + '%' }),
                      el('div', { class: 'audit-cell', text: (row.diff >= 0 ? '+' : '') + row.diff.toFixed(2) }),
                      el('div', { class: 'audit-cell', text: gated ? '有门槛' : '±' + row.tolerance.toFixed(2) }),
                    ])
                  )
                })
                lines.push(block)
              }
            }
            lines.push(
              el('div', {
                class: 'audit-verdict ' + (allOk ? 'audit-ok' : 'audit-fail'),
                text: allOk
                  ? '结论：实测出率全部落在容差内 —— 与标称一致。'
                  : '结论：有档位超出容差（上面标红的行）。要么配置有问题，要么抽数太少（把模拟抽数调大再跑一次）。',
              })
            )
            lines.forEach(function (n) { out.appendChild(n) })
          } catch (err) {
            clear(out)
            out.appendChild(el('div', { class: 'audit-verdict audit-fail', text: '自检出错：' + err.message }))
          }
        }, 30)
      })
    }

    var saveReveal = q('save-reveal')
    if (saveReveal) {
      saveReveal.addEventListener('click', function () {
        var rar = rarityList()
        // 颜色先验一次。写错一个（`red`、漏了 `#`、六个十六进制里混进一个 g）
        // 会让那一档的纯色卡变成透明或黑块 —— 页面上不会有任何报错，
        // 属于「改了没生效」里最难查的一类。
        var colors = {}
        for (var i = 0; i < rar.length; i++) {
          var cNode = q('reveal-color-' + rar[i].id)
          var cv = cNode ? String(cNode.value).trim() : ''
          if (cv && !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(cv)) {
            window.alert('颜色要写成 #rrggbb 或 #rgb（现在是「' + cv + '」，档位 ' + (rar[i].label || rar[i].id) + '）')
            return
          }
          if (cv) colors[rar[i].id] = cv
        }
        function numOr(bind, fallback) {
          var node = q(bind)
          var raw = node ? String(node.value).trim() : ''
          if (raw === '') return fallback
          var n = Number(raw)
          return Number.isFinite(n) ? n : fallback
        }
        // 目录那一栏是「一行一个」，空行与首尾空格都清掉 —— 留着空串会让
        // 受控目录里多出一个 `''`，解析图片时表现成「莫名其妙找不到图」。
        var emojiDirsNext = q('emoji-dirs')
          ? q('emoji-dirs')
              .value.split('\n')
              .map(function (x) { return x.trim() })
              .filter(Boolean)
          : []
        var poolUiDirsNext = q('pool-ui-dirs')
          ? q('pool-ui-dirs')
              .value.split('\n')
              .map(function (x) { return x.trim() })
              .filter(Boolean)
          : []
        var linkDirsNext = q('link-dirs')
          ? q('link-dirs')
              .value.split('\n')
              .map(function (x) { return x.trim() })
              .filter(Boolean)
          : []
        var dynamicDirsNext = q('dynamic-dirs')
          ? q('dynamic-dirs')
              .value.split('\n')
              .map(function (x) { return x.trim() })
              .filter(Boolean)
          : []
        var emoji = {}
        var emojiRaritiesNext = []
        for (var j = 0; j < rar.length; j++) {
          var fNode = q('emoji-file-' + rar[j].id)
          var file = fNode ? String(fNode.value).trim() : ''
          if (file) emoji[rar[j].id] = file
          var box = q('reveal-emoji-' + rar[j].id)
          if (box && box.checked) emojiRaritiesNext.push(rar[j].id)
        }
        var enabledSel = q('reveal-enabled')
        request('/settings.json', {
          method: 'POST',
          body: {
            emojiDirs: emojiDirsNext,
            poolUiDirs: poolUiDirsNext,
            linkDirs: linkDirsNext,
            dynamicDirs: dynamicDirsNext,
            emoji: emoji,
            reveal: {
              enabled: enabledSel ? enabledSel.value !== 'false' : true,
              colors: colors,
              backdropBase: numOr('reveal-backdrop-base', 0.42),
              backdropStep: numOr('reveal-backdrop-step', 0.13),
              dragScale: numOr('reveal-drag-scale', 0.1),
              dragScaleTop: numOr('reveal-drag-scale-top', 0.18),
              emojiRarities: emojiRaritiesNext,
            },
          },
        })
          .then(function (res) { afterWrite(res, '表情包与动画已保存') })
          .catch(fail)
      })
    }

    var saveFoils = q('save-foils')
    if (saveFoils) {
      saveFoils.addEventListener('click', function () {
        var kinds = foilKinds()
        var rates = {}
        var mins = {}
        for (var i = 0; i < kinds.length; i++) {
          var id = kinds[i].id
          var node = q('foil-rate-' + id)
          var raw = node ? String(node.value).trim() : ''
          if (raw === '') {
            rates[id] = 0
            continue
          }
          var n = Number(raw)
          // 概率写错必须先拦下来：写成 150 不会报任何错，只会让「排在它后面的那一档
          // 永远抽不到」，而界面上还显示着作者写进去的数字 —— 属于「改了没生效」
          // 里最难查的一类。
          if (!Number.isFinite(n) || n < 0 || n > 100) {
            window.alert('概率要写成 0~100 之间的数（现在是「' + raw + '」，工艺：' + (kinds[i].label || id) + '）')
            return
          }
          rates[id] = n
          var sel = q('foil-min-' + id)
          mins[id] = sel ? String(sel.value || '') : ''
        }
        var en = q('foil-enabled')
        request('/settings.json', {
          method: 'POST',
          body: { foils: { enabled: en ? en.value !== 'false' : true, rates: rates, minRarity: mins } },
        })
          .then(function (res) { afterWrite(res, '特殊工艺已保存') })
          .catch(fail)
      })
    }

    state.data.pools.forEach(function (p) {
      var btn = q('save-pool-' + p.id)
      if (btn) {
        btn.addEventListener('click', function () {
          var weights = {}
          rarityList().forEach(function (r) {
            var inp = view.querySelector('[data-bind="w-' + p.id + '-' + r.id + '"]')
            if (!inp) return
            var v = inp.value.trim()
            if (v === '') return
            weights[r.id] = Number(v)
          })
          var seriesEl = q('pool-series-' + p.id)
          var series = seriesEl
            ? seriesEl.value
                .split(/[\n,，]+/)
                .map(function (s) { return s.trim() })
                .filter(function (s, i, arr) { return s && arr.indexOf(s) === i })
            : []
          // 排除规则：`系列` 或 `系列:档位1,档位2`。
          // ⚠️ 解析失败要**拦住并说清哪一行**，不能猜着往下走 ——
          // 猜错的后果是「某些卡悄悄从池子里消失」，而页面上看不出任何异常。
          var excludeEl = q('pool-exclude-' + p.id)
          var exclude = []
          if (excludeEl) {
            var knownRar = {}
            rarityList().forEach(function (r) {
              knownRar[r.id] = 1
              if (r.label) knownRar[r.label] = 1
            })
            var lines = excludeEl.value.split('\n')
            for (var li = 0; li < lines.length; li++) {
              var line = lines[li].trim()
              if (!line) continue
              var parts = line.split(/[:：]/)
              var sName = parts[0].trim()
              if (!sName) {
                window.alert('第 ' + (li + 1) + ' 行没写系列名：' + line)
                return
              }
              var rar = []
              if (parts.length > 1) {
                var names = parts[1].split(/[,，]/).map(function (x) { return x.trim() }).filter(Boolean)
                for (var ri = 0; ri < names.length; ri++) {
                  if (!knownRar[names[ri]]) {
                    window.alert('第 ' + (li + 1) + ' 行的档位「' + names[ri] + '」不在档位表里（可用的：' + rarityList().map(function (r) { return r.label || r.id }).join(' / ') + '）')
                    return
                  }
                  rar.push(names[ri])
                }
              }
              exclude.push({ series: sName, rarities: rar })
            }
          }
          var coverEl = q('pool-cover-' + p.id)
          // 追梦池：把这些字段一起保存。空白的数值**跳过**（保留原值），
          // 而不是写成 0 —— 一个手滑清空输入框就会把整档概率变成 0。
          var dreamW = {}
          var dreamR = {}
          rarityList().forEach(function (r) {
            var wi = view.querySelector('[data-bind="dream-w-' + p.id + '-' + r.id + '"]')
            if (wi && wi.value.trim() !== '') dreamW[r.id] = Number(wi.value.trim())
          })
          foilKinds().forEach(function (k) {
            var fi = view.querySelector('[data-bind="dream-foil-' + p.id + '-' + k.id + '"]')
            if (fi && fi.value.trim() !== '') dreamR[k.id] = Number(fi.value.trim())
          })
          function numField(bind, fallback) {
            var node = q(bind)
            if (!node) return fallback
            var raw = String(node.value).trim()
            if (raw === '') return fallback
            var n = Number(raw)
            return Number.isFinite(n) ? n : fallback
          }
          var dreamBody = {
            enabled: (q('dream-on-' + p.id) ? q('dream-on-' + p.id).value !== 'false' : true),
            weights: dreamW,
            foilRates: dreamR,
            cost: {
              single: numField('dream-cost1-' + p.id, 1),
              ten: numField('dream-cost10-' + p.id, 10),
            },
            spStep: numField('dream-step-' + p.id, 0.1),
            spFrom: q('dream-from-' + p.id) ? q('dream-from-' + p.id).value : 'SR',
            spMaxSteps: numField('dream-max-' + p.id, 75),
          }
          request('/pool/' + encodeURIComponent(p.id), {
            method: 'PUT',
            body: {
              name: q('pool-name-' + p.id).value,
              desc: q('pool-desc-' + p.id).value,
              weights: weights,
              series: series,
              exclude: exclude,
              coverCardId: coverEl ? coverEl.value : '',
              dream: dreamBody,
            },
          })
            .then(function (res) { afterWrite(res, '卡池已保存') })
            .catch(fail)
        })
      }
      var del = q('del-pool-' + p.id)
      if (del) {
        del.addEventListener('click', function () {
          if (!window.confirm('删除卡池「' + p.name + '」？（卡牌本身不会被删）')) return
          request('/pool/' + encodeURIComponent(p.id), { method: 'DELETE' })
            .then(function (res) { afterWrite(res, '卡池已删除') })
            .catch(fail)
        })
      }
    })

    var addPool = q('add-pool')
    if (addPool) {
      addPool.addEventListener('click', function () {
        var weights = {}
        rarityList().forEach(function (r) { weights[r.id] = 0 })
        request('/pool', { method: 'POST', body: { name: '新卡池', desc: '', weights: weights } })
          .then(function (res) { afterWrite(res, '已新建卡池') })
          .catch(fail)
      })
    }

    // 卡牌表：逐行操作
    view.querySelectorAll('[data-card-save]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-card-save')
        var nameInput = view.querySelector('[data-bind="card-name-' + id + '"]')
        var rarityInput = view.querySelector('[data-card-rarity="' + id + '"]')
        var seriesInput = view.querySelector('[data-bind="card-series-' + id + '"]')
        var orderInput = view.querySelector('[data-bind="card-order-' + id + '"]')
        var dynInput = view.querySelector('[data-bind="card-dynamic-' + id + '"]')
        var name = nameInput ? nameInput.value : ''
        var orderRaw = orderInput ? String(orderInput.value).trim() : ''
        request('/card/' + encodeURIComponent(id), {
          method: 'PUT',
          body: {
            name: name,
            rarity: rarityInput ? rarityInput.value : '',
            // 系列留空 = 不属于任何系列（normalize 会存成空串）
            series: seriesInput ? seriesInput.value : '',
            seriesOrder: orderRaw === '' ? 0 : Number(orderRaw),
            // 动态卡面（HR）：视频文件名；留空 = 取消这张的动态卡面
            dynamic: dynInput ? String(dynInput.value).trim() : '',
          },
        })
          .then(function (res) { afterWrite(res, '已保存 ' + name) })
          .catch(fail)
      })
    })
    view.querySelectorAll('[data-card-hide]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-card-hide')
        var c = cardById(id)
        request('/card/' + encodeURIComponent(id), { method: 'PUT', body: { hidden: !(c && c.hidden) } })
          .then(function (res) { afterWrite(res, c && c.hidden ? '已显示' : '已隐藏') })
          .catch(fail)
      })
    })
    view.querySelectorAll('[data-card-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-card-del')
        var c = cardById(id)
        if (!window.confirm('从名册里删除「' + (c ? c.name : id) + '」？图片文件不会被删。')) return
        request('/card/' + encodeURIComponent(id), { method: 'DELETE' })
          .then(function (res) { afterWrite(res, '已删除') })
          .catch(fail)
      })
    })
    view.querySelectorAll('[data-card-pick]').forEach(function (b) {
      b.addEventListener('click', function () { openPick(b.getAttribute('data-card-pick')) })
    })

    var rotate = q('rotate-key')
    if (rotate) {
      rotate.addEventListener('click', function () {
        if (!window.confirm('换新秘钥？旧秘钥与所有已解锁的浏览器会立即失效。')) return
        request('/auth.json', { method: 'POST', body: { action: 'rotate' } })
          .then(function (res) {
            out('key-out', '新秘钥（只显示这一次，请立刻保存）：\n\n  ' + res.key, false)
            state.unlocked = false
            render()
            toast('已换新秘钥，当前浏览器已锁定', 'ok')
          })
          .catch(function (err) { out('key-out', '换秘钥失败：' + err.message, true) })
      })
    }
    var lock = q('lock')
    if (lock) {
      lock.addEventListener('click', function () {
        request('/auth.json', { method: 'POST', body: { action: 'lock' } })
          .then(function () {
            state.unlocked = false
            render()
            toast('已锁定', 'ok')
          })
          .catch(fail)
      })
    }
  }

  /** 服务端回传的快照缺少派生字段时补齐，保证渲染代码只管读 */
  function normalizeSnapshot(data) {
    if (!data) return state.data
    if (!data.cards) data.cards = []
    // 静态站：把 `assets/img/...` 的图片换成镜像地址（没配镜像时这一句什么都不做）。
    // 放在这里是因为**所有**渲染路径都从这里拿数据 —— 卡面、横幅、封面、表情包、
    // 关注页配图一起换掉，不必逐处改。
    // ⚠️ 基址要从 data 自己算（见 mirrorBasesOf 的说明：此刻 state.data 还没赋值）。
    var bases = mirrorBasesOf(data)
    if (bases.length) mirrorAssetUrls(data, bases[0])
    return data
  }

  // -------------------------------------------------------------------------
  // ⑧ 选图对话框
  // -------------------------------------------------------------------------

  var pickTarget = null

  function openPick(cardId) {
    var dlg = state.els.pickDialog
    var grid = state.els.pickGrid
    var hint = state.els.pickHint
    var errBox = state.els.pickError
    pickTarget = cardId
    if (!dlg || !grid) return
    clear(grid)
    if (errBox) errBox.hidden = true
    if (hint) hint.textContent = '读取中…'
    showModal(dlg)

    request('/images.json')
      .then(function (res) {
        var images = res.images || []
        if (hint) {
          hint.textContent = images.length
            ? '共 ' + images.length + ' 张。点一张就把它填到这张卡上。'
            : res.hint || '受控目录里没有图片。'
        }
        renderPickGrid(images, '')
        var search = state.els.pickSearch
        if (search) {
          search.value = ''
          search.oninput = function () { renderPickGrid(images, search.value) }
        }
      })
      .catch(function (err) {
        if (hint) hint.textContent = '读取图片清单失败。'
        if (errBox) {
          errBox.hidden = false
          errBox.textContent = err.message
        }
      })
  }

  function renderPickGrid(images, query) {
    var grid = state.els.pickGrid
    clear(grid)
    var q = String(query || '').trim().toLowerCase()
    var shown = 0
    images.forEach(function (img) {
      if (q && img.rel.toLowerCase().indexOf(q) === -1) return
      shown++
      var cell = el('button', { class: 'pick-cell', type: 'button', title: img.rel })
      var src = (CFG.api || '') + '/image?src=' + encodeURIComponent(img.rel)
      cell.appendChild(el('img', { referrerpolicy: 'no-referrer', src: src, alt: img.name, loading: 'lazy' }))
      cell.appendChild(el('span', { class: 'pick-name', text: img.rel }))
      cell.addEventListener('click', function () {
        if (!pickTarget) return
        var id = pickTarget
        request('/card/' + encodeURIComponent(id), { method: 'PUT', body: { image: img.rel } })
          .then(function (res) {
            hide(state.els.pickDialog)
            afterPickWrite(res, '已把卡面设为 ' + img.rel)
          })
          .catch(function (err) {
            if (state.els.pickError) {
              state.els.pickError.hidden = false
              state.els.pickError.textContent = err.message
            }
          })
      })
      grid.appendChild(cell)
    })
    if (!shown) grid.appendChild(el('div', { class: 'panel-hint', text: '没有匹配的图片。' }))
  }

  function afterPickWrite(res, msg) {
    if (res && res.data && state.data) state.data = normalizeSnapshot(res.data)
    render()
    toast(msg, 'ok')
  }

  // -------------------------------------------------------------------------
  // ⑦b 大图 / 合成弹层
  // -------------------------------------------------------------------------

  /**
   * 点开图鉴里的一张卡：看大图，并在下面给出**合成**按钮。
   *
   * 为什么合成按钮放在这里而不是碎片页：兑卡已从「同档随机」改成「指定」，
   * 而「哪一张」只能在图鉴里选。把按钮放到大图下面，人已经在看那张卡了，
   * 顺手就能决定 —— 不用先回碎片页再想起要换哪张。
   */
  function openCardDialog(cardId) {
    var dlg = state.els.cardDialog
    var card = cardById(cardId)
    if (!dlg) return
    if (!card) {
      toast('找不到这张卡：' + cardId, 'error')
      return
    }
    state.cardOpen = card.id
    wireInspect(state.els.cardDialogCard)
    paintCardDialog(card)
    showModal(dlg)
  }

  function closeCardDialog() {
    state.cardOpen = ''
    hide(state.els.cardDialog)
    repaintAfterFoilPick()
  }

  /**
   * 在大图里换了工艺之后，图鉴格子上那张卡还是旧的样子 ——
   * 关掉弹层时必须重画一次，否则「我明明切成普通版了，关掉还是闪的」。
   *
   * 只在真的换过的时候重画（点开看一眼就关掉不该触发整页 render）。
   */
  function repaintAfterFoilPick() {
    if (!state.foilViewDirty) return
    state.foilViewDirty = false
    render()
  }

  /**
   * 大图里这张卡按哪种工艺显示：把光效层插进（或移出）检视容器。
   *
   * 每次重画都**先清空再插**，而不是切换类名：层数随工艺不同
   *（红碎多一层粒子），增量改类名很容易留下上一次的残留层。
   */
  function paintCardFoil(card, finish) {
    var boxNode = state.els.cardDialogCard
    if (!boxNode) return
    var old = boxNode.querySelectorAll('.foil-shine, .foil-shards, .foil-glare, .foil-sparks')
    for (var i = 0; i < old.length; i++) old[i].remove()
    boxNode.className =
      'card-dialog-card card-inspect' +
      (finish ? ' card-foil card-foil-' + finish : '')
    if (finish) boxNode.setAttribute('data-finish', finish)
    else boxNode.removeAttribute('data-finish')
    // 浮雕边框按稀有度取色（和网格里的卡同一套变量名）
    var r = rarityById(card.rarity)
    if (r && r.color) boxNode.style.setProperty('--rarity-color', r.color)
    // 卡名在弹层标题上（不在卡面里），所以「银灰 / 金色 / 红字描边」这条要用
    // 弹层自己的 data-finish 选中 —— 只写在检视容器上就选不到标题。
    var dlg = state.els.cardDialog
    if (dlg) {
      if (finish) dlg.setAttribute('data-finish', finish)
      else dlg.removeAttribute('data-finish')
    }
    if (!finish) return
    boxNode.appendChild(el('span', { class: 'foil-shine', 'aria-hidden': 'true' }))
    if (finish === 'shatter') boxNode.appendChild(el('span', { class: 'foil-shards', 'aria-hidden': 'true' }))
    boxNode.appendChild(el('span', { class: 'foil-glare', 'aria-hidden': 'true' }))
    if (finish === 'shatter') boxNode.appendChild(el('span', { class: 'foil-sparks', 'aria-hidden': 'true' }))
  }

  /**
   * 工艺切换胶囊：普通 + 自己拥有的每一种。
   *
   * 一种都没拥有时不显示任何东西（也提示一句「抽到闪卡就能在这里切换」，
   * 否则读者不知道这个功能存在）。检视提示跟着一起给。
   */
  function paintFoilSwitch(card, owned, shown) {
    var box = state.els.cardDialogFoils
    var tip = state.els.cardDialogInspect
    if (box) clear(box)
    if (tip) {
      tip.hidden = false
      // 拖动时那团光已经压成「透明的灯」（用户 2026-09-18：光源几乎看不见，
      // 不挡卡面），所以这里说的是「碎块随光显影」而不是「光会跟着动」——
      // 提示要与实际看到的东西一致，否则读者会以为功能坏了。
      tip.textContent = '拖动卡面可以换个角度看' + (shown ? '（光会跟着走，但不会挡住卡面）' : '')
    }
    if (!box) return
    if (!owned.length) {
      box.appendChild(
        el('div', { class: 'card-dialog-foil-hint', text: '这张卡还没有特殊工艺版本 —— 抽卡时有概率抽到平闪 / 全闪 / 红碎。' })
      )
      return
    }
    var picks = [{ id: '', label: '普通' }].concat(
      foilKinds()
        .filter(function (k) {
          return owned.indexOf(k.id) >= 0
        })
        .map(function (k) {
          return { id: k.id, label: k.label || k.id }
        })
    )
    picks.forEach(function (p) {
      var on = p.id ? shown === p.id : !shown
      var b = el('button', {
        class: 'foil-chip' + (on ? ' is-on' : '') + (p.id ? ' foil-chip-' + p.id : ''),
        type: 'button',
        'data-foil-pick': p.id,
        'aria-pressed': on ? 'true' : 'false',
        text: p.label,
      })
      b.addEventListener('click', function () {
        setFoilView(card.id, p.id)
        state.foilViewDirty = true
        paintCardDialog(card)
      })
      box.appendChild(b)
    })
  }

  /**
   * 检视：按住卡面拖动 → 换角度。
   *
   * 角度与光照位置都写成 CSS 变量（CSP 下不能用内联 style，CSSOM 可以）：
   *   --tilt-x/--tilt-y   卡片倾斜（rotateX / rotateY）
   *   --pointer-x/--pointer-y  光照中心（光效层的渐变中心）
   *   --background-x/--background-y  彩虹/闪点层的位移
   *
   * ⚠️ `pointer-x/y` 要和 `tilt` **方向一致**：向右拖时卡片右转，
   * 高光也应该往右走 —— 反过来会像「光从背面照过来」，很怪。
   */
  function wireInspect(node) {
    if (!node || node.__inspectWired) return
    node.__inspectWired = true
    var drag = null
    /**
     * 拖动期间那张卡面的位置与尺寸。
     *
     * ⚠️ **只在按下时读一次**，绝不放进 pointermove 里。
     * 第一版每收到一个 pointermove 就 `getBoundingClientRect()`，而它前面
     * 刚写过 CSS 变量（等于把样式标脏了）—— 于是**每个事件都强制同步重排一次整页**。
     * 鼠标的 pointermove 频率可以到 1000Hz，加上弹层背后是一整页图鉴卡片，
     * 主线程直接饱和：表现就是「按住拖一下，整个网站卡住」。
     * 拖动期间卡片只会倾斜（transform 不改变布局盒），所以这份矩形一直是有效的；
     * 窗口尺寸变了就作废，下一次按下重新读。
     */
    var rect = null
    /** 攒到下一帧再写的目标值（一帧最多写一次） */
    var pending = null
    var frame = 0

    var apply = function (nx, ny) {
      // nx/ny 是 0~1 的归一化位置（相对卡面）
      var cx = (nx - 0.5) * 2
      var cy = (ny - 0.5) * 2
      node.style.setProperty('--tilt-y', (cx * 13).toFixed(2) + 'deg')
      node.style.setProperty('--tilt-x', (-cy * 13).toFixed(2) + 'deg')
      node.style.setProperty('--pointer-x', (nx * 100).toFixed(1) + '%')
      node.style.setProperty('--pointer-y', (ny * 100).toFixed(1) + '%')
      // 背景位移收窄到 37%~63%：和参考实现一样，让光带「动但不过头」
      node.style.setProperty('--background-x', (50 + cx * 13).toFixed(1) + '%')
      node.style.setProperty('--background-y', (50 + cy * 17).toFixed(1) + '%')
    }

    var flush = function () {
      frame = 0
      if (!pending) return
      var p = pending
      pending = null
      apply(p.nx, p.ny)
    }

    /**
     * 把指针位置换算成 0~1。
     *
     * rect 拿不到（没排版 / 尺寸为 0）时返回 null —— 页面里所有依赖坐标的
     * 功能都要能「什么都没发生」，不能拿 0 去除。
     */
    var norm = function (ev) {
      if (!rect) rect = node.getBoundingClientRect()
      if (!rect.width || !rect.height) return null
      return {
        nx: Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)),
        ny: Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height)),
      }
    }

    var move = function (ev) {
      if (!drag) return
      var p = norm(ev)
      if (!p) return
      // 一帧只写一次：指针事件比屏幕刷新快得多（高刷新率鼠标能到 1000Hz），
      // 每个事件都写一次 CSS 变量 = 每秒钟上千次样式失效 + 重绘，
      // 而肉眼能看到的只有一帧一个画面。
      pending = p
      if (!frame) frame = requestFrame(flush)
    }

    node.addEventListener('pointerdown', function (ev) {
      drag = { id: ev.pointerId }
      /*
       * ⚠️ 这一句是「拖动会不会变成拖图片」的关键。
       *
       * 不拦的话，按下再拖会触发浏览器的**原生图片拖拽**：出现半透明残影、
       * 光标变成禁止符号，而我们的 pointermove 从此收不到事件 ——
       * 读者看到的是「拖出来一张图」，而不是「转卡片看反光」。
       * 同一个动作也顺带把「拖过卡面时选中了旁边的文字」一起挡掉。
       *
       * 用 preventDefault 而不是只靠 draggable="false"：
       * 属性管得住 <img>，管不住包在外面那层容器上的文本选择；
       * 而 preventDefault 一句话把这两件事都按住了（卡面里没有任何可聚焦的东西，
       * 所以不会影响键盘操作）。
       */
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault()
      // 布局只在这一刻读一次（此时还没写过任何变量）
      rect = node.getBoundingClientRect()
      node.className = node.className.indexOf('is-inspecting') < 0 ? node.className + ' is-inspecting' : node.className
      if (typeof node.setPointerCapture === 'function' && ev.pointerId !== undefined) {
        try {
          node.setPointerCapture(ev.pointerId)
        } catch (e) {}
      }
      move(ev)
    })
    node.addEventListener('pointermove', move, { passive: true })
    /**
     * 兜底：即使上面那一句因为某种原因没生效（老浏览器、合成事件、
     * 触摸长按），也不许浏览器把这张卡当成可拖拽对象。
     */
    node.addEventListener('dragstart', function (ev) {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault()
    })
    var end = function () {
      drag = null
      pending = null
      if (frame) {
        cancelFrame(frame)
        frame = 0
      }
      // 只在真的挂着 is-inspecting 时才改类名：className 赋值会让样式失效，
      // 而 pointerleave 在「鼠标只是路过卡片」时也会响 —— 那属于白白的重绘。
      if (node.className.indexOf(' is-inspecting') >= 0) {
        node.className = node.className.replace(' is-inspecting', '')
      }
    }
    node.addEventListener('pointerup', end)
    node.addEventListener('pointercancel', end)
    node.addEventListener('pointerleave', function () {
      if (!drag) end()
    })
    // 尺寸变了（窗口缩放 / 旋屏）就把缓存作废，下一次按下重新量
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('resize', function () {
        rect = null
      })
    }
  }

  /** 下一帧执行（没有 requestAnimationFrame 时退回 setTimeout，行为一致但更慢） */
  function requestFrame(fn) {
    if (typeof window.requestAnimationFrame === 'function') return window.requestAnimationFrame(fn)
    return window.setTimeout(fn, 16)
  }

  function cancelFrame(id) {
    if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(id)
    else window.clearTimeout(id)
  }

  /**
   * 大图里的卡面：静态图 还是 动态卡面（HR 视频）。
   *
   * 为什么默认只在大图里播：图鉴一页有两百多张卡，每张都挂一个 `<video>` 会让
   * 浏览器同时解码几十路视频 —— 那是必然的卡死。抽卡结果与抽卡动画里用的是静态图
   * （`cardFigure` 只加一个「动」角标提示这张有动态版本）。
   * 2026-09-19 起图鉴多了一个**读者自己开的**动态模式：只给「已解锁 HR」的卡建
   * `<video>`，并且只播视口内的那几路（见 GRID_VIDEO_MAX）。
   *
   * @param {object} card 卡牌（读 imageUrl / dynamicUrl）
   * @param {Element} img  `#card-dialog-img`
   * @param {Element} nofile 占位提示
   */
  function paintDialogMedia(card, img, nofile) {
    var video = state.els.cardDialogVideo
    var hasDynamic = !!(card && card.dynamicUrl)
    /**
     * 静态图与动态卡面是**切换**关系，不是叠加关系。
     *
     * 用户 2026-09-19 的截图：大图里静态图与视频**同时**显示，一上一下摞成一列。
     * 根因有两条，缺一条都不会有那么明显的症状：
     *   ① 这里以前把 `img.hidden` 无条件设成 false（只要有静态图就显示）；
     *   ② `.card-dialog-video { display: block }` 是一条作者样式，而 `hidden`
     *      属性靠的是 UA 样式表里的 `[hidden] { display: none }` —— 作者样式
     *      **永远赢**，于是 `el.hidden = true` 对这两个元素压根不生效。
     *      ② 的补丁在 page.css 的全局 `[hidden]` 规则里（那条对所有元素都生效）。
     *
     * 判据只有一条 `showVideo`，`<img>` 与 `<video>` 的显隐全由它推出来 ——
     * 两处各判一次，迟早会不一致。
     *
     * ⚠️ 2026-09-19 起还多了**解锁**这一关：动态卡面是花 20 个 HR 碎片换来的
     * （用户：「使用 20 张 HR 碎片，即可兑换对应卡牌的 HR 动态卡面」），
     * 所以没解锁的卡在大图里也只显示静态卡面 —— 否则那个兑换就没有任何意义了。
     */
    var unlocked = hasDynamic && hrUnlocked(card.id)
    var videoDead = !!(video && unlocked && video.__hrDead === card.dynamicUrl)
    var showVideo = unlocked && !videoDead

    if (img) {
      if (card.imageUrl) {
        // src **一直留着**：视频的 poster 要它，视频读不到时的回退也要它（瞬时切换）
        img.src = card.imageUrl
        img.alt = (card.name || '卡面') + ' 大图'
        img.hidden = showVideo
      } else {
        // 没有图不是错误，是「还没配」——要和大图读不到区分开
        img.hidden = true
        img.removeAttribute('src')
        img.alt = ''
      }
    }

    if (video) {
      if (!showVideo) {
        // 换卡时先收干净：把上一张的视频停掉，避免它在后台继续解码
        try {
          video.pause()
        } catch (e) {}
        video.hidden = true
        // 只有「这张卡没配动态卡面」才清 src。读不到的那种把 src 留着：
        // 它已经失败过一次，留着不会再产生新请求，还能在 devtools 里看见是哪一段
        if (!hasDynamic) {
          video.__hrUrl = ''
          video.removeAttribute('src')
          try {
            video.load()
          } catch (e) {}
        }
      } else {
        var wantPlay = animEnabled() && !prefersReducedMotion()
        if (video.getAttribute('src') !== card.dynamicUrl) {
          video.setAttribute('src', card.dynamicUrl)
          if (card.imageUrl) video.setAttribute('poster', card.imageUrl) // 还没就绪时先顶一张
          video.__hrUrl = card.dynamicUrl
          if (!video.__hrWired) {
            video.__hrWired = true
            video.addEventListener('error', function () {
              /**
               * 视频读不到**不是**「什么都没发生」：退回静态图，并说清原因。
               *
               * 记在元素上的是**失败的那个 URL**，然后照当前这张卡重画一遍媒体区 ——
               * 不在这里手写 `img.hidden = false`：那样等于把「谁显示」的规则抄成
               * 第二份，而第二份迟早会跟第一份不一致（这次的 bug 就是这么来的）。
               * 重画走的是同一条 `showVideo` 判据，反过来也保证不会再试同一段视频。
               */
              var url = video.getAttribute('src')
              if (!url) return
              video.__hrDead = url
              var hint = state.els.cardDialogHint
              if (hint) hint.textContent = '动态卡面读不到（' + (video.__hrName || url) + '），已退回静态卡面。'
              console.warn('[gacha] 动态卡面加载失败：' + (video.__hrName || url))
              paintDialogMedia(cardById(state.cardOpen) || card, state.els.cardDialogImg, state.els.cardDialogNofile)
            })
          }
        }
        video.__hrName = card.dynamic || card.dynamicUrl
        video.hidden = false
        /**
         * 自动播放的三个前提**也在 JS 里设一遍**（不止写在 page.html 上）。
         *
         * 属性是页面上声明的最稳（元素解析出来就带着），而属性（property）在
         * 动态创建/替换 src 的场景里更可靠 —— 两处都写，代价是零，少一处就是
         * 「视频静静地停在那儿」，而页面上不会有任何报错。
         */
        video.muted = true
        video.loop = true
        video.playsInline = true
        if (wantPlay) {
          var p = video.play && video.play()
          // 自动播放被浏览器拦下是常态（策略差异），不该报错刷屏：
          // 停下来就是一张海报，读者照样看得到卡面
          if (p && typeof p.catch === 'function') p.catch(function () {})
        } else {
          try {
            video.pause()
          } catch (e) {}
        }
      }
    }

    // 占位提示的判据是「**实际能显示什么**」，不是「配置里写了什么」：
    // 配了视频但读不到、又没有静态图时，大图里真的什么都没有，提示必须出来
    if (nofile) nofile.hidden = !!(card.imageUrl || showVideo)
  }

  /**
   * 大图里的「兑换动态卡面（HR）」按钮与 HR 标识。
   *
   * 用户 2026-09-19：「动态卡牌归属于 HR 的稀有度，同样不可以抽取，但是可以合成，
   * 需要消耗 HR 碎片」＋「使用 20 张 HR 碎片，即可兑换对应卡牌的 HR 动态卡面，
   * 动态卡面与原卡面共享特殊工艺」。
   *
   * 判定全部走 `page/draw.js` 的 `canUnlockHr`（与服务端 `POST api/player/hr`
   * 是同一份规则），这里只负责画与说明「为什么现在不能换」——
   * 碎片不够 / 没配动态卡面 / 已经解锁过，是**三种不同的原因**，不能糊成一句。
   */
  function paintHrButton(card) {
    var hrBtn = state.els.cardDialogHr
    var chips = state.els.cardDialogChips
    if (!hrBtn) return
    var hasArt = !!(card && card.dynamicUrl)
    if (!hasArt) {
      hrBtn.hidden = true
      hrBtn.textContent = ''
      hrBtn.removeAttribute('data-card')
      return
    }
    if (hrUnlocked(card.id)) {
      // 已经解锁：按钮没有存在的意义，改成在标题旁挂一个 HR 标识 ——
      // 那是「这张卡有动态形态」的唯一凭据（图鉴格子上只有一个「动」字）
      hrBtn.hidden = true
      hrBtn.textContent = ''
      hrBtn.removeAttribute('data-card')
      if (chips) chips.appendChild(el('span', { class: 'hr-chip', text: 'HR · 动态卡面' }))
      return
    }
    var g = G()
    var check = g && typeof g.canUnlockHr === 'function' ? g.canUnlockHr(dataWithState(), card.id) : null
    hrBtn.hidden = false
    hrBtn.setAttribute('data-card', card.id)
    if (!check) {
      // 规则模块没加载：按钮**禁用并说明**，不要让它看起来可以点
      hrBtn.disabled = true
      hrBtn.textContent = '规则模块没加载，无法兑换动态卡面'
      return
    }
    hrBtn.disabled = !check.ok
    hrBtn.textContent =
      '兑换动态卡面（' + check.cost + ' 个 HR 碎片' + (check.ok ? '' : '，现有 ' + check.have) + '）'
    if (check.ok) hrBtn.removeAttribute('title')
    else hrBtn.setAttribute('title', check.reason)
  }

  /**
   * 真的去兑换。
   *
   * **先本地算、再同步**：静态站没有后端（本地就是权威），动态站则把结果交给服务端
   * 再判一次并落盘 —— 与抽卡/碎片兑换完全同一套做法。
   * 本地那一步读的是 `hrUnlockAfter` 的返回值（纯函数），所以「扣了碎片没解锁」
   * 这种半个状态在本地也不可能出现。
   */
  function doUnlockHr(cardId) {
    var g = G()
    if (!g || typeof g.hrUnlockAfter !== 'function') {
      toast('规则模块没加载，暂时不能兑换动态卡面', 'error')
      return
    }
    var after = g.hrUnlockAfter(dataWithState(), cardId)
    if (!after.ok) {
      toast(after.reason, 'error')
      return
    }
    var local = localState()
    local.hr = after.hr
    local.shards = after.shards
    saveLocal(local)
    applyStateToSnapshot({ hr: after.hr, shards: after.shards })
    var card = cardById(cardId)
    var done = function () {
      render()
      // 弹层不在 #view 里（它是独立的 <dialog>），所以 render() 不会重画它 ——
      // 不补这一下，读者会看到按钮还在那儿、仿佛没生效
      if (card && state.cardOpen === cardId) paintCardDialog(card)
    }
    if (BACKEND && state.unlocked) {
      request('/player/hr', { method: 'POST', body: { cardId: cardId } })
        .then(function (res) {
          if (res && res.player && state.data) state.data.player = res.player
          done()
          toast('已解锁动态卡面（花掉 ' + after.cost + ' 个 HR 碎片）', 'ok')
        })
        .catch(function (err) {
          // 本地已经解锁了：这里必须说清「本机记了、服务端没记」，
          // 否则读者换个浏览器会发现解锁没了，而原因完全看不到
          done()
          toast('已在本机解锁，但同步到服务端失败：' + ((err && err.message) || err), 'error')
        })
      return
    }
    done()
    toast('已解锁动态卡面（花掉 ' + after.cost + ' 个 HR 碎片）', 'ok')
  }

  /**
   * 大图里的「兑换红碎工艺」按钮（用户 2026-09-22）。
   *
   * 原话：「在拥有相应卡牌的全闪工艺 UR/SP 之后，可以在图鉴中点开大图之后，
   *   点击红碎按钮，消耗 30/50 点 HR 碎片兑换对应的红碎工艺」。
   *
   * 判定全部走 `page/draw.js` 的 `canExchangeShatter`（与服务端 `POST api/player/shatter`
   * 同一份规则）。四种「不能换」要分开说：不是 UR/SP / 还没有全闪 / 已经有红碎了 /
   * 碎片不够 —— 糊成一句「不能兑换」的话，作者会以为是碎片不够。
   */
  function paintShatterButton(card) {
    var btn = state.els.cardDialogShatter
    if (!btn) return
    var g = G()
    var check = g && typeof g.canExchangeShatter === 'function' ? g.canExchangeShatter(dataWithState(), card && card.id) : null

    // ① 连规则模块都没有：直接说清，别让按钮看起来能点
    if (!check) {
      btn.hidden = !(card && card.rarity === 'UR')
      if (!btn.hidden) {
        btn.disabled = true
        btn.textContent = '规则模块没加载，无法兑换红碎'
      }
      return
    }
    /*
     * ② 按钮什么时候**出现**：只有「这个档位开放红碎兑换」的卡才给它位置。
     *    已经拥有红碎的卡不显示（没什么可换的），但**要留一个角标**告诉读者
     *    「这张的红碎是靠这个方式来的」—— 否则他会以为按钮坏了。
     */
    var open = check.cost !== undefined && !check.owned
    if (!open) {
      btn.hidden = true
      btn.textContent = ''
      btn.removeAttribute('data-card')
      btn.removeAttribute('title')
      return
    }
    btn.hidden = false
    btn.setAttribute('data-card', card.id)
    btn.disabled = !check.ok
    btn.textContent = check.ok
      ? '兑换红碎工艺（' + check.cost + ' 个 HR 碎片）'
      : '兑换红碎工艺（' + check.cost + ' 个 HR 碎片，现有 ' + check.have + '）'
    if (check.ok) btn.removeAttribute('title')
    else btn.setAttribute('title', check.reason)
  }

  /**
   * 真的去兑换红碎工艺。
   *
   * 与 `doUnlockHr` 完全同一套做法：**先本地算、再同步**（静态站本地就是权威，
   * 动态站把结果交给服务端再判一次并落盘），本地那一步读的是
   * `shatterExchangeAfter` 的返回值，所以「扣了碎片没加上工艺」不可能出现。
   */
  function doExchangeShatter(cardId) {
    var g = G()
    if (!g || typeof g.shatterExchangeAfter !== 'function') {
      toast('规则模块没加载，暂时不能兑换红碎', 'error')
      return
    }
    var before = dataWithState()
    var after = g.shatterExchangeAfter(before, cardId)
    if (!after.ok) {
      toast(after.reason, 'error')
      return
    }
    var local = localState()
    local.foils = after.foils
    local.shards = after.shards
    saveLocal(local)
    applyStateToSnapshot({ foils: after.foils, shards: after.shards })
    var card = cardById(cardId)
    // 换完之后这张卡就该显示红碎效果了：把它设成当前展示的工艺
    // （否则读者刚花掉 30 个碎片，看到的还是原来那张全闪，像是没生效）
    setFoilView(cardId, 'shatter')
    var done = function () {
      render()
      if (card && state.cardOpen === cardId) paintCardDialog(card)
    }
    var okMsg = '已兑换红碎工艺（花掉 ' + after.cost + ' 个 HR 碎片）'
    if (BACKEND && state.unlocked) {
      request('/player/shatter', { method: 'POST', body: { cardId: cardId } })
        .then(function (res) {
          if (res && res.player && state.data) state.data.player = res.player
          done()
          toast(okMsg, 'ok')
        })
        .catch(function (err) {
          // 本地已经加上了：必须说清「本机记了、服务端没记」
          done()
          toast('已在本机兑换，但同步到服务端失败：' + ((err && err.message) || err), 'error')
        })
      return
    }
    done()
    toast(okMsg, 'ok')
  }

  function paintCardDialog(card) {
    var S = window.GachaShards
    var img = state.els.cardDialogImg
    var nameEl = state.els.cardDialogName
    var chips = state.els.cardDialogChips
    var ownerEl = state.els.cardDialogOwner
    var hintEl = state.els.cardDialogHint
    var btn = state.els.cardDialogSynth

    if (nameEl) nameEl.textContent = card.name || '未命名'
    if (chips) {
      clear(chips)
      chips.appendChild(rarityChip(card.rarity, { big: true }))
      if (card.series) chips.appendChild(el('span', { class: 'series-chip', text: card.series }))
    }

    // ---- 特殊工艺：显示哪一张、能切哪几种 --------------------------------
    //
    // 只有**自己拥有**的工艺才会显示效果（用户要求），所以这里先问 finishFor：
    // 没拥有过任何工艺时它返回 ''，卡片就是一张普通的图。
    var owned = ownedFoils(card.id)
    var shown = finishFor(card.id)
    paintCardFoil(card, shown)
    paintFoilSwitch(card, owned, shown)

    // 大图：用卡面上同一份 URL（服务端 / 导出脚本算好的），前端不拼路径
    var nofile = state.els.cardDialogNofile
    /**
     * 动态卡面（HR）：配了视频就用 `<video>`，否则用静态图。
     *
     * 三条纪律：
     *   ① **只在有 dynamicUrl 时**才创建/显示视频（没配的卡一点都不变）；
     *   ② 视频读不到时**退回静态图并留下痕迹**（与控制台里的报错一起），
     *      绝不让大图变成一块空白 —— 那是这个项目最忌讳的失败形态；
     *   ③ 自动播放在「抽卡动画被关掉」或系统「减少动态效果」时**不播**
     *      （读者已经明确表示不想看动的东西，动态卡面也不该自己动起来）。
     */
    paintDialogMedia(card, img, nofile)
    paintHrButton(card)
    // 红碎兑换（拥有全闪的 UR/SP）：判定在 draw.js，这里只画与说明
    paintShatterButton(card)

    var n = Number(collection()[card.id] || 0)
    if (ownerEl) {
      ownerEl.textContent = n > 0 ? '已拥有 ×' + n : '还没有这张卡'
      ownerEl.className = 'card-dialog-owner' + (n > 0 ? '' : ' card-dialog-owner-missing')
    }

    if (!btn) return
    btn.setAttribute('data-card', card.id)
    btn.setAttribute('data-rarity', card.rarity || '')

    if (!S) {
      btn.disabled = true
      btn.textContent = '碎片模块没有加载'
      if (hintEl) hintEl.textContent = 'page/shards.js 没加载成功，无法判断能不能合成。'
      return
    }

    var check = S.canSynthesize(dataWithState(), card.id)
    var r = rarityById(card.rarity)
    var label = r ? r.label || r.id : card.rarity || '?'
    var cost = S.rules(dataWithState()).costForCard

    if (check.ok) {
      btn.disabled = false
      // 已拥有也能合成（用户确认过），但必须写明是「再合成一张」——
      // 用 5 个碎片换一张不会变回碎片的重复卡，是纯亏，不写清楚就是坑人。
      btn.textContent = n > 0
        ? '再合成一张（已有 ×' + n + '）（' + cost + ' 个 ' + label + ' 碎片）'
        : '合成这张卡（' + cost + ' 个 ' + label + ' 碎片）'
      if (hintEl) {
        var have = Number(((player().shards) || {})[card.rarity] || 0)
        hintEl.textContent = '现有 ' + have + ' 个 ' + label + ' 碎片，合成后剩 ' + (have - cost) + ' 个。'
      }
      return
    }

    btn.disabled = true
    btn.textContent = '暂时不能合成'
    if (hintEl) hintEl.textContent = check.error
  }

  // -------------------------------------------------------------------------
  // ⑧ 秘钥对话框
  // -------------------------------------------------------------------------

  function openUnlock() {
    var dlg = state.els.unlockDialog
    if (!dlg) return
    if (state.els.keyError) state.els.keyError.hidden = true
    if (state.els.keyInput) state.els.keyInput.value = ''
    showModal(dlg)
    if (state.els.keyInput) state.els.keyInput.focus()
  }

  function showModal(dlg) {
    if (!dlg) return
    // 原生 <dialog>：不用自己写遮罩。老浏览器没有 showModal 时退回 open 属性
    if (typeof dlg.showModal === 'function') {
      try {
        dlg.showModal()
        return
      } catch (err) {}
    }
    dlg.setAttribute('open', '')
  }

  function hide(dlg) {
    if (!dlg) return
    if (typeof dlg.close === 'function') {
      try {
        dlg.close()
        return
      } catch (err) {}
    }
    dlg.removeAttribute('open')
  }

  /**
   * 提交秘钥。
   *
   * ⚠️ 只发一次请求。早先的写法先发一次「不带 key 的探测请求」再发真的 ——
   * 那会白白消耗服务端的登录失败熔断次数（5 次锁 1 分钟），
   * 等于让正常人输入正确的秘钥也可能被锁。
   */
  function submitKeyOnce() {
    var key = state.els.keyInput ? state.els.keyInput.value : ''
    var errBox = state.els.keyError
    if (!key) {
      if (errBox) {
        errBox.hidden = false
        errBox.textContent = '请输入秘钥。'
      }
      return
    }
    var btn = state.els.keySubmit
    if (btn) btn.disabled = true
    request('/auth.json', { method: 'POST', body: { action: 'unlock', key: key } })
      .then(function () {
        state.unlocked = true
        hide(state.els.unlockDialog)
        // 解锁后重新拉一次快照（服务端会带上 player 与 unlocked）
        return loadData()
      })
      .then(function () {
        render()
        toast('已解锁，可以编辑了', 'ok')
      })
      .catch(function (err) {
        if (errBox) {
          errBox.hidden = false
          errBox.textContent = err.message
        }
      })
      .then(function () {
        if (btn) btn.disabled = false
      })
  }

  // -------------------------------------------------------------------------
  // ⑨ 渲染与启动
  // -------------------------------------------------------------------------

  function renderNav() {
    var nav = state.els.nav
    if (!nav) return
    clear(nav)
    SECTIONS.forEach(function (sec) {
      // 只读时不渲染编辑入口，而不是渲染了点了报错
      if (sec.needsEdit && READONLY) return
      var active = state.route === sec.id
      var a = el('a', { class: 'nav-link' + (active ? ' nav-on' : ''), href: sec.hash, text: sec.label })
      nav.appendChild(a)
    })
  }

  function renderChrome() {
    var e = state.els
    var d = state.data
    if (!d) return

    if (e.brandTitle) e.brandTitle.textContent = d.settings.title || '魔法少女抽卡'
    // 配置坏了就不许覆盖标题 —— 那个标题是唯一的失败痕迹
    if (!state.configBroken) {
      // 板块名用**顶栏那个中文标签**，不是路由 id：标签页上写「· follow」
      // 对读者没有任何意义（历史遗留，顺手一起改了）
      var secLabel = ''
      for (var sx = 0; sx < SECTIONS.length; sx++) if (SECTIONS[sx].id === state.route) secLabel = SECTIONS[sx].label
      document.title = (d.settings.title || '魔法少女抽卡') + (state.route === 'draw' ? '' : ' · ' + (secLabel || state.route))
    }

    if (e.footNote) e.footNote.textContent = d.settings.footerNote || ''
    if (e.footMeta) {
      var stats = d.stats || {}
      var total = stats.total !== undefined ? stats.total : d.cards.length
      /**
       * 图片镜像的**可见痕迹**。
       *
       * 为什么写在页脚：镜像基址存在数据里（`settings.imageMirror`，后台可改），
       * 代码里**没有**硬编码的常量 —— 于是「镜像还在不在」只能靠数据回答。
       * 作者看代码 diff 时会以为「镜像被删了」，读者也无从判断自己看到的图
       * 是从哪来的。页脚这一句把当前生效的镜像主机写出来，一眼可查。
       * 只在**真的生效**时显示（静态站）：动态站读本机磁盘，根本没有镜像。
       */
      var mirrorHost = ''
      if (!BACKEND) {
        var bases = mirrorBases()
        if (bases.length) {
          try {
            mirrorHost = ' · 图片镜像 ' + new URL(bases[0]).host
          } catch (err) {
            mirrorHost = ''
          }
        }
      }
      e.footMeta.textContent =
        (BACKEND ? '本机 DSH' : '静态站（只读）') +
        ' · 卡牌 ' + total + ' 张' +
        (stats.playable !== undefined && stats.playable !== total ? '（可抽 ' + stats.playable + '）' : '') +
        mirrorHost +
        (state.warning ? ' · ⚠ ' + state.warning : '')
      e.footMeta.title = mirrorHost
        ? '卡面从 ' + mirrorBases()[0] + ' 读取；这里取不到时会逐级回退到回退基址与站内地址'
        : ''
    }

    if (e.warning) {
      e.warning.hidden = !state.warning
      e.warning.textContent = state.warning ? '⚠ ' + state.warning : ''
      e.warning.title = state.warning || ''
    }

    // 货币：只有抽卡真的要花东西时才显示。用户给定的机制里普通抽卡是免费的
    // —— 现在普通池花点数、追梦池花抽卡券，所以两枚徽标都要出现。
    // ⚠️ 追梦池的票价也要一起看：只要有任何一个池子开着追梦模式，券徽标就得在，
    // 否则读者在追梦池里看不到自己还剩几张券。
    if (e.currency) {
      var pullCfg = (d.settings && d.settings.pull) || {}
      var dreamCosts = false
      var pools = d.pools || []
      for (var pi = 0; pi < pools.length; pi++) {
        var pd = pools[pi].dream
        if (!pd || pd.enabled === false) continue
        var pc = pd.cost || {}
        if (Number(pc.single || 0) > 0 || Number(pc.ten || 0) > 0) {
          dreamCosts = true
          break
        }
      }
      var usesCurrency = Number(pullCfg.costSingle || 0) > 0 || Number(pullCfg.costTen || 0) > 0 || dreamCosts
      e.currency.hidden = !usesCurrency
      if (usesCurrency) e.currency.textContent = fmt(tickets()) + ' ' + (player().currencyName || '抽卡券')
    }

    // 点数：普通抽卡的次数。它**总是**显示 —— 普通抽卡每次都花它，
    // 藏起来只会让读者以为抽卡是免费的（用户明确要求放在券/碎片左边）。
    if (e.pointsChip) {
      e.pointsChip.hidden = false
      e.pointsChip.textContent = fmt(points()) + ' 点数'
      // 提示里的数字**从配置读**，不写死：写死的 300 在用户把基础点数改成 400 之后
      // 就变成了一句谎话（而且只在这条 tooltip 里，页面上根本看不见）
      var dailyPts = window.Gacha && typeof window.Gacha.dailyConfig === 'function'
        ? window.Gacha.dailyConfig(state.data).points
        : 400
      e.pointsChip.title = '普通抽卡每次消耗 1 点；每天签到 +' + dailyPts + '（可累积）。追梦池花抽卡券'
    }

    // 碎片总览：抽卡页与碎片页都显示，点得动（跳到碎片兑换）
    if (e.shardChip) {
      var sh = shards()
      var total = 0
      var detail = []
      for (var si = 0; si < rarityList().length; si++) {
        var rid = rarityList()[si].id
        var n = Number(sh[rid] || 0)
        if (n > 0) {
          total += n
          detail.push((rarityList()[si].label || rid) + ' ' + n)
        }
      }
      var showShard = state.route === 'draw' || state.route === 'shards' || state.route === 'collection'
      e.shardChip.hidden = !showShard
      if (showShard) {
        e.shardChip.textContent = '碎片 ' + total
        e.shardChip.title = total ? detail.join(' · ') : '还没有碎片：抽到重复的卡才会产生碎片'
      }
    }

    // 只读站不显示秘钥相关按钮
    if (e.unlockBtn) e.unlockBtn.hidden = READONLY || state.unlocked
    if (e.lockBtn) e.lockBtn.hidden = READONLY || !state.unlocked

    // 首页封面：有就挂上去（背景图走 CSSOM —— CSP 不管它）
    if (e.view && d.settings.coverImageUrl) {
      e.view.style.backgroundImage = 'url("' + d.settings.coverImageUrl + '")'
      e.view.classList.add('has-cover')
    } else if (e.view) {
      e.view.style.backgroundImage = ''
      e.view.classList.remove('has-cover')
    }

    // 卡面比例：数据驱动。写 "832/1216" 或 "832 / 1216" 都能解析。
    // 为什么不用写死 2:3：实际资源里大多数图并不是精确 2:3，按主力图的真实比例
    // 显示才能让卡面完全贴合、不留白边。解析不出来时保留 CSS 默认值，
    // 但要在 Console 里说一声（值写错了不该完全无声）。
    if (e.view && d.settings.cardRatio) {
      var ratioMatch = String(d.settings.cardRatio).match(/^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/)
      if (ratioMatch && Number(ratioMatch[2]) !== 0) {
        e.view.style.setProperty('--card-ratio', ratioMatch[1] + ' / ' + ratioMatch[2])
      } else {
        console.warn('[gacha] settings.cardRatio 格式不对（应形如 "832/1216"）：' + d.settings.cardRatio)
      }
    }
  }

  function render() {
    if (!state.data) return
    // 上一次渲染留下的轮播定时器必须先停：它持有的是已经被换掉的 DOM 节点，
    // 不停就每渲染一次多攒一个定时器，而且会去改已经不在页面上的元素。
    stopBannerTimer()
    // 图鉴里那些 <video> 同理：节点马上要被扔掉，观察器必须先松手，
    // 否则「同时在播几路」的计数只增不减，最后谁都不播（见 resetGridVideos）
    resetGridVideos()
    var route = parseRoute()
    state.route = route.route
    state.routeArg = route.arg

    renderNav()
    renderChrome()

    var view = state.els.view
    clear(view)

    if (route.bad) {
      view.appendChild(
        emptyBox('没有这个板块：' + route.bad, ['已回到抽卡页。可用的板块见顶栏。'])
      )
    }

    // 抽卡状态：从服务端快照或本地存储取
    state.sinceTop = Number(player().sinceTop || 0)

    /*
     * 每次渲染前对一次纪念卡（**不报喜**，见 syncMemorials 的注释）。
     *
     * 这条覆盖的是「**数据**变了、存档没动」的那一半条件：作者给「冥幽」加了几张
     * 新卡，已经拿到纪念卡的人下次打开页面就该看到它被回收 —— 那一刻谁都没做写操作，
     * 只有这条能兜住。静态站尤其重要：那边根本没有服务端帮忙对账。
     */
    syncMemorials()

    // 渲染任何一个板块抛错，都不该变成一页白屏。
    // 白屏最难查 —— 没有任何线索；把错误本身画出来，至少能立刻定位。
    try {
      if (state.route === 'draw') viewDraw()
      else if (state.route === 'collection') viewCollection()
      else if (state.route === 'shards') viewShards()
      else if (state.route === 'checkin') viewCheckin()
      else if (state.route === 'history') viewHistory()
      else if (state.route === 'follow') viewFollow()
      else if (state.route === 'admin') viewAdmin()
    } catch (err) {
      console.error('[gacha] 渲染板块「' + state.route + '」时出错：', err)
      clear(view)
      view.appendChild(
        el('div', { class: 'panel panel-warn' }, [
          el('div', { class: 'panel-title', text: '这个板块渲染失败了' }),
          el('p', { class: 'panel-hint', text: '页面脚本抛了异常，所以这里是空的。下面是原始错误 —— 请把这个信息贴给作者。' }),
          el('div', { class: 'panel-out panel-out-err', text: '板块：' + state.route + '\n' + String((err && err.message) || err) + '\n\n' + String((err && err.stack) || '') }),
          el('div', { class: 'panel-actions' }, [
            el('button', { class: 'btn', type: 'button', 'data-bind': 'render-retry' }, ['重试渲染']),
            el('a', { class: 'btn ghost', href: '#/draw', text: '回到抽卡页' }),
          ]),
        ])
      )
      var retry = view.querySelector('[data-bind="render-retry"]')
      if (retry) retry.addEventListener('click', function () { render() })
    }
  }

  /**
   * 把 data-bind 的连字符名字转成 camelCase。
   *
   * ⚠️ 这里必须转：page.html 用 `data-bind="brand-title"` 标注元素，而代码里读的是
   * `state.els.brandTitle`。如果直接用连字符当键，那些元素**全都接不上** ——
   * renderChrome() 会在第一行 return 掉，表现成「品牌名是空的、页脚是空的、
   * 解锁按钮该隐藏却没隐藏」，而且不报任何错。
   */
  function camel(s) {
    return String(s).replace(/-([a-z0-9])/g, function (_, c) {
      return c.toUpperCase()
    })
  }

  function cacheEls() {
    var e = state.els
    var byBind = document.querySelectorAll('[data-bind]')
    for (var i = 0; i < byBind.length; i++) {
      var b = byBind[i]
      var name = camel(b.getAttribute('data-bind'))
      // 同一个 bind 名可能有多个节点（各板块各一份），保留第一个即可
      if (!e[name]) e[name] = b
    }
    e.announce = document.getElementById('announce')
    e.toast = document.getElementById('toast')
    e.unlockDialog = document.getElementById('unlock-dialog')
    e.pickDialog = document.getElementById('pick-dialog')
    e.cardDialog = document.getElementById('card-dialog')
    e.cacheDialog = document.getElementById('cache-dialog')
    e.resetDialog = document.getElementById('reset-dialog')
    // 公告弹窗：没有 data-bind 的容器（它是整块的），所以按 id 取
    e.noticeDialog = document.getElementById('notice-dialog')

    // 缺失的绑定必须说出来 —— 否则只会表现成「某个角落不更新」，极难定位
    var REQUIRED = ['view', 'nav', 'brandTitle', 'warning', 'currency', 'shardChip', 'unlockBtn', 'lockBtn', 'toast']
    var missing = REQUIRED.filter(function (k) {
      return !e[k]
    })
    if (missing.length) {
      console.error('[gacha] page.html 缺少这些 data-bind 元素：' + missing.join(', '))
    }
  }

  function wire() {
    var e = state.els
    // 图片加载失败的多级回退（镜像 -> 回退 -> 站内相对路径）。
    // 用**捕获**阶段：这样能在卡面自己的 error 处理器之前把地址换掉。
    window.addEventListener('error', onImageError, true)
    if (e.unlockBtn) e.unlockBtn.addEventListener('click', openUnlock)
    if (e.lockBtn) {
      e.lockBtn.addEventListener('click', function () {
        request('/auth.json', { method: 'POST', body: { action: 'lock' } })
          .then(function () {
            state.unlocked = false
            render()
            toast('已锁定', 'ok')
          })
          .catch(function (err) { toast(err.message, 'error') })
      })
    }
    if (e.keyCancel) e.keyCancel.addEventListener('click', function () { hide(e.unlockDialog) })
    if (e.keySubmit) e.keySubmit.addEventListener('click', submitKeyOnce)
    if (e.keyInput) {
      e.keyInput.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault()
          submitKeyOnce()
        }
      })
    }
    if (e.pickCancel) e.pickCancel.addEventListener('click', function () { hide(e.pickDialog) })
    if (e.cardDialogClose) e.cardDialogClose.addEventListener('click', function () { closeCardDialog() })
    if (e.cardDialogSynth) {
      e.cardDialogSynth.addEventListener('click', function () {
        var cardId = e.cardDialogSynth.getAttribute('data-card')
        var rarityId = e.cardDialogSynth.getAttribute('data-rarity')
        if (!cardId || !rarityId) return
        doExchange(rarityId, 'card', cardId)
      })
    }
    // 兑换动态卡面（HR）：花 HR 碎片换这张卡的动态形态（用户 2026-09-19）
    if (e.cardDialogHr) {
      e.cardDialogHr.addEventListener('click', function () {
        var cardId = e.cardDialogHr.getAttribute('data-card')
        if (cardId) doUnlockHr(cardId)
      })
    }
    // 兑换红碎工艺：拥有全闪的 UR/SP 可以花 HR 碎片直接换红碎（用户 2026-09-22）
    if (e.cardDialogShatter) {
      e.cardDialogShatter.addEventListener('click', function () {
        var cardId = e.cardDialogShatter.getAttribute('data-card')
        if (cardId) doExchangeShatter(cardId)
      })
    }
    // 大图弹层被 Esc / 点遮罩关掉时，state.cardOpen 也要跟着清掉，
    // 否则再点同一张卡会被误判成「已经开着」。这条路径不经过 closeCardDialog，
    // 所以换过工艺时的重画也要在这里补一次。
    if (e.cardDialog) e.cardDialog.addEventListener('close', function () {
      state.cardOpen = ''
      repaintAfterFoilPick()
    })
    // 图片缓存：入口在页脚（静态站与动态站都要有，所以不放在后台里）
    if (e.cacheBtn) e.cacheBtn.addEventListener('click', openCacheDialog)
    if (e.cacheClose) e.cacheClose.addEventListener('click', function () { hide(e.cacheDialog) })
    if (e.cacheFill) e.cacheFill.addEventListener('click', doCacheAll)
    if (e.cacheForce) e.cacheForce.addEventListener('click', doCacheForce)
    if (e.cacheClear) e.cacheClear.addEventListener('click', doClearCache)
    // 顶栏一键按钮：按下去立刻开始抓，进度就写在按钮自己身上
    if (e.cacheLoad) e.cacheLoad.addEventListener('click', function () { loadAllImages(false) })
    // 顶栏的「缓存管理」与页脚那个是同一个对话框（两个入口都留在，别删页脚那个）
    if (e.cacheTop) e.cacheTop.addEventListener('click', openCacheDialog)
    // 清空缓存（重置存档）：两级确认，第二级要等 5 秒
    if (e.resetOpen) e.resetOpen.addEventListener('click', function () { openResetDialog() })
    if (e.resetCancel) e.resetCancel.addEventListener('click', function () { closeResetDialog() })
    if (e.resetConfirm) e.resetConfirm.addEventListener('click', function () { doReset() })
    if (e.resetDialog) {
      // Esc / 点遮罩关掉时也要把倒计时清掉，否则它会一直在后台跑
      e.resetDialog.addEventListener('close', function () {
        if (state.resetTimer) {
          window.clearInterval(state.resetTimer)
          state.resetTimer = 0
        }
      })
    }
    if (e.shardChip) {
      e.shardChip.addEventListener('click', function () { go('#/shards') })
    }
    // 公告弹窗：两个按钮。**去重置**只是把第二级确认打开，真正的清空仍要等 5 秒，
    // 所以这里不会因为误点就丢进度。
    if (e.noticeLater) e.noticeLater.addEventListener('click', closeNotice)
    if (e.noticeReset) {
      e.noticeReset.addEventListener('click', function () {
        closeNotice()
        openResetDialog()
      })
    }

    window.addEventListener('hashchange', render)
  }

  function loadData() {
    // 静态站：数据内联在页面里，一个网络请求都不发
    var inline = readInlineData()
    if (inline) {
      state.data = normalizeSnapshot(inline)
      state.unlocked = false
      // ⚠️ 不能无条件覆盖：boot() 可能已经从 localStorage 恢复了读者选的池。
      // 无条件赋值会让「上次选了群友池」在刷新后失效（表现成「选了没用」）。
      if (!state.poolId && state.data.pools && state.data.pools.length) state.poolId = state.data.pools[0].id
      return Promise.resolve()
    }
    return request('/data.json')
      .then(function (res) {
        state.data = normalizeSnapshot(res.data)
        state.unlocked = !!res.unlocked
        state.hasKey = !!res.hasKey
        state.warning = res.warning || ''
        if (!state.poolId && state.data.pools && state.data.pools.length) state.poolId = state.data.pools[0].id
        // 恢复上次抽卡结果（跨刷新）
        if (!state.last) {
          var saved = lsGet(LS.last, null)
          if (saved && saved.ids && saved.ids.length) {
            var results = []
            for (var i = 0; i < saved.ids.length; i++) {
              var c = cardById(saved.ids[i])
              if (c) {
                results.push({
                  card: c,
                  rarityId: c.rarity,
                  isNew: false,
                  // 工艺也要还原，否则刷新之后「刚才那张闪卡」变回普通卡
                  finish: foilId(saved.finishes && saved.finishes[i]),
                })
              }
            }
            if (results.length) state.last = { poolId: saved.poolId, at: saved.at, results: results }
          }
        }
      })
      .catch(function (err) {
        state.warning = '卡池数据加载失败：' + err.message
        state.data = normalizeSnapshot({ settings: { pull: {} }, rarities: [], pools: [], cards: [] })
        var view = state.els.view
        if (view) {
          clear(view)
          view.appendChild(
            emptyBox('卡池数据加载失败', [
              err.message,
              '如果是刚改完服务端代码，需要重启 dsh web（lib/** 只在启动时挂载）。',
            ])
          )
        }
        throw err
      })
  }

  function readInlineData() {
    var node = document.getElementById('gacha-data')
    if (!node) return null
    try {
      return JSON.parse(node.textContent || 'null')
    } catch (err) {
      console.error('[gacha] 内联数据（#gacha-data）不是合法 JSON', err)
      return null
    }
  }

  function boot() {
    cacheEls()
    wire()
    // 读者偏好：图鉴里收起了哪些系列组。读不出来就当作全部展开
    // （宁可多显示也不要让人以为「这个系列的卡不见了」）。
    var savedCollapsed = lsGet(LS.collapsed, null)
    state.collapsed = savedCollapsed && typeof savedCollapsed === 'object' ? savedCollapsed : {}
    // 读者偏好：上次选的卡池。刷新后要还在，否则「我选了群友池」会白选。
    // 数据里已经没有这个池时由 currentPool() 兜回第一个池。
    var savedPool = lsGet(LS.pool, '')
    if (savedPool) state.poolId = String(savedPool)
    // 读者偏好：图鉴里每张卡选中的闪卡工艺。**必须在这里恢复**，
    // 否则刷新一次又变回「显示最好的那一种」，读者会以为切换没生效。
    var savedFoil = lsGet(LS.foilView, null)
    state.foilView = savedFoil && typeof savedFoil === 'object' && !Array.isArray(savedFoil) ? savedFoil : {}
    // 读者偏好：哪些卡池切到了追梦池模式（花的是他的券，所以由他决定并记住）
    var savedDream = lsGet(LS.dream, null)
    state.dreamPools = savedDream && typeof savedDream === 'object' && !Array.isArray(savedDream) ? savedDream : {}
    // 图片缓存：注册 Service Worker。放在数据加载**之前** ——
    // 越早注册，越早开始接管图片请求；失败也不影响页面。
    registerServiceWorker()
    loadData()
      .then(function () {
        /*
         * ⚠️ 每日赠送**不再自动发放**（用户 2026-09-19：「每日登录赠送的点数改为
         * 签到领取」）。这里以前会调 claimDailyGift() 直接发 300 点 —— 留着它
         * 就等于「签到按钮是个摆设，点数照样自动到账」。
         * 现在点数只从签到页领（`viewCheckin` → `doCheckinClaim`），
         * 而「今天领过没有」仍然是同一个标记（player.lastGift）。
         */
        render()
        // 公告弹窗：缺纪念卡时引导去重置（用户要求「每次网站打开最多只弹出一次」）。
        // 放在 render 之后、每日赠送提示之后 —— 弹层会盖住页面，先让首屏画完。
        noticeOnce()
        // 顶栏「加载图片」的文案要看本地已经有多少张，数据到位后才能算
        paintCacheLoadButton()
        var route = parseRoute()
        if (route.bad) window.location.hash = '#/draw'
      })
      .catch(function () {
        // loadData 已经画了错误面板，这里只保证顶栏还是有内容的
        renderNav()
        paintCacheLoadButton()
      })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()

  // 给测试用的出口（test-client.mjs 会在 DOM shim 上调用它）。
  // 把 CFG / READONLY / API 一起暴露出来，测试才能直接断言「页面自己以为的运行模式」，
  // 而不是从渲染结果反推 —— 反推在出问题时恰好是最不可靠的。
  window.__gacha = {
    state: state,
    CFG: CFG,
    API: API,
    BACKEND: BACKEND,
    READONLY: READONLY,
    // 状态访问器也暴露出来：测试要能直接断言「页面读到的状态是哪一份」，
    // 而不是从渲染结果反推（反推在出问题时恰好最不可靠）
    localState: localState,
    player: player,
    collection: collection,
    shards: shards,
    render: render,
    boot: boot,
    runDraw: runDraw,
    parseRoute: parseRoute,
    cardFigure: cardFigure,
    el: el,
    canEdit: canEdit,
    // 公告弹窗：测试要能直接问「现在该不该弹」「弹过了没有」，
    // 而不是从渲染结果反推（反推在出问题时恰好最不可靠）
    memorialStatus: memorialStatus,
    noticeOnce: noticeOnce,
    // 图片镜像：测试要能直接断言「抓图的清单」与「渲染用的地址」是同一份
    allImageUrls: allImageUrls,
    mirrorBases: mirrorBases,
    // 红碎兑换：测试要能直接问「这张卡现在能不能换、为什么不能」，
    // 而不是从按钮文案反推（文案改动不该弄红一条规则断言）
    shatterStatus: function (cardId) {
      var g = G()
      return g && typeof g.canExchangeShatter === 'function' ? g.canExchangeShatter(dataWithState(), cardId) : null
    },
    exchangeShatter: doExchangeShatter,
  }
})()
