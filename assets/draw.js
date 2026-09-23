/**
 * draw.js — 抽卡判定（纯逻辑，无 DOM）
 *
 * 为什么单独一个文件、而且放在前端：
 *   这个站要发布到 GitHub Pages，静态站没有后端，判定只能在浏览器里跑。
 *   服务端**不重复实现一遍**，它只负责把结果记账（POST api/draw/sync）——
 *   同一个规则前后端各写一份，必然出现「本地对、导出错」的错位。
 *
 * 本文件不碰 DOM，所以能在 Node 里加载做测试（scripts/test-draw.mjs 用 vm 跑它）。
 *
 * ---------------------------------------------------------------------------
 * 机制（用户 2026-09-15 给定）
 * ---------------------------------------------------------------------------
 *   · 出率：SR 60% / SSR 35% / UR 4.4% / ??? 0.6%（= 卡池权重，归一化后就是百分比）
 *     权重**允许小数**：这里不做任何「必须整数」的假设。
 *   · **同一稀有度内所有卡牌等概率**（见 drawSingle 末尾那一行）
 *   · 十连保底：settings.pull.tenPullGuarantee（至少一张不低于该档）
 *   · 保底计数：settings.pull.pityMax（自上次出最高档起算）
 *   · 重复卡 -> 碎片，规则在 page/shards.js（settleDraw）
 *
 * 参数（权重、保底、消耗）全部来自数据，改数值不用改代码。
 * 数据没配好时一律**显式报错**，不悄悄用一个默认值糊过去 —— 见 issues()。
 */

;(function (root) {
  'use strict'

  // -------------------------------------------------------------------------
  // 随机数
  // -------------------------------------------------------------------------

  /**
   * 可复现的伪随机数（mulberry32）。
   * 用途：测试必须能复现同一串抽卡结果，否则「保底有没有生效」这种断言
   * 只能靠运气。生产环境用 crypto。
   */
  function mulberry32(seed) {
    var a = seed >>> 0
    return function () {
      a = (a + 0x6d2b79f5) >>> 0
      var t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  /** 无法复现的随机数（生产用）。crypto 拿不到时退回 Math.random。 */
  function cryptoRandom() {
    var c = root.crypto
    if (c && typeof c.getRandomValues === 'function') {
      return function () {
        // 用 32 位整数拼出 [0,1)：直接取 Uint32 / 2^32 足够均匀
        var buf = new Uint32Array(1)
        c.getRandomValues(buf)
        return buf[0] / 4294967296
      }
    }
    return Math.random
  }

  // -------------------------------------------------------------------------
  // 校验
  // -------------------------------------------------------------------------

  /**
   * 把「卡池配置缺了什么」变成一句能照着做的话。
   *
   * ⚠️ 这是本文件最重要的部分。抽卡最容易出的 bug 不是算法写错，而是
   * **数据没配好却静默算出一个看似合理的结果** —— 例如权重全缺时平分、
   * 卡池为空时返回 undefined 让页面白屏。宁可返回明确的问题。
   */
  function issues(data, poolId) {
    var out = []
    var rarities = (data && data.rarities) || []
    var pools = (data && data.pools) || []
    var cards = (data && data.cards) || []

    if (!rarities.length) out.push('稀有度档位表是空的（settings 里应有 rarities）')
    if (!pools.length) out.push('没有任何卡池')
    if (!cards.length) out.push('卡牌名册是空的 —— 到后台「扫描卡池」把图片目录扫进来')

    var ids = {}
    for (var i = 0; i < rarities.length; i++) ids[rarities[i].id] = true

    var pool = null
    for (var j = 0; j < pools.length; j++) {
      if (!poolId || pools[j].id === poolId) {
        pool = pools[j]
        break
      }
    }
    if (!pool) out.push('找不到卡池 ' + poolId)

    if (pool) {
      var w = pool.weights || {}

      // 这一档在当前卡池里到底有没有可抽的卡。
      // 池子自带 byRarity（服务端算好的）时以它为准，否则自己从名册数。
      var countIn = function (rid) {
        if (pool.byRarity && pool.byRarity[rid]) return pool.byRarity[rid].length
        var n = 0
        for (var ci = 0; ci < cards.length; ci++) {
          var c = cards[ci]
          if (!c.hidden && c.rarityKnown && c.rarity === rid) n++
        }
        return n
      }

      var positive = 0
      for (var k in w) {
        if (!Object.prototype.hasOwnProperty.call(w, k)) continue
        if (!ids[k]) continue
        if (Number(w[k]) > 0 && countIn(k) > 0) positive++
      }
      if (!positive) {
        out.push(
          '卡池「' + pool.name + '」的出率权重全是 0 或没配 —— ' +
            '所有档位都抽不出来。到后台把权重填上（本项目是 SR 60 / SSR 35 / UR 4.4 / ??? 0.6）',
        )
      }
      // 缺权重的档位要报出来 —— 但**只报真的有卡的那些**。
      //
      // ⚠️ 这条一开始写成了「所有权重表里没有的档位都报」，结果一个只有 SR 卡、
      // 权重只配了 SR 的卡池会被判成「没配好」而抽不了卡。档位表里那一档压根没有卡时，
      // 没有权重是**完全正常**的（抽不到它是因为没卡，不是因为权重）。
      // 拿抽不到的档位去拦一个可用卡池，属于假失败 —— 比不报更糟。
      var missingWithCards = []
      for (var r = 0; r < rarities.length; r++) {
        var rid = rarities[r].id
        if (w[rid] !== undefined) continue
        var n = countIn(rid)
        if (n > 0) missingWithCards.push(rid + '（' + n + ' 张卡）')
      }
      if (missingWithCards.length) {
        out.push(
          '卡池「' + pool.name + '」这些档位有卡但没配权重，所以抽不出来：' + missingWithCards.join(' / ') +
            '。到后台给它们填权重，或把这些卡的稀有度改掉。',
        )
      }
    }
    return out
  }

  /** 建索引：id -> 卡；稀有度 -> 卡 id 列表（来自池子的 byRarity） */
  function indexes(data, pool) {
    var byId = Object.create(null)
    var cards = (data && data.cards) || []
    for (var i = 0; i < cards.length; i++) byId[cards[i].id] = cards[i]

    var byRarity = Object.create(null)
    for (var k in byId) {
      var c = byId[k]
      if (c.hidden) continue
      if (!c.rarityKnown) continue
      ;(byRarity[c.rarity] || (byRarity[c.rarity] = [])).push(c.id)
    }

    // 池子如果自带了 byRarity（服务端算好的），以它为准 —— 保证前后端一致
    if (pool && pool.byRarity) {
      for (var r in pool.byRarity) byRarity[r] = pool.byRarity[r].slice()
    }
    return { byId: byId, byRarity: byRarity }
  }

  // -------------------------------------------------------------------------
  // SP 保底（用户要求）
  // -------------------------------------------------------------------------
  //
  // 规则原话：「在抽到了已有的 SP 卡牌之后，如果还未拥有当前卡池内的所有 SP 卡牌，
  // 则暂时将已拥有的 SP 卡牌移出当前卡池，直到下一次 SP 卡牌抽取出来才移回来」。
  //
  // 拆成三件独立的事，都在这里实现（服务端 / 静态导出 / 前端共用同一份）：
  //   · `topRarityId`  —— 哪一档算「SP」。用**最高档**（rank 最大），
  //     与 pityMax 的「最高档」是同一个定义，以后加更高的档位也跟着走
  //   · `spExclusions` —— 现在该把哪些卡从这一档里移出去
  //   · `spPityAfter`  —— 抽完之后开关变成什么（纯函数）
  //
  // ⚠️ 「移出」只影响**抽卡**：图鉴、卡池一览、碎片、卡面一律照旧。

  /** 最高档的 id（rank 最大的那一档）。表为空时返回空串。 */
  function topRarityId(data) {
    var list = (data && data.rarities) || []
    var best = ''
    var bestRank = -Infinity
    for (var i = 0; i < list.length; i++) {
      var rk = Number(list[i].rank || 0)
      if (rk >= bestRank) {
        bestRank = rk
        best = list[i].id
      }
    }
    return best
  }

  /** 已拥有的卡 id 集合（`owned` 是 id -> 张数，>=1 才算拥有） */
  function ownedIds(player) {
    var out = Object.create(null)
    var owned = (player && player.owned) || {}
    for (var k in owned) {
      if (owned[k] >= 1) out[k] = 1
    }
    return out
  }

  /** 这个池子的 SP 保底开关现在开着吗（状态存在 `player.spPity[poolId]`） */
  function spPityActive(data, poolId) {
    var m = data && data.player && data.player.spPity
    if (!m || typeof m !== 'object') return false
    return !!m[poolId]
  }

  /** 本池最高档的全部卡 id */
  function topBucket(data, pool) {
    var spId = topRarityId(data)
    if (!spId) return []
    return indexes(data, pool).byRarity[spId] || []
  }

  /**
   * 现在该把哪些卡从这一档里移出去。
   *
   * 三个前置条件缺一不可，且**每一条都必须是硬约束**：
   *   ① 开关开着（没开就什么都不做）
   *   ② 这一档就是最高档（只对 SP 生效，别的档位不动）
   *   ③ 移出去之后这一档**还有卡**。全被移走的话 SP 就再也抽不出来了，
   *      那比抽到重复更糟 —— 集齐之后（或靠碎片合成补齐之后）必须能正常抽。
   *
   * @param {object} [state] 本轮的工作状态 `{ active, owned }`。
   *   **不能只看 data.player.owned**：同一轮十连里刚抽到的那张 SP 也已经是
   *   「已有」了，只看持久化的那份会把它当成可抽的，于是同一轮里又抽出同一张
   *   ——正是用户要避免的事（实测过：这样写审计会报出 120 次「抽到已有的 SP」）。
   *   不传就退回持久化状态（单抽路径就是这种情况）。
   * @returns {Array<string>} 要排除的 id；空数组表示不排除
   */
  function spExclusions(data, pool, bucket, rarityId, state) {
    state = state || {}
    var active = state.active === undefined ? spPityActive(data, pool && pool.id) : !!state.active
    if (!active) return []
    if (rarityId !== topRarityId(data)) return []
    var owned = ownedIds(data && data.player)
    if (state.owned) {
      for (var k in state.owned) {
        if (state.owned[k]) owned[k] = 1
      }
    }
    var out = []
    for (var i = 0; i < bucket.length; i++) {
      if (owned[bucket[i]]) out.push(bucket[i])
    }
    if (out.length >= bucket.length) return []
    return out
  }

  /**
   * 抽完之后 SP 保底的工作状态（**纯函数**，不改任何东西）。
   *
   * 逐张按顺序判定，所以同一轮十连里也会立刻生效：
   *   · 开关开着 + 抽出 SP  -> 关掉（「移回来」）
   *   · 开关关着 + 抽出**已有**的 SP + 还没集齐本池 SP -> 打开
   *
   * 「已有」按**当时的**收集状态判断：同一轮里第二张同样的 SP 也算「已有」。
   * 集齐之后就不再打开 —— 那时候重复是必然的，移出去只会让这一档没有卡可抽。
   *
   * @returns {{active:boolean, changed:boolean, owned:object}}
   *   `owned` 是**含本轮已抽到**的拥有集合，下一抽要把它一起传回 spExclusions。
   */
  function spPityAfter(data, pool, results) {
    var spId = topRarityId(data)
    var all = spId ? topBucket(data, pool) : []
    var owned = ownedIds(data && data.player)
    var active = spPityActive(data, pool && pool.id)
    var changed = false
    for (var i = 0; i < results.length; i++) {
      var one = results[i]
      if (!one || !one.card || one.rarityId !== spId) continue
      var wasOwned = !!owned[one.card.id]
      owned[one.card.id] = 1
      if (active) {
        active = false
        changed = true
        continue
      }
      if (!wasOwned) continue
      var allOwned = true
      for (var k = 0; k < all.length; k++) {
        if (!owned[all[k]]) {
          allOwned = false
          break
        }
      }
      if (!allOwned) {
        active = true
        changed = true
      }
    }
    return { active: active, changed: changed, owned: owned }
  }

  // -------------------------------------------------------------------------
  // UR 保底（用户 2026-09-22）
  // -------------------------------------------------------------------------
  //
  // 原话：「在普通池和追梦池中都添加 UR 保底机制，抽到重复 UR 之后，下一张 UR 必定为
  //   未拥有（已经集齐所有 UR 的话就不生效）」。
  //
  // 与 SP 保底的关系：**同一种形状的第二个开关**，但触发方式不同 ——
  // SP 是作者手动打开的全局开关，UR 是**自动**的、由「抽到重复 UR」触发。
  // 两者共用 `ownedIds` 与同一条硬约束（移出去之后这一档必须还有卡）。
  //
  // 状态存在 `player.urPity[poolId]`，**按池子记**（与 `spPity` 一致）：
  // 判据是「你的收集里还有哪些 UR 没拿到」，这件事与用点数抽还是用券抽无关，
  // 所以同一个池子的普通模式与追梦模式**共用**这份状态 —— 这正是用户那句
  // 「普通池和追梦池中都添加」的意思（两边都生效，而不是各记一份）。

  /** UR 这一档的档位 id。**写死 'UR'**（用户说的就是 UR，不是「最高档」）。*/
  var UR_PITY_RARITY = 'UR'

  /** 这个池子的 UR 保底现在挂着吗（`player.urPity[poolId]`） */
  function urPityActive(data, poolId) {
    var m = data && data.player && data.player.urPity
    if (!m || typeof m !== 'object') return false
    return !!m[poolId]
  }

  /** 本池的 UR 档里全部卡 id */
  function urBucket(data, pool) {
    return indexes(data, pool).byRarity[UR_PITY_RARITY] || []
  }

  /**
   * 现在该把哪些 UR 移出这一档（= 已经拥有的那些）。
   *
   * 三条前置：① 保底挂着 ② 抽的正是 UR 档 ③ 移出之后这一档还有卡。
   * 第 ③ 条是硬约束：全被移走的话 UR 就再也抽不出来了 —— 那比抽到重复更糟。
   * （「已经集齐所有 UR 的话就不生效」在数据上的表现就是这一条。）
   *
   * @param {object} [state] 本轮工作状态 `{ active, owned }`，理由与 `spExclusions` 相同：
   *   同一轮十连里刚抽到的 UR 也已经是「已有」，只看持久化那份会在同一轮里重复。
   */
  function urExclusions(data, pool, bucket, rarityId, state) {
    state = state || {}
    var active = state.active === undefined ? urPityActive(data, pool && pool.id) : !!state.active
    if (!active) return []
    if (String(rarityId) !== UR_PITY_RARITY) return []
    var owned = ownedIds(data && data.player)
    if (state.owned) {
      for (var k in state.owned) {
        if (state.owned[k]) owned[k] = 1
      }
    }
    var out = []
    for (var i = 0; i < bucket.length; i++) {
      if (owned[bucket[i]]) out.push(bucket[i])
    }
    // 一个都没拥有 -> 没什么可移的；全拥有 -> 移完就空了，绝对不能移
    if (!out.length || out.length >= bucket.length) return []
    return out
  }

  /**
   * 抽完之后 UR 保底的状态（**纯函数**，与 `spPityAfter` 同构）。
   *
   * 逐张重放，所以同一轮十连里也立刻生效：
   *   · 保底挂着 + 又抽到 UR      -> 关掉（承诺已经兑现：这一张保证是新的）
   *   · 保底没挂 + 抽到**已有** UR -> 打开（前提：本池还有未拥有的 UR）
   *   · 抽到新的 UR              -> 什么都不做
   *
   * 「已经集齐所有 UR 的话就不生效」= 打开之前先看一眼还有没有未拥有的 UR；
   * 一张都没有（或全被移出去）就不打开 —— 那时候重复是必然的，挂着一个永远
   * 兑现不了的保底只会让界面一直显示「下一张必为未拥有」。
   */
  function urPityAfter(data, pool, results) {
    var all = urBucket(data, pool)
    var owned = ownedIds(data && data.player)
    var active = urPityActive(data, pool && pool.id)
    var changed = false
    for (var i = 0; i < results.length; i++) {
      var one = results[i]
      if (!one || !one.card || String(one.rarityId) !== UR_PITY_RARITY) continue
      var wasOwned = !!owned[one.card.id]
      owned[one.card.id] = 1
      if (active) {
        active = false
        changed = true
        continue
      }
      if (!wasOwned) continue
      // 还有没拿到的 UR 吗？（含「移出去之后这一档还有卡」这条硬约束）
      var fresh = 0
      for (var k = 0; k < all.length; k++) if (!owned[all[k]]) fresh++
      if (fresh > 0) {
        active = true
        changed = true
      }
    }
    return { active: active, changed: changed, owned: owned }
  }

  /**
   * 把某一池的 UR 保底开关并进整张表（**纯函数**）。
   *
   * 表里只保留「真的存在的池子 + 真值」：拼错的池 id / `false` 留着不会报错，
   * 只会让某个池子的保底永远打不开或永远关不掉（与 spPity 同一条纪律）。
   */
  function urPityNextTable(data, pool, active) {
    var out = {}
    var src = (data && data.player && data.player.urPity) || {}
    var known = {}
    var pools = (data && data.pools) || []
    for (var i = 0; i < pools.length; i++) known[pools[i].id] = 1
    for (var k in src) {
      if (!known[k]) continue
      if (src[k]) out[k] = true
    }
    if (pool && pool.id && known[pool.id]) {
      if (active) out[pool.id] = true
      else delete out[pool.id]
    }
    return out
  }

  // -------------------------------------------------------------------------
  // 特殊工艺（闪卡）
  // -------------------------------------------------------------------------
  //
  // 只改**视觉效果**，卡图不动。三档由低到高：平闪 / 全闪 / 红碎，
  // 每档都有概率与最低稀有度门槛（全闪要 SSR+、红碎要 UR+）。
  //
  // 判定是**一掷定档**：先看红碎、再看全闪、最后平闪。某一档因为稀有度门槛
  // 不适用时，它的概率**不会**并到下一档 —— 低档卡就是拿不到高档工艺。

  /**
   * 工艺定义。**与 lib/data.js 的 FOIL_KINDS 必须逐字一致**（id、顺序、label、
   * 最低稀有度）—— 服务端要它做归一化，浏览器要它做判定与显示。
   * 两份拷贝是无奈之举（服务端与浏览器共用的只有这个纯逻辑模块，而 lib/data.js
   * 是 ESM、不能被浏览器直接加载），所以 test-plugin.mjs 里有一条断言把两边钉住。
   */
  var FOIL_KINDS = [
    { id: 'flat', label: '平闪', minRarity: '' },
    { id: 'full', label: '全闪', minRarity: 'SSR' },
    { id: 'shatter', label: '红碎', minRarity: 'UR' },
  ]
  var FOIL_IDS = FOIL_KINDS.map(function (f) {
    return f.id
  })

  /**
   * HR 碎片在 `player.shards` 里的键。
   *
   * **与 lib/data.js 的 `HR_SHARD_RARITY` 必须一致**（那边是 ESM、浏览器加载不了，
   * 所以只能两份；`test-plugin.mjs` 有一条断言把两边钉住）。
   *
   * 为什么 HR 不是「第五个档位」：档位表多一项，概率表、卡池一览、抽卡动画配色
   * 就会各多出一档永远 0 张的幽灵档。HR 是**第四种碎片**，只在碎片表里占一个键。
   */
  var HR_SHARD_RARITY = 'HR'

  /** 档位 id -> rank（不在表里的返回 -1） */
  function rankOf(data, rarityId) {
    var list = (data && data.rarities) || []
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === rarityId) return Number(list[i].rank || 0)
    }
    return -1
  }

  /**
   * 这门工艺能不能出现在这个档位上。
   *
   * 配置里的最低档位 id **必须存在于档位表**里；写了个不存在的 id 时这门工艺
   * 直接出不来（宁可不给，也不要把稀有工艺放给所有卡），并在 `issues()` 里点名。
   */
  function foilAllowed(data, kindId, rarityId) {
    var kind = null
    for (var i = 0; i < FOIL_KINDS.length; i++) {
      if (FOIL_KINDS[i].id === kindId) kind = FOIL_KINDS[i]
    }
    if (!kind) return false
    var cfg = (data && data.settings && data.settings.foils) || {}
    var min = String((cfg.minRarity && cfg.minRarity[kindId]) || kind.minRarity || '')
    if (!min) return true
    var need = rankOf(data, min)
    if (need < 0) return false
    var mine = rankOf(data, rarityId)
    return mine >= 0 && mine >= need
  }

  /**
   * 这一张抽出什么工艺（`''` = 普通）。
   *
   * 概率从 `settings.foils.rates` 读（百分数），门槛从 `settings.foils.minRarity` 读；
   * 关掉 `settings.foils.enabled` 就永远返回普通。
   *
   * ⚠️ 判定顺序是**从高到低**：红碎 -> 全闪 -> 平闪。这样每一档的实测概率
   * 就等于配置里那个数（0.5% / 5% / 20%），而不是「叠加上去」。
   *
   * @param {object} [rates] 覆写概率表（追梦池用另一套：40/10/1）。
   *   不传就读全局配置 —— 这样老的调用方一行都不用改。
   */
  function foilRoll(data, rarityId, rng, rates) {
    var cfg = (data && data.settings && data.settings.foils) || {}
    if (cfg.enabled === false) return ''
    var table = rates && typeof rates === 'object' ? rates : cfg.rates || {}
    var pShatter = foilAllowed(data, 'shatter', rarityId) ? Number(table.shatter || 0) : 0
    var pFull = foilAllowed(data, 'full', rarityId) ? Number(table.full || 0) : 0
    var pFlat = foilAllowed(data, 'flat', rarityId) ? Number(table.flat || 0) : 0
    if (!(pShatter > 0) && !(pFull > 0) && !(pFlat > 0)) return ''
    var r = rng() * 100
    if (pShatter > 0 && r < pShatter) return 'shatter'
    if (pFull > 0 && r < pShatter + pFull) return 'full'
    if (pFlat > 0 && r < pShatter + pFull + pFlat) return 'flat'
    return ''
  }

  /**
   * 抽完之后玩家的「工艺拥有表」变成什么（纯函数，不改入参）。
   *
   * 一张卡可以同时拥有多种工艺（先抽到平闪、后来又抽到全闪）——
   * 图鉴里就是在这些之间切换。数组**按档次从小到大**排，界面取最后一个就是最好的。
   */
  function foilsAfter(current, results) {
    var out = {}
    for (var k in current || {}) {
      if (Object.prototype.hasOwnProperty.call(current, k) && Array.isArray(current[k])) {
        out[k] = current[k].slice()
      }
    }
    for (var i = 0; i < results.length; i++) {
      var one = results[i]
      var fin = one && one.finish ? String(one.finish) : ''
      if (!fin || FOIL_IDS.indexOf(fin) < 0 || !one.card) continue
      var id = one.card.id
      var list = out[id] || (out[id] = [])
      if (list.indexOf(fin) < 0) list.push(fin)
      list.sort(function (a, b) {
        return FOIL_IDS.indexOf(a) - FOIL_IDS.indexOf(b)
      })
    }
    return out
  }

  /**
   * 三种工艺各自的**收集进度**（纯函数）。
   *
   * 用户 2026-09-18：「为卡片收集进度进行更新，新增面闪卡、全闪卡、红碎卡的收集进度」。
   *
   * 口径（这两条都要能解释给读者听，所以写在返回值里，页面直接照抄）：
   *   · **分母 = 能拿到这门工艺的卡数** —— 不隐藏，且这一档达到了门槛
   *     （平闪不限档位、全闪要 SSR+、红碎要 UR+）。拿不到的卡算进去只会让
   *     进度永远到不了 100%，那是在骗人。
   *   · **分子 = 已拥有、且工艺表里记着这一门的卡数** —— 两份数据缺一不可。
   *     只按工艺表数的话，后台清一次进度（owned 清了、foils 留着）就会出现
   *     「拥有 0 张却有 30 张平闪」。这条与图鉴格子的规则同源
   *     （page.js 的 ownedFoils 也要求先拥有）。
   *
   * ⚠️ 分母**不看概率**：普通池的红碎是 0%，但追梦池有 1% —— 拿得到，
   * 就该算进分母。概率只影响「要抽多久」，不影响「算不算收集品」。
   *
   * @returns {Array<{id:string,label:string,owned:number,total:number,pct:number}>}
   */
  function foilCollection(data, player) {
    var cards = (data && data.cards) || []
    var owned = (player && player.owned) || {}
    var foils = (player && player.foils) || {}
    var out = []
    for (var k = 0; k < FOIL_KINDS.length; k++) {
      var kind = FOIL_KINDS[k]
      var total = 0
      var got = 0
      for (var i = 0; i < cards.length; i++) {
        var c = cards[i]
        if (!c || c.hidden) continue
        if (!foilAllowed(data, kind.id, c.rarity)) continue
        total += 1
        if (!(Number(owned[c.id] || 0) > 0)) continue
        var list = foils[c.id]
        if (Array.isArray(list) && list.indexOf(kind.id) >= 0) got += 1
      }
      out.push({
        id: kind.id,
        label: kind.label || kind.id,
        owned: got,
        total: total,
        pct: total ? got / total : 0,
      })
    }
    return out
  }

  // -------------------------------------------------------------------------
  // 红碎补偿（用户 2026-09-19 要求）
  // -------------------------------------------------------------------------
  //
  // 原话：「如果在抽卡过程中抽到了已经有了的红碎，则返还 10 张抽卡券，
  //   并且下次十连必出一张同品质的未拥有红碎。如果是 UR 的红碎，则下次必出
  //   也是 UR；如果是 SP 的红碎，则下次必出也是 SP」。
  //
  // 拆成三件独立的事（都在这里，服务端 / 导出 / 前端共用同一份）：
  //   · `dupShatters`      —— 这一批里哪些是「已经有了的红碎」（逐张按顺序判定）
  //   · `shatterCompAfter` —— 抽完之后：返几张券 + 攒下几次欠条（纯函数）
  //   · `shatterPitySlots` —— 下一次十连要占几个位置、分别是哪一档
  //
  // ⚠️ 三个口径必须说清，否则「为什么这次没补偿」永远查不明白：
  //   ① 「已经有了」= **拥有这张卡 且 工艺表里记着红碎**（两份数据都要）。
  //      只是拥有卡、但没抽到过它的红碎，抽到红碎属于**新的**，不补偿。
  //   ② 同一轮里的第二张相同红碎**也算**（对玩家来说同样是废的），
  //      所以判定要按顺序边走边更新工作副本，不能只看抽之前的快照。
  //   ③ 欠条是**按档位记次数的**：抽到两张重复 UR 红碎就欠两次，
  //      下一次十连里会占两个位置（而不是只补一张）。

  /** 红碎补偿的配置（关掉 / 改券数都从这里读） */
  function shatterComp(data) {
    var c = (data && data.settings && data.settings.shatterComp) || {}
    var t = Number(c.tickets)
    var f = Number(c.fullTickets)
    return {
      enabled: c.enabled === undefined ? true : !!c.enabled,
      tickets: Number.isFinite(t) && t >= 0 ? Math.floor(t) : 10,
      /**
       * 这一档的红碎**已经集齐**时返多少张券。
       *
       * 用户 2026-09-19 追加：「为了防止程序卡死，如果已经拥有同品质的全部红碎，
       * 则只返还 20 张抽卡券，没有下次必出的补偿」。
       * 也就是说：给不了「未拥有的红碎」时，就把这份补偿**折成券**，
       * 而不是挂一张永远兑现不了的欠条。
       */
      fullTickets: Number.isFinite(f) && f >= 0 ? Math.floor(f) : 20,
    }
  }

  /** 这张卡的红碎**已经有了**吗（拥有 + 工艺表，缺一不可 —— 与图鉴的 ownedFoils 同源） */
  function hasShatter(player, cardId) {
    if (!cardId) return false
    var owned = (player && player.owned) || {}
    if (!(Number(owned[cardId] || 0) > 0)) return false
    var list = (player && player.foils) || {}
    var mine = list[cardId]
    return Array.isArray(mine) && mine.indexOf('shatter') >= 0
  }

  /** 未决的欠条：稀有度 id -> 次数（只留正整数） */
  function shatterPity(data, player) {
    var src = player === undefined ? (data && data.player) || {} : player || {}
    var raw = src.shatterPity
    var out = {}
    if (!raw || typeof raw !== 'object') return out
    for (var k in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, k)) continue
      var n = Math.floor(Number(raw[k]))
      if (Number.isFinite(n) && n > 0) out[k] = n
    }
    return out
  }

  /**
   * 这一档里**还没有红碎**的卡 id（只算这个池子抽得到的卡）。
   *
   * 用池子的 `byRarity`（服务端算好的成员表）而不是整册：纪念卡之类的卡
   * 永远不在池子里，拿它们当补偿目标等于给了一张兑现不了的欠条。
   */
  function shatterTargets(data, pool, rarityId, player) {
    var bucket = indexes(data, pool).byRarity[rarityId] || []
    var out = []
    for (var i = 0; i < bucket.length; i++) {
      if (!hasShatter(player, bucket[i])) out.push(bucket[i])
    }
    return out
  }

  /**
   * 把这一批抽卡结果折进玩家状态（拥有表 + 工艺表），返回一份**新**的状态。
   *
   * 为什么要它：判断「这一档还有没有没拿到红碎的卡」必须看**这一批抽完之后**的
   * 状态 —— 这一批里刚好把最后一张的红碎抽出来时，那张欠条就已经兑现不了了，
   * 得当场折成券（否则它会一直挂着，正是用户说的「程序卡死」）。
   */
  function applyBatchToState(player, results) {
    var owned = Object.assign({}, (player && player.owned) || {})
    var foils = {}
    var src = (player && player.foils) || {}
    for (var k in src) {
      if (Object.prototype.hasOwnProperty.call(src, k)) {
        foils[k] = Array.isArray(src[k]) ? src[k].slice() : []
      }
    }
    for (var i = 0; i < (results || []).length; i++) {
      var one = results[i]
      var card = one && one.card
      if (!card || !card.id) continue
      owned[card.id] = Number(owned[card.id] || 0) + 1
      var fin = String((one && one.finish) || '')
      if (!fin) continue
      var list = foils[card.id] || (foils[card.id] = [])
      if (list.indexOf(fin) < 0) list.push(fin)
    }
    return { owned: owned, foils: foils }
  }

  /**
   * 这一批里哪些是「已经有了的红碎」。
   *
   * 逐张按顺序判定，并在工作副本里记下「这张现在也已经有了」——
   * 于是同一轮十连里连出两张相同红碎时，**两张都算**。
   */
  function dupShatters(data, player, results) {
    var out = []
    if (!shatterComp(data).enabled) return out
    var state = { owned: Object.assign({}, (player && player.owned) || {}), foils: {} }
    var srcFoils = (player && player.foils) || {}
    for (var k in srcFoils) {
      if (Object.prototype.hasOwnProperty.call(srcFoils, k)) {
        state.foils[k] = Array.isArray(srcFoils[k]) ? srcFoils[k].slice() : []
      }
    }
    for (var i = 0; i < (results || []).length; i++) {
      var one = results[i]
      var card = one && one.card
      if (!card || String((one && one.finish) || '') !== 'shatter') continue
      var id = card.id
      var had =
        Number(state.owned[id] || 0) > 0 &&
        Array.isArray(state.foils[id]) &&
        state.foils[id].indexOf('shatter') >= 0
      if (had) out.push({ cardId: id, rarityId: card.rarity || (one && one.rarityId) || '', card: card })
      state.owned[id] = Number(state.owned[id] || 0) + 1
      var list = state.foils[id] || (state.foils[id] = [])
      if (list.indexOf('shatter') < 0) list.push('shatter')
    }
    return out
  }

  /**
   * 抽完一批之后，红碎补偿变成什么（**纯函数**）。
   *
   * 三条分支（顺序很重要）：
   *   ① **兑现不了的旧欠条**：这一档的红碎已经集齐 -> 折成 fullTickets 张券，欠条删掉。
   *      这就是用户说的「防止程序卡死」—— 不能挂一张永远兑现不了的欠条。
   *      （触发路径：欠条攒下之后，玩家用**单抽**抽到了这一档最后一张缺的红碎。）
   *   ② **本轮新命中的红碎**：这一档还有没拿到红碎的卡 -> 返 tickets 张券 + 攒一张欠条；
   *      已经集齐 -> **只**返 fullTickets 张券，**不攒欠条**（用户原话：
   *      「如果已经拥有同品质的全部红碎，则只返还 20 张抽卡券，没有下次必出的补偿」）。
   *   ③ 判「还有没有可补的卡」时看的是**这一批抽完之后**的状态（`applyBatchToState`），
   *      所以「这一批刚好凑齐」也能当场折成券，不会拖到下一次。
   *
   * @returns {{tickets:number, hits:Array, armed:Object, pity:Object,
   *            full:Array<string>, converted:Array<string>, idle:Array<string>}}
   *   tickets  ：这一批该返还几张券（两类都算进去了）
   *   armed    ：这一批新攒的欠条（稀有度 -> 次数）
   *   pity     ：加上欠条、去掉折价之后**完整的**未决表（调用方直接持久化它）
   *   full     ：这一批因为「已集齐」而按 fullTickets 结算的档位
   *   converted：其中来自**旧欠条**的那些（界面用来说明「欠条折成券了」）
   *   idle     ：仍欠着但没有可补目标的档位（正常流程下应为空，留作数据被手改时的痕迹）
   */
  function shatterCompAfter(data, pool, player, results) {
    var comp = shatterComp(data)
    var pity = shatterPity(data, player)
    var hits = dupShatters(data, player, results)
    var armed = {}
    var full = []
    var converted = []
    var tickets = 0
    if (!comp.enabled) return { tickets: 0, hits: [], armed: {}, pity: pity, full: [], converted: [], idle: [] }
    // 判「还有没有可补的卡」用的是抽完之后的状态
    var after = applyBatchToState(player, results)
    /**
     * 这一批里**刚刚兑现过**的档位与次数（补偿是替换结果里的某一张，带 `compensation` 标记）。
     *
     * ⚠️ 必须排除它们，否则会出现「补了一张卡 + 又折 20 张券」的双重补偿：
     * 那张补偿卡自己就把这一档最后一张缺的红碎填上了 —— 从「抽完之后」看，
     * 这一档已经集齐、旧欠条似乎兑现不了，于是又被折价一次。
     */
    var fulfilled = {}
    for (var fi = 0; fi < (results || []).length; fi++) {
      var fr = results[fi]
      if (!fr || !fr.compensation) continue
      var frid = fr.rarityId || (fr.card && fr.card.rarity) || ''
      if (frid) fulfilled[frid] = (fulfilled[frid] || 0) + 1
    }

    // ① 旧欠条：兑现不了就折成券；刚刚兑现过的那几张从表里划掉（它们已经还清了）
    for (var k in pity) {
      if (!Object.prototype.hasOwnProperty.call(pity, k)) continue
      if (fulfilled[k]) {
        pity[k] = Number(pity[k]) - fulfilled[k]
        if (!(pity[k] > 0)) delete pity[k]
        continue
      }
      if (shatterTargets(data, pool, k, after).length) continue
      tickets += comp.fullTickets
      full.push(k)
      converted.push(k)
      delete pity[k]
    }

    // ② 这一轮新命中的
    // 同一档位一次结算里可能有好几张：每攒一张就消耗掉一个候选目标，
    // 否则「只有一张可补」时会计出两张兑现不了的欠条。
    var left = {}
    for (var i = 0; i < hits.length; i++) {
      var rid = hits[i].rarityId
      if (!rid) continue
      if (left[rid] === undefined) left[rid] = shatterTargets(data, pool, rid, after).length
      if (left[rid] <= 0) {
        // 已经集齐：只返 fullTickets，且不攒欠条
        tickets += comp.fullTickets
        if (full.indexOf(rid) < 0) full.push(rid)
        continue
      }
      left[rid] -= 1
      tickets += comp.tickets
      armed[rid] = (armed[rid] || 0) + 1
    }
    for (var k2 in armed) pity[k2] = Number(pity[k2] || 0) + armed[k2]

    // ③ 兜底：万一还有欠着却补不了的（数据被手改过），点名出来
    var idle = []
    for (var k3 in pity) {
      if (!Object.prototype.hasOwnProperty.call(pity, k3)) continue
      if (!shatterTargets(data, pool, k3, after).length) idle.push(k3)
    }
    return { tickets: tickets, hits: hits, armed: armed, pity: pity, full: full, converted: converted, idle: idle }
  }

  /**
   * 这一次抽卡要占几个补偿位置（**只有十连才兑现** —— 用户说的是「下次十连」）。
   *
   * 档位从高到低排队：欠着 SP 就先补 SP。
   * @returns {{slots:Array<{rarityId:string,count:number}>, idle:Array<string>}}
   *   idle：欠着但这一档已经没有可补目标的档位（欠条留着，界面要说清）
   */
  function shatterPitySlots(data, pool, player, count) {
    var pity = shatterPity(data, player)
    var out = []
    var idle = []
    var left = Math.max(0, Math.floor(Number(count) || 0))
    var ids = []
    for (var k in pity) if (Object.prototype.hasOwnProperty.call(pity, k)) ids.push(k)
    // 档位从高到低（表已按 rank 升序，倒着走就是高到低）
    var order = ((data && data.rarities) || []).map(function (r) { return r.id })
    ids.sort(function (a, b) { return order.indexOf(b) - order.indexOf(a) })
    for (var i = 0; i < ids.length && left > 0; i++) {
      var rid = ids[i]
      var available = shatterTargets(data, pool, rid, player).length
      if (!available) {
        idle.push(rid)
        continue
      }
      var n = Math.min(pity[rid], left, available)
      if (n > 0) {
        out.push({ rarityId: rid, count: n })
        left -= n
      }
    }
    return { slots: out, idle: idle }
  }

  // -------------------------------------------------------------------------
  // 核心
  // -------------------------------------------------------------------------

  function weightedPick(list, weightOf, rng) {
    var total = 0
    var i
    for (i = 0; i < list.length; i++) total += weightOf(list[i])
    if (!(total > 0)) return null
    var roll = rng() * total
    var acc = 0
    for (i = 0; i < list.length; i++) {
      acc += weightOf(list[i])
      if (roll < acc) return list[i]
    }
    return list[list.length - 1]
  }

  /** 抽一张。返回 { ok:true, card, rarityId } 或 { ok:false, error } */
  function drawSingle(data, poolId, opts) {
    opts = opts || {}
    var rng = opts.rng || cryptoRandom()
    var bad = issues(data, poolId)
    if (bad.length) return { ok: false, error: bad.join('；') }

    var pools = data.pools
    var pool = null
    for (var i = 0; i < pools.length; i++) {
      if (!poolId || pools[i].id === poolId) {
        pool = pools[i]
        break
      }
    }
    var idx = indexes(data, pool)
    var weights = pool.weights || {}
    // 追梦模式：用另一套权重（并按「已经连抽了多少次没出 SP」把 SP 抬上去）
    var dream = !!opts.dream && !!dreamConfig(pool)
    var dreamInfo = dream ? dreamWeights(data, pool, opts.dreamSteps === undefined ? dreamSteps(data, pool.id) : opts.dreamSteps) : null
    if (dreamInfo) weights = dreamInfo.weights
    var foilRates = dream ? dreamFoilRates(data, pool) : null

    // 参与掷档的稀有度：权重 > 0，且池子里真的有这一档的卡。
    // 「权重 > 0 但无卡」必须提前排除，否则会抽到一个空的档位然后返回 undefined。
    var candidates = []
    var emptyWithWeight = []
    for (var r = 0; r < data.rarities.length; r++) {
      var rid = data.rarities[r].id
      var w = Number(weights[rid] || 0)
      if (!(w > 0)) continue
      var bucket = idx.byRarity[rid] || []
      if (!bucket.length) {
        emptyWithWeight.push(rid)
        continue
      }
      candidates.push(rid)
    }

    if (!candidates.length) {
      return {
        ok: false,
        error:
          '卡池「' + pool.name + '」里没有任何可抽的档位。' +
          (emptyWithWeight.length
            ? '这些档位配了权重但一张卡都没有：' + emptyWithWeight.join(' / ') + '。'
            : '') +
          '请到后台给卡牌设置稀有度，或调整权重。',
      }
    }

    // 保底：够了就必出最高档
    var pull = data.settings && data.settings.pull ? data.settings.pull : {}
    var pityMax = Number(pull.pityMax || 0)
    var sinceTop = Number((data.player && data.player.sinceTop) || 0)
    var forced = ''
    if (pityMax > 0 && sinceTop + 1 >= pityMax) {
      // 最高档 = rank 最大的那一档（表已按 rank 升序）
      var top = data.rarities[data.rarities.length - 1].id
      if (candidates.indexOf(top) >= 0) forced = top
    }

    // 十连保底的兜底：drawMany 指定一个最低档位，这里必须真的用它，
    // 否则「保底」传进来却被忽略 —— 那就是一次静默失效。
    var forcedKind = forced ? 'pity' : ''
    if (opts._forceRarity) {
      var want = String(opts._forceRarity)
      if (candidates.indexOf(want) >= 0) {
        forced = want
        forcedKind = 'tenpull'
      } else if (!forced) {
        // 指定的保底档位在这个池子里抽不出来（没卡或权重为 0）：
        // 退到「不高于它的、可抽的最高档」，并标成 fallback，不假装保底成功。
        var wantRank = -1
        for (var t = 0; t < data.rarities.length; t++) {
          if (data.rarities[t].id === want) wantRank = Number(data.rarities[t].rank || 0)
        }
        var bestFallback = ''
        var bestRank = -1
        for (var u = 0; u < candidates.length; u++) {
          for (var v = 0; v < data.rarities.length; v++) {
            if (data.rarities[v].id === candidates[u]) {
              var rk2 = Number(data.rarities[v].rank || 0)
              if (rk2 <= wantRank && rk2 > bestRank) {
                bestRank = rk2
                bestFallback = candidates[u]
              }
            }
          }
        }
        if (bestFallback) {
          forced = bestFallback
          forcedKind = 'tenpull-fallback'
        }
      }
    }

    var rarityId = forced || weightedPick(candidates, function (rid) {
      return Number(weights[rid] || 0)
    }, rng)

    var bucket2 = idx.byRarity[rarityId] || []
    if (!bucket2.length) {
      // 走到这里说明上面的一致性检查漏了 —— 明确报出来，别返回 undefined
      return { ok: false, error: '档位 ' + rarityId + ' 下没有卡（卡池数据不一致）' }
    }

    // SP 保底：把已拥有的 SP 临时移出这一档（只对最高档、只在开关开着时）
    var excluded = spExclusions(data, pool, bucket2, rarityId, opts._sp)
    if (excluded.length) {
      var kept = []
      for (var e = 0; e < bucket2.length; e++) {
        if (excluded.indexOf(bucket2[e]) < 0) kept.push(bucket2[e])
      }
      bucket2 = kept
    }

    /*
     * UR 保底：把已拥有的 UR 临时移出这一档（用户 2026-09-22）。
     * 与 SP 那条互不干扰 —— 判据是档位 id（SP 认最高档、UR 写死 'UR'），
     * 一次抽卡只会命中其中一条。放在 SP 之后只是为了让两条规则的顺序固定下来。
     */
    var excludedUr = urExclusions(data, pool, bucket2, rarityId, opts._ur)
    if (excludedUr.length) {
      var keptUr = []
      for (var e2 = 0; e2 < bucket2.length; e2++) {
        if (excludedUr.indexOf(bucket2[e2]) < 0) keptUr.push(bucket2[e2])
      }
      bucket2 = keptUr
    }

    // 同档位内等概率。若之后要「同档内不同权重」，改这一行即可。
    var pickId = bucket2[Math.floor(rng() * bucket2.length) % bucket2.length]
    var card = idx.byId[pickId]
    if (!card) return { ok: false, error: '卡牌 ' + pickId + ' 在名册里找不到（数据不一致）' }

    // 特殊工艺：每一张都有概率以闪卡的形式被抽出（与卡图无关，只影响显示）
    // 追梦池用上调后的那套概率（40/10/1）
    var finish = foilRoll(data, rarityId, rng, foilRates)

    return { ok: true, card: card, rarityId: rarityId, forced: forcedKind, finish: finish, dream: dream }
  }

  /**
   * 连抽 n 次，并施加十连保底。
   *
   * @param {object} data  快照（rarities / pools / cards / settings / player）
   * @param {object} [opts] { poolId, count, rng }
   * @returns {{ok:true, results:Array} | {ok:false, error:string}}
   */
  function drawMany(data, opts) {
    opts = opts || {}
    var count = Math.max(1, Math.min(100, Number(opts.count) || 1))
    var poolId = opts.poolId
    var rng = opts.rng || cryptoRandom()

    var bad = issues(data, poolId)
    if (bad.length) return { ok: false, error: bad.join('；') }

    var pool = null
    var pools = data.pools
    for (var i = 0; i < pools.length; i++) {
      if (!poolId || pools[i].id === poolId) {
        pool = pools[i]
        break
      }
    }
    var pull = (data.settings && data.settings.pull) || {}
    var guarantee = String(pull.tenPullGuarantee || '')
    var guaranteeRank = -1
    if (guarantee) {
      for (var r = 0; r < data.rarities.length; r++) {
        if (data.rarities[r].id === guarantee) guaranteeRank = Number(data.rarities[r].rank || 0)
      }
    }

    var idx = indexes(data, pool)
    /**
     * 红碎补偿：**只有十连才兑现**（用户说的是「下次十连」）。
     * 单抽不动欠条 —— 否则「下次十连必出」会变成「下次单抽就出掉了」。
     */
    var compPlan = count >= 10 ? shatterPitySlots(data, pool, data.player, count) : { slots: [], idle: [] }

    var results = []
    // 追梦计数在这一轮里**逐抽推进**：每一抽都用「到目前为止的计数」算权重，
    // 抽到 SP 就归零。只在轮末算一次的话，一轮十连里后九抽用的都是旧概率 ——
    // 那和「每次抽卡都会使 SP 概率增加」这句话不符。
    var dreamOn = !!opts.dream && !!dreamConfig(pool)
    var dSteps = dreamOn ? Number(opts.dreamSteps === undefined ? dreamSteps(data, pool.id) : opts.dreamSteps) || 0 : 0
    for (var n = 0; n < count; n++) {
      // SP 保底：每一抽都按「到目前为止的结果」重算一次开关，所以同一轮十连里
      // 抽到重复 SP 之后，后面的几抽就已经看不到那张卡了
      //（用户原话：「暂时移出当前卡池，直到下一次 SP 抽出来才移回来」）。
      // 用 `spPityAfter` 重放前缀而不是自己维护一个可变状态：这套规则只有一份实现。
      var mid = spPityAfter(data, pool, results)
      // UR 保底同理：同一轮十连里抽到重复 UR 之后，后面的 UR 立刻只看未拥有的那些
      var midUr = urPityAfter(data, pool, results)
      var one = drawSingle(data, poolId, {
        rng: rng,
        _sp: { active: mid.active, owned: mid.owned },
        _ur: { active: midUr.active, owned: midUr.owned },
        dream: dreamOn,
        dreamSteps: dSteps,
      })
      if (!one.ok) return one
      results.push(one)
      if (dreamOn) dSteps = dreamStepsAfter(data, pool, dSteps, [one]).steps
    }

    // 十连保底：count >= 10 时，若这一轮里没有任何一张达到保底档，
    // 把**最后一张**替换成保底档的一张（而不是整轮重抽 —— 重抽会让前面
    // 已经看到的动画失效，而且消耗的随机数不一样，结果不可复现）。
    var guaranteedIdx = -1
    if (count >= 10 && guaranteeRank >= 0) {
      var best = -1
      for (var m = 0; m < results.length; m++) {
        var rid = results[m].rarityId
        for (var q = 0; q < data.rarities.length; q++) {
          if (data.rarities[q].id === rid) {
            var rk = Number(data.rarities[q].rank || 0)
            if (rk > best) best = rk
          }
        }
      }
      if (best < guaranteeRank) {
        // 保底替换也要带上本轮的工作状态 —— 否则它等于「忘了这一轮抽过什么」
        var guaranteeSp = spPityAfter(data, pool, results)
        var guaranteeUr = urPityAfter(data, pool, results)
        var forced = drawSingle(data, poolId, {
          rng: rng,
          _forceRarity: guarantee,
          _sp: { active: guaranteeSp.active, owned: guaranteeSp.owned },
          _ur: { active: guaranteeUr.active, owned: guaranteeUr.owned },
          dream: dreamOn,
          dreamSteps: dSteps,
        })
        if (forced.ok) {
          // ⚠️ 只有真的出了保底档才算保底生效。若保底档在这个池子里抽不出来，
          // drawSingle 会退到较低的档并标 forced='tenpull-fallback' ——
          // 那种情况绝不能写 guaranteed=true，否则 UI 会宣称一件没发生的事。
          forced.guaranteed = forced.forced === 'tenpull'
          if (!forced.guaranteed) {
            forced.guaranteeNote =
              '本应在十连里保底 ' + guarantee + '，但这一档在池子里没有可抽的卡（没卡或权重为 0），已退到 ' + forced.rarityId
          }
          results[results.length - 1] = forced
          guaranteedIdx = results.length - 1
        }
      }
    }

    /**
     * 红碎补偿：把欠条兑现成**具体的卡**。
     *
     * 与十连保底同一套做法 —— 替换结果里的某一张，而不是整轮重抽
     *（重抽会让前面已经演过的动画失效，随机数消耗也不一样，结果不可复现）。
     *
     * ⚠️ 位置从后往前挑，**跳过十连保底那一张**：保底是配置里的硬承诺，
     * 被补偿挤掉就等于「保底没生效」，而 UI 还会宣称它生效了。
     * ⚠️ 强制 `finish: 'shatter'`：欠条承诺的是「未拥有的红碎」，
     * 只给卡不给工艺的话，等于什么都没补。
     */
    var compensation = []
    var pityAfter = shatterPity(data, data.player)
    if (compPlan.slots.length) {
      var slotIdx = results.length - 1
      for (var cs = 0; cs < compPlan.slots.length; cs++) {
        var plan = compPlan.slots[cs]
        // 候选每兑现一张就少一张（同一轮里不会补出两张一模一样的欠条）
        var targets = shatterTargets(data, pool, plan.rarityId, data.player)
        for (var ct = 0; ct < plan.count; ct++) {
          while (slotIdx >= 0 && (slotIdx === guaranteedIdx || (results[slotIdx] && results[slotIdx].compensation))) slotIdx--
          if (slotIdx < 0 || !targets.length) break
          var pickAt = Math.floor(rng() * targets.length) % targets.length
          var pickId = targets.splice(pickAt, 1)[0]
          var compCard = idx.byId[pickId]
          if (!compCard) break
          results[slotIdx] = {
            ok: true,
            card: compCard,
            rarityId: compCard.rarity,
            forced: 'shatter-comp',
            guaranteed: false,
            finish: 'shatter',
            dream: dreamOn,
            compensation: true,
          }
          compensation.push({ cardId: compCard.id, rarityId: compCard.rarity, index: slotIdx })
          pityAfter[plan.rarityId] = Math.max(0, Number(pityAfter[plan.rarityId] || 0) - 1)
          if (!pityAfter[plan.rarityId]) delete pityAfter[plan.rarityId]
          slotIdx--
        }
      }
    }

    // SP 保底开关的最终结论。
    // ⚠️ 必须在十连保底**换掉最后一张之后**再算：那张卡到底算不算「抽到过」，
    // 结论会不一样。重放一遍是纯函数，比在循环里小心翼翼地回滚可靠得多。
    var spAfter = spPityAfter(data, pool, results)
    // UR 保底同理：同样在保底替换之后再重放一遍，结论才与最终结果一致
    var urAfter = urPityAfter(data, pool, results)

    // 追梦计数：同样在保底替换之后再重放一遍，结论才和最终结果一致
    var dreamAfter = dreamOn ? dreamStepsAfter(data, pool, opts.dreamSteps === undefined ? dreamSteps(data, pool.id) : opts.dreamSteps, results) : null

    return {
      ok: true,
      results: results,
      poolId: pool.id,
      dream: dreamOn,
      spPity: { active: spAfter.active, changed: spAfter.changed },
      /**
       * UR 保底（用户 2026-09-22）：`table` 是**整张表**，调用方直接持久化
       *（与 spPity 一样，服务端只负责按真实池子校验后原样落盘）。
       */
      urPity: { active: urAfter.active, changed: urAfter.changed, table: urPityNextTable(data, pool, urAfter.active) },
      dreamSteps: dreamAfter ? dreamAfter.steps : null,
      dreamReset: dreamAfter ? dreamAfter.reset : false,
      /** 红碎补偿：这一轮兑现了哪些欠条（空数组 = 没有欠条或没兑现） */
      compensation: compensation,
      /** 兑现之后剩下的欠条（调用方直接持久化） */
      shatterPity: pityAfter,
      /** 欠着、但这一档已经没有可补目标的档位（界面要说清，别让人以为被吞了） */
      shatterPityIdle: compPlan.idle,
    }
  }

  // -------------------------------------------------------------------------
  // 花费与统计
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // 追梦池（用户 2026-09-18 要求）
  // -------------------------------------------------------------------------
  //
  // 「为现有的卡池增加『追梦池』的切换选项」——所以它是**每个池子上的一个开关**，
  // 不是第三个池子：同一个池子在追梦模式下用另一套出率、另一套工艺概率，
  // 而且要花抽卡券（普通模式依旧免费）。
  //
  //   · 出率：SR 30% / SSR 50% / UR 17.5% / SP 2.5%
  //   · 工艺：平闪 40% / 全闪 10% / 红碎 1%
  //   · **动态概率**：每抽一次 SP +0.1%、SR -0.1%，最多累计 75 次；
  //     抽到 SP 就归零。所以「标称概率」在追梦池里是**随次数变化**的，
  //     显示与实际都必须按当前次数算（见 rateTable / dreamLongRunRates）。

  /** 取一个池子的追梦配置；这个池子没有追梦模式时返回 null */
  function dreamConfig(pool) {
    var d = pool && pool.dream
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null
    if (d.enabled === false) return null
    var w = d.weights && typeof d.weights === 'object' ? d.weights : null
    if (!w) return null
    return d
  }

  /** 这个池子能不能切到追梦模式（界面上要不要显示那个开关） */
  function dreamAvailable(pool) {
    return !!dreamConfig(pool)
  }

  /** 追梦计数（`player.dream[poolId]`）：已经连续抽了多少次没出 SP */
  function dreamSteps(data, poolId) {
    var m = data && data.player && data.player.dream
    if (!m || typeof m !== 'object') return 0
    var raw = Number(m[poolId])
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
  }

  /**
   * 当前次数下的**有效出率权重**。
   *
   * SP 每累计一次 +spStep，从 `spFrom`（默认最低档，就是 SR）那一档**等量扣掉** ——
   * 一加一减，权重合计不变，所以归一化之后就是「SP 涨多少、SR 就掉多少」，
   * 而 SSR/UR 的百分比不受影响。
   *
   * @returns {{weights:object, steps:number, cap:number, spId:string, fromId:string}}
   */
  function dreamWeights(data, pool, steps) {
    var d = dreamConfig(pool) || {}
    var base = d.weights || {}
    var cap = Math.max(0, Math.floor(Number(d.spMaxSteps === undefined ? 75 : d.spMaxSteps) || 0))
    var step = Number(d.spStep === undefined ? 0.1 : d.spStep)
    if (!Number.isFinite(step) || step < 0) step = 0
    var k = Math.max(0, Math.min(cap, Math.floor(Number(steps) || 0)))
    var spId = topRarityId(data)
    var fromId = String(d.spFrom || lowestRarityId(data) || '')
    var out = {}
    for (var rid in base) {
      if (Object.prototype.hasOwnProperty.call(base, rid)) out[rid] = Number(base[rid] || 0)
    }
    var shift = k * step
    if (spId && out[spId] !== undefined) out[spId] = out[spId] + shift
    if (fromId && out[fromId] !== undefined) out[fromId] = Math.max(0, out[fromId] - shift)
    return { weights: out, steps: k, cap: cap, spId: spId, fromId: fromId }
  }

  /** 最低档的 id（rank 最小的那一档）。表为空时返回空串。 */
  function lowestRarityId(data) {
    var list = (data && data.rarities) || []
    var best = ''
    var bestRank = Infinity
    for (var i = 0; i < list.length; i++) {
      var rk = Number(list[i].rank || 0)
      if (rk <= bestRank) {
        bestRank = rk
        best = list[i].id
      }
    }
    return best
  }

  /**
   * 追梦模式下这一档用哪套工艺概率（追梦池里三档都上调：40/10/1）。
   * 池子没配就退回全局那套。
   */
  function dreamFoilRates(data, pool) {
    var cfg = (data && data.settings && data.settings.foils) || {}
    var base = cfg.rates || {}
    var d = dreamConfig(pool) || {}
    var over = d.foilRates && typeof d.foilRates === 'object' ? d.foilRates : null
    if (!over) return base
    var out = {}
    for (var i = 0; i < FOIL_IDS.length; i++) {
      var id = FOIL_IDS[i]
      var v = over[id] === undefined ? base[id] : over[id]
      out[id] = Number.isFinite(Number(v)) ? Number(v) : Number(base[id] || 0)
    }
    return out
  }

  /**
   * 抽完之后追梦计数变成什么（**纯函数**，逐张按顺序判定）。
   *   抽到 SP -> 归零（用户要求「抽到 SP 卡之后重置概率」）
   *   没抽到   -> +1，封顶 cap（用户要求「最多计算 75 次」）
   */
  function dreamStepsAfter(data, pool, steps, results) {
    var d = dreamConfig(pool) || {}
    var cap = Math.max(0, Math.floor(Number(d.spMaxSteps === undefined ? 75 : d.spMaxSteps) || 0))
    var spId = topRarityId(data)
    var k = Math.max(0, Math.min(cap, Math.floor(Number(steps) || 0)))
    for (var i = 0; i < (results || []).length; i++) {
      var rid = results[i] && results[i].rarityId
      if (spId && rid === spId) k = 0
      else k = Math.min(cap, k + 1)
    }
    return { steps: k, cap: cap, reset: k === 0 }
  }

  /**
   * 追梦池的**长期平均出率**（解析解，不是模拟）。
   *
   * 为什么需要它：追梦池的概率是随次数变化的马尔可夫过程（抽到 SP 就回到 0），
   * 所以「标称 2.5%」只在第 0 次成立。要知道长期实际出率是多少，
   * 得算这个链的平稳分布 —— 有了它，「实测概率 vs 标称概率」那条自检
   * 才有一个**正确的比较基准**（否则会拿一个逐次变化的瞬时值去比平均值，
   * 得出一堆假偏差）。
   *
   * 做法：状态 k = 已连续未出 SP 的次数（0..cap），
   *   转移：以 p(k) 出 SP -> 回到 0；否则 -> min(k+1, cap)。
   *   迭代 πP 若干轮得到平稳分布，再对每个档位求期望。
   */
  function dreamLongRunRates(data, pool) {
    var d = dreamConfig(pool)
    if (!d) return null
    var cap = Math.max(0, Math.floor(Number(d.spMaxSteps === undefined ? 75 : d.spMaxSteps) || 0))
    var states = cap + 1
    var base = dreamWeights(data, pool, 0).weights
    var total = 0
    for (var rid in base) if (Object.prototype.hasOwnProperty.call(base, rid)) total += Number(base[rid] || 0)
    if (!(total > 0)) return null
    // 每个状态的「出 SP 概率」（权重占比口径）
    var spId = topRarityId(data)
    var p = []
    for (var k = 0; k <= cap; k++) {
      var w = dreamWeights(data, pool, k).weights
      var sum = 0
      for (var r2 in w) if (Object.prototype.hasOwnProperty.call(w, r2)) sum += Number(w[r2] || 0)
      p.push(sum > 0 ? Number(w[spId] || 0) / sum : 0)
    }
    var pi = []
    for (var i = 0; i < states; i++) pi.push(1 / states)
    // 迭代到平稳（cap 只有几十，几百轮就非常接近了；不写线性求解器免得引误差）
    for (var iter = 0; iter < 4000; iter++) {
      var next = []
      for (var j = 0; j < states; j++) next.push(0)
      for (var s = 0; s < states; s++) {
        next[0] += pi[s] * p[s]
        var to = Math.min(s + 1, cap)
        next[to] += pi[s] * (1 - p[s])
      }
      pi = next
    }
    var rates = {}
    var ids = []
    for (var r3 in base) if (Object.prototype.hasOwnProperty.call(base, r3)) ids.push(r3)
    for (var a = 0; a < ids.length; a++) rates[ids[a]] = 0
    for (var s2 = 0; s2 <= cap; s2++) {
      var w2 = dreamWeights(data, pool, s2).weights
      var tot2 = 0
      for (var r4 in w2) if (Object.prototype.hasOwnProperty.call(w2, r4)) tot2 += Number(w2[r4] || 0)
      if (!(tot2 > 0)) continue
      for (var r5 in w2) {
        if (!Object.prototype.hasOwnProperty.call(w2, r5)) continue
        rates[r5] += pi[s2] * (Number(w2[r5] || 0) / tot2)
      }
    }
    // 回到「每 100 抽几次」的口径，和 rateTable 一致
    var out = {}
    for (var r6 in rates) if (Object.prototype.hasOwnProperty.call(rates, r6)) out[r6] = rates[r6] * 100
    // 平均多少抽出一张 SP：先算前 cap+1 抽，剩下的按封顶概率 p[cap] 的几何分布
    var e = 0
    var surv = 1
    for (var t = 0; t <= cap; t++) {
      e += surv * (t + 1) * p[t]
      surv *= 1 - p[t]
    }
    if (surv > 0 && p[cap] > 0) e += surv * (cap + 1 + 1 / p[cap])
    return { rates: out, steps: cap, spId: spId, expectedDrawsPerSp: e }
  }

  /**
   * 一次抽卡的**价格**（不只是数字，还要说是哪种资源）：
   *   · 普通模式 -> **点数**（用户 2026-09-18：「普通卡池的抽取改为需要消耗抽卡次数，
   *     每天登陆赠送 300 点数，每一个点数可以进行一次普通抽卡」）
   *   · 追梦模式 -> **抽卡券**（池子自己的票价）
   * @returns {{amount:number, currency:'points'|'tickets', name:string}}
   */
  function priceFor(data, count, opts) {
    opts = opts || {}
    var n = Math.max(1, Number(count) || 1)
    if (opts.dream && dreamConfig(opts.pool)) {
      var d = dreamConfig(opts.pool)
      var c = d.cost && typeof d.cost === 'object' ? d.cost : {}
      var single = Number(c.single === undefined ? 1 : c.single)
      var ten = c.ten === undefined || c.ten === null ? null : Number(c.ten)
      if (!Number.isFinite(single) || single < 0) single = 1
      var amount = n >= 10 && ten !== null && Number.isFinite(ten) && ten >= 0 ? ten : single * n
      return { amount: amount, currency: 'tickets', name: '抽卡券' }
    }
    var pull = (data && data.settings && data.settings.pull) || {}
    var si = Number(pull.costSingle || 0)
    var t = pull.costTen === null || pull.costTen === undefined ? null : Number(pull.costTen)
    var amt = n >= 10 && t !== null && Number.isFinite(t) ? t : si * n
    return { amount: Math.max(0, amt), currency: 'points', name: '点数' }
  }

  /** 兼容旧签名：只回数字（amount）。新代码请用 priceFor（它还会告诉你是哪种资源）。 */
  function costFor(data, count, opts) {
    return priceFor(data, count, opts).amount
  }

  /**
   * 今日的每日赠送（**纯函数**，不改任何东西）。
   *
   * 规则：每天（本地日期）第一次打开页面时送 `settings.daily.points` 点，
   * 一天只送一次 —— 判定靠 `player.lastGift` 这个 `YYYY-MM-DD` 字符串。
   *
   * ⚠️ 2026-09-19 起，**这个函数不再被页面自动调用**：作者要求「每日登录赠送的
   * 点数改为签到领取」，所以它现在只负责「今天还能不能领、基础点数是多少」，
   * 由签到流程（`checkinState` / 页面上的签到按钮）调用。去重仍然共用
   * `giftClaimedOn` —— 换个入口再领一次是不允许的。
   *
   * @param {string} today `YYYY-MM-DD`（由调用方按**本地时区**算好传进来）
   * @returns {{ok:boolean, points:number, date:string, reason?:string}}
   */
  function dailyGift(data, today) {
    var cfg = (data && data.settings && data.settings.daily) || {}
    if (cfg.enabled === false) return { ok: false, points: 0, date: '', reason: '每日赠送已关闭' }
    var amount = Math.max(0, Math.floor(Number(cfg.points === undefined ? 300 : cfg.points)))
    if (!(amount > 0)) return { ok: false, points: 0, date: '', reason: '赠送点数是 0' }
    var day = String(today || '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, points: 0, date: '', reason: '日期格式不对' }
    if (giftClaimedOn(data, day)) return { ok: false, points: 0, date: day, reason: '今天已经领过了' }
    return { ok: true, points: amount, date: day }
  }

  /**
   * 这一天领过没有 —— **每日赠送与签到共用同一个标记**（`player.lastGift`）。
   *
   * 单独抽出来是因为「已经领过」这个判定有两个入口（旧的每日赠送路由、
   * 新的签到），而两份实现迟早会分叉：分叉的症状是「换个入口又能领一次」，
   * 也就是点数凭空翻倍，页面上完全看不出来。
   */
  function giftClaimedOn(data, day) {
    var d = String(day || '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false
    var p = (data && data.player) || {}
    return String(p.lastGift || '') === d
  }

  /** 本地时区的 `YYYY-MM-DD`（每日赠送按本地日期算，不能用 UTC —— 那会在晚上 8 点换日） */
  function localDateStr(now) {
    var d = now ? new Date(now) : new Date()
    var p = function (n) {
      return (n < 10 ? '0' : '') + n
    }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  }

  // ---------------------------------------------------------------------------
  // 每日签到（用户 2026-09-19）
  // ---------------------------------------------------------------------------
  //
  // 原话：「增加每日签到的页面，每日登录赠送的点数改为签到领取，签到按钮每天
  //   凌晨 3 点刷新。签到的时候，会从已拥有的卡牌中随机挑选一张 UR/SP 卡牌
  //   （纪念卡无法被抽取），根据卡牌种类获得额外点数：A 乘以 B。
  //   A=2/5（UR/SP），B=1/2/5/15（平卡/面闪/全闪/红碎）。这个卡牌抽取结果可以
  //   进行三次重抽，重抽后也保留原本的卡，相当于用户可以自行从四张卡中选择。」
  //
  // 规则全部在这里（纯函数），页面、服务端、测试共用同一份 ——
  // 「服务端记了、页面没记」这类分叉在这个项目里踩过太多次。

  /** 签到配置（缺字段时的兜底与归一化保持一致，别在两处各写一套默认值） */
  function dailyConfig(data) {
    var cfg = (data && data.settings && data.settings.daily) || {}
    var rarities = Array.isArray(cfg.rarities) ? cfg.rarities.slice() : ['UR', '???']
    // ⚠️ 缺键时的兜底必须是**文档里那个数**（UR=2 / SP=5），不能图省事写 1：
    // 老 data.json 里根本没有 settings.daily，写 1 的话 A 会静默变成 1 倍，
    // 也就是「UR 平卡 1 点」—— 数字合法、页面上也看不出来，只是需求没实现。
    var rfDefaults = { UR: 2, '???': 5 }
    var rf = {}
    for (var i = 0; i < rarities.length; i++) {
      var rid = rarities[i]
      var def = rfDefaults[rid] === undefined ? 1 : rfDefaults[rid]
      var v = cfg.rarityFactor && cfg.rarityFactor[rid]
      rf[rid] = Math.max(0, Math.floor(Number(v === undefined ? def : v)))
    }
    var ff = {}
    var kinds = [''].concat(FOIL_IDS)
    var ffDefaults = { '': 1, flat: 2, full: 5, shatter: 15 }
    for (var k = 0; k < kinds.length; k++) {
      var id = kinds[k]
      var raw = cfg.foilFactor && cfg.foilFactor[id]
      ff[id] = Math.max(0, Math.floor(Number(raw === undefined ? ffDefaults[id] : raw)))
    }
    return {
      enabled: cfg.enabled !== false,
      /**
       * 每天签到的基础点数。兜底值与 `lib/data.js` 的 `defaultDaily().points` 必须一致
       *（2026-09-20 用户把它从 300 改成 400；`test-plugin.mjs` 有一条断言钉着这两处）。
       */
      points: Math.max(0, Math.floor(Number(cfg.points === undefined ? 400 : cfg.points))),
      rerolls: Math.max(0, Math.min(20, Math.floor(Number(cfg.rerolls === undefined ? 3 : cfg.rerolls)))),
      refreshHour: Math.max(0, Math.min(23, Math.floor(Number(cfg.refreshHour === undefined ? 3 : cfg.refreshHour)))),
      rarities: rarities,
      rarityFactor: rf,
      foilFactor: ff,
    }
  }

  /**
   * 签到日：按 `refreshHour`（默认凌晨 3 点）切日，**不是**午夜。
   *
   * 做法是把时间往前挪 `refreshHour` 小时再取本地日期：于是 00:00~02:59
   * 仍然算「前一天」，到 03:00 才换日。这样也自动处理了跨月/跨年。
   */
  function checkinDay(now, refreshHour) {
    var h = Number(refreshHour)
    if (!isFinite(h)) h = 3
    h = Math.max(0, Math.min(23, Math.floor(h)))
    var t = now === undefined || now === null ? Date.now() : Number(now)
    if (!isFinite(t)) t = Date.now()
    return localDateStr(t - h * 3600 * 1000)
  }

  /** 下一次刷新（签到换日）的时刻，给页面显示「明天凌晨 3 点刷新」用 */
  function nextCheckinRefresh(now, refreshHour) {
    var h = Number(refreshHour)
    if (!isFinite(h)) h = 3
    h = Math.max(0, Math.min(23, Math.floor(h)))
    var t = now === undefined || now === null ? Date.now() : Number(now)
    if (!isFinite(t)) t = Date.now()
    var d = new Date(t)
    var at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, 0, 0, 0).getTime()
    if (t >= at) at = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, h, 0, 0, 0).getTime()
    return at
  }

  /** 名册里按 id 取卡（签到与 HR 都要用；找不到返回 null，绝不返回半个对象） */
  function cardOf(data, cardId) {
    var list = (data && data.cards) || []
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === cardId) return list[i]
    }
    return null
  }

  /**
   * 签到候选池：**已拥有、非纪念、非隐藏、且档位在资格表里**的卡。
   *
   * 「纪念卡无法被抽取」是用户明确要求 —— 纪念卡是给读者的补偿，
   * 不该再变成点数的来源；`hidden` 的卡连图鉴都不显示，也不该出现在开奖里。
   */
  function checkinPool(data) {
    var cfg = dailyConfig(data)
    var list = (data && data.cards) || []
    var owned = ((data && data.player && data.player.owned) || {})
    var out = []
    for (var i = 0; i < list.length; i++) {
      var c = list[i]
      if (!c || !c.id || c.hidden || c.memorial) continue
      if (cfg.rarities.indexOf(c.rarity) < 0) continue
      if (Number(owned[c.id] || 0) <= 0) continue
      out.push(c)
    }
    return out
  }

  /**
   * 这张卡按哪种「种类」算 B：它拥有的**最高档**工艺；一门都没有就是平卡（`''`）。
   *
   * 为什么要取最高档而不是随机挑一门：作者说「根据卡牌种类」，而一张卡可以同时
   * 拥有平闪与红碎（先抽到平闪、后来又抽到红碎）。取最高档才符合直觉 ——
   * 红碎卡不该因为「它也有一张平闪」而被按平闪算。
   */
  function cardKindFinish(player, cardId) {
    var list = ((player && player.foils) || {})[cardId]
    var best = ''
    var bestTier = -1
    if (Object.prototype.toString.call(list) === '[object Array]') {
      for (var i = 0; i < list.length; i++) {
        var t = FOIL_IDS.indexOf(list[i])
        if (t > bestTier) {
          bestTier = t
          best = list[i]
        }
      }
    }
    return best
  }

  /** 额外点数 = A（档位系数）× B（工艺系数） */
  function checkinReward(data, card, finish) {
    var cfg = dailyConfig(data)
    var a = Number(cfg.rarityFactor[(card && card.rarity) || ''] || 0)
    var kind = FOIL_IDS.indexOf(finish) >= 0 ? finish : ''
    var b = Number(cfg.foilFactor[kind] || 0)
    return Math.max(0, Math.floor(a * b))
  }

  /**
   * 开一张候选卡（纯函数，随机源由调用方给）。
   *
   * 池子为空 / 已经全部开过时返回 `null` —— 调用方据此说清原因，
   * 而不是发一张 0 点的假候选（那看起来就像功能坏了）。
   *
   * @param {function} [rng] 随机源（默认 Math.random）
   * @param {Array<string>} [exclude] 已经开出来的卡 id —— 候选**不重复**。
   *   不去重的话，池子小的时候会出现「四张里有两张一模一样」，
   *   而用户要的是「从四张里自己选一张」，重复的候选等于选择退化。
   * @param {string} [only] 只要这一张。服务端校验「前端送来的候选」时用它：
   *   不在这张的池子里就返回 `null`，**不猜、也不换成别的**。
   */
  function checkinRoll(data, rng, exclude, only) {
    var pool = checkinPool(data)
    var used = {}
    if (Object.prototype.toString.call(exclude) === '[object Array]') {
      for (var e = 0; e < exclude.length; e++) used[String(exclude[e])] = true
    }
    var rest = []
    for (var q = 0; q < pool.length; q++) {
      if (!used[pool[q].id]) rest.push(pool[q])
    }
    if (only) {
      var hit = null
      for (var w = 0; w < rest.length; w++) {
        if (rest[w].id === String(only)) hit = rest[w]
      }
      if (!hit) return null
      rest = [hit]
    }
    if (!rest.length) return null
    var r = typeof rng === 'function' ? rng : Math.random
    var v = Number(r())
    if (!isFinite(v) || v < 0) v = 0
    if (v >= 1) v = 0.999999
    var card = rest[Math.floor(v * rest.length)]
    var finish = cardKindFinish(data && data.player, card.id)
    return { cardId: card.id, rarity: card.rarity, finish: finish, points: checkinReward(data, card, finish) }
  }

  /**
   * 今日签到的完整状态（纯函数）：能不能开、还能重抽几次、候选、能不能领、下次刷新。
   *
   * `rolls` 只在 `date === 今天` 时算数 —— 昨天的候选不能留到今天来领
   * （否则攒着不领，第二天一次领两张）。
   *
   * ⚠️ **「今天领过没有」只看 `checkin.done`，不看 `player.lastGift`。**
   *
   * 这是 2026-09-19 改成签到时的**迁移**决定，理由很具体：`lastGift` 是旧机制
   *（打开页面自动送 300 点）留下的标记，而旧版**已经上线过**。任何人今天打开过
   * 旧版静态站，他的浏览器里就有一个今天的 `lastGift`；动态站那边同理
   *（旧代码调 `api/player/gift` 写过盘）。如果新签到继续认这个标记，
   * **所有今天来过的人都会被判成「已经领过了」** —— 而且明天才会好，
   * 看起来就像新功能坏了。
   *
   * 所以新签到自己带一个标记（`checkin.done`，领取时写 true），旧标记不再参与判定。
   * 代价是「旧自动赠送 + 新签到」在同一天可能各给一次 300 点 ——
   * 这是作者明确要的（「重置今天的签到次数，更新完成之后今天可以立刻再签到」）。
   */
  function checkinState(data, now) {
    var cfg = dailyConfig(data)
    var day = checkinDay(now, cfg.refreshHour)
    var p = (data && data.player) || {}
    var ck = p.checkin && String(p.checkin.date || '') === day ? p.checkin : null
    var rolls = ck && Object.prototype.toString.call(ck.rolls) === '[object Array]' ? ck.rolls : []
    var claimed = ck ? String(ck.claimed || '') : ''
    var pool = checkinPool(data)
    // 能开几张 = min(1 + 重抽次数, 池子里有几张)（候选不重复，池子小就只能开满池子）
    var totalRolls = Math.min(1 + cfg.rerolls, pool.length)
    var done = !!(ck && ck.done)
    return {
      enabled: cfg.enabled,
      day: day,
      base: cfg.points,
      rolls: rolls,
      claimed: claimed,
      /** 今天领过了（领了就既不能重抽、也不能再领） */
      done: done,
      /**
       * 今天有没有「旧的每日赠送」留下来的标记 —— 只用于**说明**，不参与判定。
       * 页面据此可以提一句「（旧版今天已经送过 300 点，签到照样能领）」。
       */
      legacyGiftToday: !done && giftClaimedOn(data, day),
      totalRolls: totalRolls,
      rollsLeft: Math.max(0, totalRolls - rolls.length),
      poolSize: pool.length,
      canRoll: cfg.enabled && !done && rolls.length < totalRolls && pool.length > 0,
      // 池子为空时也可以「领」——那是一次只有基础点数的签到
      canClaim: cfg.enabled && !done && (rolls.length > 0 || pool.length === 0),
      nextRefreshAt: nextCheckinRefresh(now, cfg.refreshHour),
    }
  }

  /**
   * 领取某一张候选之后的玩家状态（纯函数）：
   * `{ ok, points, base, bonus, date, cardId, checkin, reason }`。
   *
   * 四道校验，任何一道不过都**不发点数**：
   *   ① 今天还没领过（`checkin.done`，见 `checkinState`）
   *   ② 这张卡真的在今天的候选里（不能凭空指定一张红碎 SP 来领 75 点）
   *   ③ 功能开着
   *   ④ 空 `cardId` 只接受「池子里一张 UR/SP 都没有」的那种签到
   * 点数 = 基础（`daily.points`）+ 这张候选的额外点数。
   *
   * 返回的 `checkin` 一定带 `done: true` —— 那是「今天领过没有」的**唯一**判据，
   * 漏了它的症状是「点一次领 300 点，点十次领 3000 点」。
   *
   * @param {string} cardId 空串 = 候选池为空，只领基础点数
   */
  function checkinClaimAfter(data, cardId, now) {
    var cfg = dailyConfig(data)
    var p = (data && data.player) || {}
    var state = checkinState(data, now)
    if (!cfg.enabled) return { ok: false, reason: '签到已关闭' }
    if (state.done) return { ok: false, reason: '今天已经领过了' }
    var want = String(cardId || '')
    if (!want) {
      // 没有卡可抽的签到：只发基础点数。
      // ⚠️ 不能顺手也放行「还没开卡就先领」——那等于「不开也能领」，
      // 而「开出来的卡按种类给额外点数」这半个需求就白设计了。
      if (state.poolSize > 0) return { ok: false, reason: '先点签到开卡，再从候选里挑一张' }
      return {
        ok: true,
        points: Math.max(0, state.base),
        base: Math.max(0, state.base),
        bonus: 0,
        date: state.day,
        cardId: '',
        checkin: { date: state.day, rolls: state.rolls, claimed: '', done: true },
        player: p,
      }
    }
    var hit = null
    for (var i = 0; i < state.rolls.length; i++) {
      if (state.rolls[i] && state.rolls[i].cardId === want) hit = state.rolls[i]
    }
    if (!hit) return { ok: false, reason: '这张卡不在今天的候选里' }
    var bonus = Math.max(0, Math.floor(Number(hit.points || 0)))
    return {
      ok: true,
      points: Math.max(0, state.base) + bonus,
      base: Math.max(0, state.base),
      bonus: bonus,
      date: state.day,
      cardId: want,
      checkin: { date: state.day, rolls: state.rolls, claimed: want, done: true },
      player: p,
    }
  }

  // ---------------------------------------------------------------------------
  // HR：用 HR 碎片兑换动态卡面（用户 2026-09-19）
  // ---------------------------------------------------------------------------

  /** HR 兑换配置（与 lib/data.js 的 defaultHr 保持一致） */
  function hrConfig(data) {
    var cfg = (data && data.settings && data.settings.hr) || {}
    return {
      enabled: cfg.enabled !== false,
      shards: Math.max(1, Math.floor(Number(cfg.shards === undefined ? 20 : cfg.shards))),
    }
  }

  /** 这张卡解锁了动态卡面没有 */
  function hasHr(player, cardId) {
    return !!((player && player.hr) || {})[cardId]
  }

  /**
   * 能不能兑换这张卡的动态卡面。**四种「不能」要分开说**，都糊成一句
   * 「不能兑换」的话，作者会以为是碎片不够。
   */
  function canUnlockHr(data, cardId) {
    var cfg = hrConfig(data)
    var card = cardOf(data, cardId)
    var p = (data && data.player) || {}
    var have = Math.max(0, Math.floor(Number(((p.shards) || {})[HR_SHARD_RARITY] || 0)))
    var cost = cfg.shards
    if (!cfg.enabled) return { ok: false, reason: 'HR 动态卡面的兑换已关闭', cost: cost, have: have }
    if (!card) return { ok: false, reason: '名册里没有这张卡', cost: cost, have: have }
    if (!card.dynamic) return { ok: false, reason: '这张卡没有配动态卡面', cost: cost, have: have }
    if (hasHr(p, cardId)) return { ok: false, reason: '这已经解锁过了', cost: cost, have: have, owned: true }
    if (have < cost) return { ok: false, reason: 'HR 碎片不够（还差 ' + (cost - have) + ' 个）', cost: cost, have: have }
    return { ok: true, cost: cost, have: have, card: card }
  }

  /**
   * 兑换之后的新状态（纯函数）：`{ ok, hr, shards, reason }`。
   *
   * **原子性**：先扣碎片再解锁，扣不出来就整笔不做 —— 半个状态
   *（碎片扣了、卡面没解锁）比不做更糟，而它在界面上看不出来。
   */
  function hrUnlockAfter(data, cardId) {
    var check = canUnlockHr(data, cardId)
    if (!check.ok) return { ok: false, reason: check.reason }
    var p = (data && data.player) || {}
    var shards = Object.assign({}, (p.shards) || {})
    var left = Math.max(0, Math.floor(Number(shards[HR_SHARD_RARITY] || 0)) - check.cost)
    if (left > 0) shards[HR_SHARD_RARITY] = left
    else delete shards[HR_SHARD_RARITY]
    var hr = Object.assign({}, (p.hr) || {})
    hr[cardId] = true
    return { ok: true, hr: hr, shards: shards, cost: check.cost, cardId: cardId }
  }

  // ---------------------------------------------------------------------------
  // 红碎兑换：拥有全闪之后，用 HR 碎片直接换这张卡的红碎工艺（用户 2026-09-22）
  // ---------------------------------------------------------------------------
  //
  // 原话：「在拥有相应卡牌的全闪工艺 UR/SP 之后，可以在图鉴中点开大图之后，
  //   点击红碎按钮，消耗 30/50 点 HR 碎片兑换对应的红碎工艺」。
  //
  // 拆开来是四条硬约束（少一条都会变成「点得动但换错东西」）：
  //   ① 只对 UR / SP（`???`）开放 —— 其余档位连红碎门槛都够不到（见 FOIL_KINDS）
  //   ② **必须已经拥有这张卡的全闪**（这正是用户说的前置条件）
  //   ③ 还没拥有红碎（否则就是花 30 个碎片买一张已经有的工艺）
  //   ④ HR 碎片够（30 for UR / 50 for SP，可配）

  /** 红碎兑换的价目表（与 lib/data.js 的 defaultHr().shatterCost 保持一致） */
  var SHATTER_COST_DEFAULTS = { UR: 30, '???': 50 }

  /**
   * 红碎兑换配置。
   *
   * `enabled` 跟 HR 的总开关走（关掉 HR 就两种兑换一起关），`shatterCost` 按档位配。
   * 价目表里**没有这个档位** = 这个档位不开放兑换（而不是「用默认价」）——
   * 默认价只用于 `UR` / `???` 这两个键缺失时，SR/SSR 这类档位不该被顺手放进来。
   */
  function shatterExchangeConfig(data) {
    var cfg = (data && data.settings && data.settings.hr) || {}
    var raw = cfg.shatterCost && typeof cfg.shatterCost === 'object' ? cfg.shatterCost : {}
    var cost = {}
    for (var k in SHATTER_COST_DEFAULTS) {
      if (!Object.prototype.hasOwnProperty.call(SHATTER_COST_DEFAULTS, k)) continue
      var v = raw[k]
      var n = Math.floor(Number(v === undefined ? SHATTER_COST_DEFAULTS[k] : v))
      cost[k] = Number.isFinite(n) && n > 0 ? n : SHATTER_COST_DEFAULTS[k]
    }
    return { enabled: cfg.enabled !== false, cost: cost }
  }

  /** 这张卡现在拥有哪些工艺（只留认识的 id） */
  function hasFoil(player, cardId, foilId) {
    var list = ((player && player.foils) || {})[cardId]
    if (!Array.isArray(list)) return false
    for (var i = 0; i < list.length; i++) {
      if (String(list[i]) === String(foilId)) return true
    }
    return false
  }

  /**
   * 能不能兑换这张卡的红碎。**每一种「不能」都要分开说**（与 `canUnlockHr` 同一条纪律）：
   * 都糊成「不能兑换」的话，读者会以为是碎片不够，而真正的原因可能是他还没抽到全闪。
   */
  function canExchangeShatter(data, cardId) {
    var cfg = shatterExchangeConfig(data)
    var card = cardOf(data, cardId)
    var p = (data && data.player) || {}
    var have = Math.max(0, Math.floor(Number(((p.shards) || {})[HR_SHARD_RARITY] || 0)))
    var cost = card ? cfg.cost[String(card.rarity)] : undefined
    if (!cfg.enabled) return { ok: false, reason: 'HR 碎片的兑换已关闭', have: have }
    if (!card) return { ok: false, reason: '名册里没有这张卡', have: have }
    if (cost === undefined) {
      return {
        ok: false,
        reason: '只有 UR / SP 能用这种方式换红碎（这张是 ' + String(card.rarity || '未设档位') + '）',
        have: have,
      }
    }
    if (!hasFoil(p, cardId, 'full')) {
      return { ok: false, reason: '要先拥有这张卡的**全闪**才能兑换红碎（现在还没有全闪）', have: have, cost: cost, needFull: true }
    }
    if (hasFoil(p, cardId, 'shatter')) {
      return { ok: false, reason: '这张卡的红碎已经有了', have: have, cost: cost, owned: true }
    }
    if (have < cost) return { ok: false, reason: 'HR 碎片不够（还差 ' + (cost - have) + ' 个）', have: have, cost: cost }
    return { ok: true, cost: cost, have: have, card: card }
  }

  /**
   * 兑换之后的新状态（纯函数）：`{ ok, foils, shards, cost, cardId }`。
   *
   * **原子性**与 `hrUnlockAfter` 一致：先扣碎片再加工艺，扣不出来就整笔不做 ——
   * 半个状态（碎片扣了、工艺没加上）在界面上看不出来。
   */
  function shatterExchangeAfter(data, cardId) {
    var check = canExchangeShatter(data, cardId)
    if (!check.ok) return { ok: false, reason: check.reason }
    var p = (data && data.player) || {}
    var shards = Object.assign({}, (p.shards) || {})
    var left = Math.max(0, Math.floor(Number(shards[HR_SHARD_RARITY] || 0)) - check.cost)
    if (left > 0) shards[HR_SHARD_RARITY] = left
    else delete shards[HR_SHARD_RARITY]

    var foils = {}
    var src = (p.foils) || {}
    for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) foils[k] = Array.isArray(src[k]) ? src[k].slice() : []
    var mine = foils[cardId] || []
    // 去重后按 FOIL_IDS 的固定顺序放：界面上的工艺标签顺序不该随机
    var set = {}
    for (var i = 0; i < mine.length; i++) set[String(mine[i])] = 1
    set.shatter = 1
    var next = []
    for (var f = 0; f < FOIL_IDS.length; f++) if (set[FOIL_IDS[f]]) next.push(FOIL_IDS[f])
    // 不认识的工艺 id 原样留着（不该由这里悄悄删掉别人的数据）
    for (var m in set) if (FOIL_IDS.indexOf(m) < 0) next.push(m)
    foils[cardId] = next

    return { ok: true, foils: foils, shards: shards, cost: check.cost, cardId: cardId, card: check.card }
  }

  /** 卡池概况：每档多少张、总共有多少张可抽。给「卡池一览」用。 */  function poolSummary(data, poolId) {
    var rarities = (data && data.rarities) || []
    var cards = (data && data.cards) || []
    var pools = (data && data.pools) || []
    var pool = null
    for (var i = 0; i < pools.length; i++) {
      if (!poolId || pools[i].id === poolId) {
        pool = pools[i]
        break
      }
    }
    var rows = []
    var total = 0
    for (var r = 0; r < rarities.length; r++) {
      var id = rarities[r].id
      var n = 0
      for (var c = 0; c < cards.length; c++) {
        if (!cards[c].hidden && cards[c].rarityKnown && cards[c].rarity === id) n++
      }
      var w = pool && pool.weights ? Number(pool.weights[id] || 0) : 0
      rows.push({ rarity: rarities[r], count: n, weight: w })
      total += n
    }
    return { pool: pool, rows: rows, total: total }
  }

  /**
   * 按权重算出「每个档位的实际出率」，给页面显示用。
   *
   * 注意：只对**池子里真的有卡**的档位归一化 —— 配了权重但没卡的档位
   * 实际出率是 0，按它参与归一化会把别的档位算得偏低。
   *
   * @param {object} [opts] `{ dream, steps }`：追梦模式要按**当前次数**算，
   *   否则显示的还是一开始的 2.5%（而实际已经在涨了）。
   */
  function rateTable(data, poolId, opts) {
    opts = opts || {}
    var summary = poolSummary(data, poolId)
    var weightOf = function (rid) {
      if (opts.dream && dreamConfig(summary.pool)) {
        var steps = opts.steps === undefined ? dreamSteps(data, poolId) : opts.steps
        return Number(dreamWeights(data, summary.pool, steps).weights[rid] || 0)
      }
      return summary.pool && summary.pool.weights ? Number(summary.pool.weights[rid] || 0) : 0
    }
    var totalW = 0
    var i
    for (i = 0; i < summary.rows.length; i++) {
      var w = weightOf(summary.rows[i].rarity.id)
      summary.rows[i].weight = w
      if (summary.rows[i].count > 0 && w > 0) totalW += w
    }
    var out = []
    for (i = 0; i < summary.rows.length; i++) {
      var row = summary.rows[i]
      var playable = row.count > 0 && row.weight > 0
      out.push({
        rarity: row.rarity,
        count: row.count,
        weight: row.weight,
        rate: totalW > 0 && playable ? row.weight / totalW : 0,
        playable: playable,
      })
    }
    return out
  }

  /**
   * 跑一批模拟抽卡，统计**实测出率**（档位 + 工艺）。
   *
   * 这是「检测真实概率是否与标称概率一致」的那把尺子：
   * 页面后台的概率自检用它，测试也用它（同一份实现，不然两边会给出不同的结论）。
   *
   * 追梦模式下**按真实过程推进计数**（抽到 SP 归零、否则 +1、封顶），
   * 所以这里量到的就是玩家实际会遇到的分布 —— 要跟它比的是
   * `dreamLongRunRates` 的解析长期平均，而不是「第 0 次的 2.5%」。
   */
  function simulate(data, opts) {
    opts = opts || {}
    var draws = Math.max(1, Math.min(2000000, Math.floor(Number(opts.draws) || 10000)))
    var batch = Math.max(1, Math.min(10, Math.floor(Number(opts.count) || 10)))
    var rng = opts.rng || mulberry32((Number(opts.seed) || 12345) >>> 0)
    var steps = Math.max(0, Math.floor(Number(opts.steps) || 0))
    var dreamOn = !!opts.dream
    /** 固定某个追梦次数不推进（测「第 k 次的瞬时概率」时用） */
    var freezeSteps = !!opts.freezeSteps
    var rarity = {}
    var finish = {}
    var done = 0
    var spHits = 0
    var spId = topRarityId(data)
    while (done < draws) {
      var n = Math.min(batch, draws - done)
      var res = drawMany(data, { poolId: opts.poolId, count: n, rng: rng, dream: dreamOn, dreamSteps: steps })
      if (!res.ok) return { ok: false, error: res.error }
      for (var i = 0; i < res.results.length; i++) {
        var one = res.results[i]
        rarity[one.rarityId] = Number(rarity[one.rarityId] || 0) + 1
        if (one.rarityId === spId) spHits++
        var f = one.finish || ''
        finish[f] = Number(finish[f] || 0) + 1
      }
      done += res.results.length
      // 追梦计数按真实过程推进（这才是玩家实际遇到的分布）。
      // `freezeSteps` 用来测**某一个次数下的瞬时概率** —— 那时候要把它按住不动。
      if (dreamOn && !freezeSteps && res.dreamSteps !== null && res.dreamSteps !== undefined) steps = res.dreamSteps
    }
    var rate = {}
    var ids = []
    for (var rid in rarity) ids.push(rid)
    for (var k = 0; k < ids.length; k++) rate[ids[k]] = (rarity[ids[k]] / done) * 100
    var foilRate = {}
    for (var k2 in finish) foilRate[k2 === '' ? 'none' : k2] = (finish[k2] / done) * 100
    return {
      ok: true,
      draws: done,
      rarityCount: rarity,
      rarityRate: rate,
      finishCount: finish,
      finishRate: foilRate,
      spHits: spHits,
      drawsPerSp: spHits > 0 ? done / spHits : Infinity,
      steps: steps,
    }
  }

  /**
   * 把「实测」与「标称」摆在一起，给出偏差与是否在容差内。
   *
   * 容差取 **3σ + 0.3 个百分点**：σ 是二项分布的标准差
   * （`sqrt(p(1-p)/n)`），加 0.3pp 是为了让极小概率档位
   *（比如 0.5% 的红碎）不会因为 σ 太小而被无意义的抖动判失败。
   */
  function compareRates(measured, expectedPct, draws) {
    var out = []
    for (var id in expectedPct) {
      if (!Object.prototype.hasOwnProperty.call(expectedPct, id)) continue
      var p = Number(expectedPct[id] || 0) / 100
      var got = Number(measured[id] === undefined ? 0 : measured[id])
      var sigma = draws > 0 ? Math.sqrt(Math.max(0, p * (1 - p)) / draws) * 100 : 0
      var tol = 3 * sigma + 0.3
      var diff = got - Number(expectedPct[id] || 0)
      out.push({
        id: id,
        expected: Number(expectedPct[id] || 0),
        measured: got,
        diff: diff,
        tolerance: tol,
        ok: Math.abs(diff) <= tol,
      })
    }
    return out
  }

  var api = {
    issues: issues,
    drawSingle: drawSingle,
    drawMany: drawMany,
    draw: drawSingle,
    costFor: costFor,
    priceFor: priceFor,
    dailyGift: dailyGift,
    localDateStr: localDateStr,
    // 每日签到（点数 + 抽一张已有 UR/SP 卡按 A×B 给额外点数）
    giftClaimedOn: giftClaimedOn,
    dailyConfig: dailyConfig,
    checkinDay: checkinDay,
    nextCheckinRefresh: nextCheckinRefresh,
    checkinPool: checkinPool,
    checkinReward: checkinReward,
    checkinRoll: checkinRoll,
    checkinState: checkinState,
    checkinClaimAfter: checkinClaimAfter,
    cardKindFinish: cardKindFinish,
    // HR：用 HR 碎片兑换动态卡面
    HR_SHARD_RARITY: HR_SHARD_RARITY,
    hrConfig: hrConfig,
    hasHr: hasHr,
    canUnlockHr: canUnlockHr,
    hrUnlockAfter: hrUnlockAfter,
    // 红碎兑换：拥有全闪之后，用 HR 碎片换这张卡的红碎工艺（用户 2026-09-22）
    shatterExchangeConfig: shatterExchangeConfig,
    hasFoil: hasFoil,
    canExchangeShatter: canExchangeShatter,
    shatterExchangeAfter: shatterExchangeAfter,
    // UR 保底：抽到重复 UR 之后，下一张 UR 必定未拥有（用户 2026-09-22）
    UR_PITY_RARITY: UR_PITY_RARITY,
    urPityActive: urPityActive,
    urExclusions: urExclusions,
    urPityAfter: urPityAfter,
    urPityNextTable: urPityNextTable,
    cardOf: cardOf,
    poolSummary: poolSummary,
    rateTable: rateTable,
    mulberry32: mulberry32,
    cryptoRandom: cryptoRandom,
    // SP 保底：给页面显示状态用，也给测试直接断言这套规则
    topRarityId: topRarityId,
    lowestRarityId: lowestRarityId,
    spPityActive: spPityActive,
    spPityAfter: spPityAfter,
    spExclusions: spExclusions,
    // 特殊工艺（闪卡）
    FOIL_KINDS: FOIL_KINDS,
    FOIL_IDS: FOIL_IDS,
    foilAllowed: foilAllowed,
    foilRoll: foilRoll,
    foilsAfter: foilsAfter,
    foilCollection: foilCollection,
    // 红碎补偿（重复红碎 -> 返券 + 下次十连必出同档未拥有的红碎）
    shatterComp: shatterComp,
    hasShatter: hasShatter,
    shatterPity: shatterPity,
    shatterTargets: shatterTargets,
    dupShatters: dupShatters,
    shatterCompAfter: shatterCompAfter,
    shatterPitySlots: shatterPitySlots,
    applyBatchToState: applyBatchToState,
    // 追梦池（动态概率）
    dreamConfig: dreamConfig,
    dreamAvailable: dreamAvailable,
    dreamSteps: dreamSteps,
    dreamWeights: dreamWeights,
    dreamFoilRates: dreamFoilRates,
    dreamStepsAfter: dreamStepsAfter,
    dreamLongRunRates: dreamLongRunRates,
    // 概率自检
    simulate: simulate,
    compareRates: compareRates,
  }

  root.Gacha = api
  // CommonJS / ESM 互操作，方便 Node 里直接 import 做测试
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
