/**
 * shards.js — 碎片系统的规则（纯逻辑，无 DOM）
 *
 * 用户 2026-09-15 明确的规则，2026-09-16 改了一处：
 *   · 抽到「图鉴里已经解锁过」的卡 = 重复
 *   · 每有一张重复卡，转化成一个**对应稀有度**的碎片
 *   · 5 个碎片可以：
 *       (a) 兑换一张**同档**卡牌 —— **指定哪一张**（原来是同档随机；
 *           现在在图鉴里点开一张卡，那里有「合成」按钮）
 *       (b) 换成一张**更高一级**稀有度的碎片
 *
 * ⚠️ 「指定」是硬要求，不是默认值：`canExchange(data, rarity, 'card')` 不给
 * cardId 会**直接判失败**。这里刻意不提供「没给目标就随机一张」的回退 ——
 * 一个会悄悄退回随机的接口，正是这次要修掉的东西。
 *
 * 这个文件不碰 DOM，也不碰存储 —— 它只回答「这样做合不合法、结果是什么」。
 * 所以它能同时被三处使用，规则只有一份：
 *   · page/page.js       —— 点按钮时先问它「能不能换」
 *   · lib/index.js       —— 服务端权威交换（校验后写盘）
 *   · scripts/test-shards.mjs —— 直接测
 *
 * 与 draw.js 一样挂在 globalThis 上，同时支持 CommonJS，方便 Node 里测。
 *
 * ---------------------------------------------------------------------------
 * ⚠️ 一处需要用户确认的语义
 * ---------------------------------------------------------------------------
 * 用户的原话是「5个碎片可以兑换一张对应稀有度的卡牌，或者更高一级稀有度的碎片」。
 * 字面读法有两种：
 *   (甲) 5 个碎片 -> 1 张同档卡牌 ／ 5 个碎片 -> 1 个高档碎片   【本实现】
 *   (乙) 5 个碎片 -> 1 张同档卡牌 ／ 5 个碎片 -> 5 个高档碎片
 * 这里按 (甲) 实现（「5 个换 1 个」在两个分句里是同一个比例），
 * 并且把比例做成**可配置**的 settings.shards.costForCard / costForUpgrade，
 * 所以如果是 (乙)，后台改一个数就行，不用改代码。
 */

;(function (root) {
  'use strict'

  /**
   * 默认比例（与 lib/data.js 的 defaultShards 保持一致）。
   * 升档是 **3:1**（每 3 个碎片合成高一级的碎片），
   * 但 UR -> SP 是例外 **9:1**（见 `upgradeCosts`）。
   */
  var DEFAULTS = { perDuplicate: 1, costForCard: 5, costForUpgrade: 3, upgradeCosts: { UR: 9 } }

  /**
   * 碎片 -> 抽卡券 的默认比例（用户 2026-09-18 最终版）：
   *   SR 9:1 ／ SSR 3:1 ／ UR 1:1 ／ SP(???) 1:9
   * 键是**档位 id**（`???` 就是 SP），值是 `{ shards, tickets }`：
   * 花 `shards` 个碎片换 `tickets` 张券，必须**整批**换 ——
   * 所以界面上是「换 1 批 / 换 N 批」，而不是按单个碎片算（SR 是 9:1，单个除不尽）。
   */
  var TICKET_DEFAULTS = {
    SR: { shards: 9, tickets: 1 },
    SSR: { shards: 3, tickets: 1 },
    UR: { shards: 1, tickets: 1 },
    '???': { shards: 1, tickets: 9 },
  }

  /**
   * 追梦池里重复卡的返还（用户 2026-09-18）：
   * 「追梦池中抽到的重复卡将不返还碎片，而是返还点数，不论品质均为 1 点，
   *   面闪/全闪/红碎额外返还 1/2/5 点」。
   *
   * 与 lib/data.js 的 defaultDreamReward 保持一致。
   */
  var DREAM_REWARD_DEFAULTS = { points: 1, foilBonus: { flat: 1, full: 2, shatter: 5 } }

  /**
   * 重复面闪/全闪的额外返还（与 lib/data.js 的 defaultDupReward 一致）。
   * 用户 2026-09-19：「重复的面闪额外返回一点点数（作者定：1 点），
   * 重复的全闪额外返还一个 HR 碎片」。
   */
  var DUP_REWARD_DEFAULTS = { flatPoints: 1, fullHrShards: 1 }

  /** 「清空缓存」重置后的起始资源（与 lib/data.js 的 defaultResetGift 一致） */
  var RESET_DEFAULTS = { points: 300, tickets: 20 }

  /**
   * 工艺 id 列表。
   *
   * 优先用 draw.js 那一份（浏览器里它先加载，是**唯一**的工艺定义）；
   * 拿不到时用这份兜底 —— 本文件要能在 Node 里单独加载（测试就是这么跑的）。
   * `test-shards.mjs` 里有一条断言把两者钉住，写歪了会红。
   */
  var FOIL_ID_FALLBACK = ['flat', 'full', 'shatter']

  function foilIds() {
    var g = root && root.Gacha
    if (g && Array.isArray(g.FOIL_IDS) && g.FOIL_IDS.length) return g.FOIL_IDS
    return FOIL_ID_FALLBACK
  }

  /**
   * HR 碎片在 `player.shards` 里的键。
   *
   * 与 `foilIds()` 同一条纪律：优先用 draw.js 那一份（浏览器里它是唯一真源），
   * 拿不到时用这里的兜底 —— 本文件要能在 Node 里单独加载。
   * 三份拷贝（lib/data.js / page/draw.js / page/shards.js）由
   * `test-plugin.mjs` §5f 钉在一起：键错开的症状是「服务端记了、页面读不到」，
   * 看起来像「返还丢了」。
   */
  var HR_SHARD_FALLBACK = 'HR'

  function hrShardKey() {
    var g = root && root.Gacha
    if (g && typeof g.HR_SHARD_RARITY === 'string' && g.HR_SHARD_RARITY) return g.HR_SHARD_RARITY
    return HR_SHARD_FALLBACK
  }

  /**
   * 取碎片规则，缺字段时退回默认值。
   * 传进来的可能是整个 data，也可能只是 settings —— 两种都吃。
   */
  function rules(dataOrSettings) {
    var s = dataOrSettings && dataOrSettings.settings ? dataOrSettings.settings : dataOrSettings || {}
    var sh = s && s.shards ? s.shards : {}
    var posInt = function (v, fb) {
      var n = Number(v)
      return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fb
    }
    return {
      perDuplicate: posInt(sh.perDuplicate, DEFAULTS.perDuplicate),
      costForCard: posInt(sh.costForCard, DEFAULTS.costForCard),
      costForUpgrade: posInt(sh.costForUpgrade, DEFAULTS.costForUpgrade),
      // 例外升级价：键是**来源档位** id（UR -> SP 是 9:1，其余 3:1）
      upgradeCosts: (function () {
        var raw = sh.upgradeCosts && typeof sh.upgradeCosts === 'object' ? sh.upgradeCosts : DEFAULTS.upgradeCosts
        var out = {}
        for (var k in raw) {
          if (!Object.prototype.hasOwnProperty.call(raw, k)) continue
          out[k] = posInt(raw[k], DEFAULTS.costForUpgrade)
        }
        return out
      })(),
    }
  }

  /**
   * 某个**来源档位**升到高一级要几个碎片。
   *
   * 默认 3:1，但 UR -> SP 是例外 9:1（用户：「UR碎片和SP碎片的兑换比也改为9:1，
   * 其余不变（即UR和SP之间为特殊档位）」）。界面上显示的价必须走这里，
   * 否则会告诉读者「3 个就能升」，点下去却被拒。
   */
  function upgradeCostFor(data, fromRarityId) {
    var r = rules(data)
    var v = r.upgradeCosts && r.upgradeCosts[fromRarityId]
    return Number.isFinite(Number(v)) && Number(v) >= 1 ? Math.floor(Number(v)) : r.costForUpgrade
  }
  /**
   * 每个档位的「碎片 -> 抽卡券」比例。
   *
   * ⚠️ 缺档位时**回落默认**，而不是「不能换」：作者把 `tickets` 里某一档删掉，
   * 意图通常是「这档懒得写」，不是「这档禁止兑换」—— 而「禁止」应该用 0 表达。
   * 写了 0 的档位会被保留成「不能换」（界面上会说明原因）。
   */
  function ticketRules(dataOrSettings) {
    var s = dataOrSettings && dataOrSettings.settings ? dataOrSettings.settings : dataOrSettings || {}
    var t = s && s.shards && s.shards.tickets && typeof s.shards.tickets === 'object' ? s.shards.tickets : null
    var out = {}
    var ids = Object.keys(TICKET_DEFAULTS)
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i]
      var d = TICKET_DEFAULTS[id]
      var raw = t ? t[id] : null
      if (raw && typeof raw === 'object') {
        var sh = Number(raw.shards)
        var tk = Number(raw.tickets)
        out[id] = {
          shards: Number.isFinite(sh) && sh >= 1 ? Math.floor(sh) : d.shards,
          // 0 是合法的：明确表示「这一档不开放兑换」
          tickets: Number.isFinite(tk) && tk >= 0 ? Math.floor(tk) : d.tickets,
        }
      } else {
        out[id] = { shards: d.shards, tickets: d.tickets }
      }
    }
    return out
  }

  /**
   * 碎片换券：每个档位现在能换多少、还差几个 —— 给界面用。
   * @returns {Array<{rarityId, label, have, perShards, perTickets, batches,
   *                  ticketsGain, missing, disabled}>}
   */
  function ticketStatus(data) {
    var t = ticketRules(data)
    var shards = (data && data.player && data.player.shards) || {}
    var list = sortedRarities(data)
    var out = []
    for (var i = 0; i < list.length; i++) {
      var rar = list[i]
      var rule = t[rar.id]
      if (!rule) continue
      var have = Math.max(0, Number(shards[rar.id] || 0))
      var disabled = !(rule.tickets > 0)
      var batches = disabled ? 0 : Math.floor(have / rule.shards)
      out.push({
        rarityId: rar.id,
        label: rar.label || rar.id,
        have: have,
        perShards: rule.shards,
        perTickets: rule.tickets,
        batches: batches,
        ticketsGain: batches * rule.tickets,
        missing: disabled ? 0 : Math.max(0, rule.shards - have),
        disabled: disabled,
      })
    }
    return out
  }

  /**
   * 能不能换：**整批**换（`batches` 批）。
   * @returns {{ok:true, cost, gain, rarity, batches} | {ok:false, error}}
   */
  function canExchangeTickets(data, rarityId, batches) {
    var t = ticketRules(data)
    var rule = t[rarityId]
    if (!rule) return { ok: false, error: '稀有度「' + rarityId + '」没有配置碎片兑换抽卡券的比例' }
    var known = null
    var list = sortedRarities(data)
    for (var i = 0; i < list.length; i++) if (list[i].id === rarityId) known = list[i]
    if (!known) return { ok: false, error: '稀有度「' + rarityId + '」不在档位表里' }
    if (!(rule.tickets > 0)) {
      return { ok: false, error: (known.label || rarityId) + ' 碎片目前不开放兑换抽卡券' }
    }
    var n = Math.floor(Number(batches))
    if (!Number.isFinite(n) || n < 1) return { ok: false, error: '至少要换 1 批' }
    var shards = (data && data.player && data.player.shards) || {}
    var have = Math.max(0, Number(shards[rarityId] || 0))
    var cost = n * rule.shards
    if (have < cost) {
      return {
        ok: false,
        error: (known.label || rarityId) + ' 碎片不够：换 ' + n + ' 批需要 ' + cost + ' 个，现有 ' + have + ' 个',
      }
    }
    return { ok: true, cost: cost, gain: n * rule.tickets, rarity: known, batches: n }
  }

  /**
   * 结算一次「碎片 -> 抽卡券」。**纯函数**，返回新的碎片表与券数。
   *
   * 券数加在 `currency` 上（服务端与静态站同名同形）——
   * 所以调用方拿到结果后要把 `currency` 一起写回去，别只写 shards。
   */
  function exchangeTickets(data, rarityId, batches) {
    var check = canExchangeTickets(data, rarityId, batches)
    if (!check.ok) return check
    var shards = Object.assign({}, (data && data.player && data.player.shards) || {})
    shards[rarityId] = Math.max(0, Number(shards[rarityId] || 0) - check.cost)
    if (shards[rarityId] === 0) delete shards[rarityId]
    var currency = Math.max(0, Number((data && data.player && data.player.currency) || 0)) + check.gain
    return {
      ok: true,
      shards: shards,
      currency: currency,
      cost: check.cost,
      gain: check.gain,
      rarity: check.rarity,
      batches: check.batches,
    }
  }

  /** 稀有度表按 rank 升序（rank 小的弱） */
  function sortedRarities(data) {
    var list = (data && data.rarities) || []
    return list.slice().sort(function (a, b) {
      return Number(a.rank || 0) - Number(b.rank || 0)
    })
  }

  /** 比 id 更高一级的稀有度；已经是最高档时返回 null */
  function nextRarity(data, rarityId) {
    var list = sortedRarities(data)
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === rarityId) return i + 1 < list.length ? list[i + 1] : null
    }
    return null
  }

  /** 比 id 更低一级的稀有度；已经是最低档时返回 null */
  function prevRarity(data, rarityId) {
    var list = sortedRarities(data)
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === rarityId) return i - 1 >= 0 ? list[i - 1] : null
    }
    return null
  }

  /** 某个稀有度有多少张**可抽**的卡（用来判断碎片能不能兑成卡） */
  function cardCountOfRarity(data, rarityId) {
    var cards = (data && data.cards) || []
    var n = 0
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i]
      if (!c.hidden && c.rarityKnown && c.rarity === rarityId) n++
    }
    return n
  }

  /** 按 id 找一张卡（找不到返回 null） */
  function findCard(data, cardId) {
    var id = String(cardId == null ? '' : cardId)
    if (!id) return null
    var cards = (data && data.cards) || []
    for (var i = 0; i < cards.length; i++) {
      if (cards[i] && String(cards[i].id) === id) return cards[i]
    }
    return null
  }

  /**
   * 某张卡能不能被合成（碎片兑卡已从「随机」改为「指定」）。
   *
   * 存在的意义：图鉴里每张卡都要独立知道自己「现在能不能合成、还差几个」，
   * 而判断只应该有一份 —— 所以它内部调用 `canExchange(..., 'card', cardId)`，
   * 不另写一套规则。稀有度直接从卡上取，调用方不用先查表。
   *
   * @returns {{ok:true, cost, card, rarity} | {ok:false, error, card?}}
   */
  function canSynthesize(data, cardId) {
    var card = findCard(data, cardId)
    if (!card) return { ok: false, error: '找不到卡牌「' + cardId + '」' }
    var check = canExchange(data, card.rarity, 'card', cardId)
    if (!check.ok) return { ok: false, error: check.error, card: card }
    return { ok: true, cost: check.cost, card: card, rarity: card.rarity }
  }

  /**
   * 每个稀有度的碎片能做什么 —— 给界面用，一眼看清「现在能换什么、还差几个」。
   * @returns {Array<{rarity, have, canRedeemCard, cardCount, missingForCard,
   *                  canUpgrade, nextRarity, missingForUpgrade, isTop}>}
   */
  function status(data) {
    var r = rules(data)
    var shards = (data && data.player && data.player.shards) || {}
    var out = []
    var list = sortedRarities(data)

    for (var i = 0; i < list.length; i++) {
      var rar = list[i]
      var have = Math.max(0, Number(shards[rar.id] || 0))
      var count = cardCountOfRarity(data, rar.id)
      var next = i + 1 < list.length ? list[i + 1] : null

      out.push({
        rarity: rar,
        have: have,
        // 兑卡：碎片够 **而且** 这一档真的有卡可兑。
        // 只说「碎片够」会让按钮点了才发现没有卡 —— 那是静默失败的一种。
        //
        // ⚠️ 改成指定兑换之后这个字段的含义变了：它现在只说
        // 「这一档**有卡可选**且碎片够」，不再代表「点一下就能换到一张」——
        // 具体换哪张要在图鉴里点。碎片页用它决定是否放行去图鉴。
        cardCount: count,
        canRedeemCard: have >= r.costForCard && count > 0,
        missingForCard: Math.max(0, r.costForCard - have),
        // 升档：碎片够 **而且** 有更高一档。最高档没有「更高一级」。
        nextRarity: next,
        isTop: !next,
        canUpgrade: !!next && have >= upgradeCostFor(data, rar.id),
        missingForUpgrade: next ? Math.max(0, upgradeCostFor(data, rar.id) - have) : 0,
        costForCard: r.costForCard,
        costForUpgrade: upgradeCostFor(data, rar.id),
      })
    }
    return out
  }

  /**
   * 能不能做这个操作。**判断只写一次，界面与写入方共用**。
   *
   * @param {'card'|'upgrade'} action
   * @param {string} [cardId] action==='card' 时**必须**给：要合成哪一张。
   *   兑卡已从「同档内随机」改成「指定」—— 所以没有目标就不是一次合法的兑换，
   *   这里直接判失败，而不是悄悄退回随机（静默退回随机正是要修掉的行为）。
   * @returns {{ok:true, cost:number, card:object|null, nextRarity:object|null}
   *          | {ok:false, error:string}}
   */
  function canExchange(data, rarityId, action, cardId) {
    var r = rules(data)
    if (action !== 'card' && action !== 'upgrade') {
      return { ok: false, error: '不认识的操作：' + action + '（只支持 card / upgrade）' }
    }
    var shards = (data && data.player && data.player.shards) || {}
    var have = Math.max(0, Number(shards[rarityId] || 0))

    var known = null
    var list = sortedRarities(data)
    for (var i = 0; i < list.length; i++) if (list[i].id === rarityId) known = list[i]
    if (!known) return { ok: false, error: '稀有度「' + rarityId + '」不在档位表里' }

    if (action === 'card') {
      if (!cardId) {
        return { ok: false, error: '没有指定要合成哪一张卡（现在是指定兑换，请在图鉴里点开一张再合成）' }
      }
      var target = findCard(data, cardId)
      if (!target) return { ok: false, error: '找不到卡牌「' + cardId + '」' }
      if (target.hidden) {
        return { ok: false, error: '「' + (target.name || cardId) + '」已隐藏，不能合成' }
      }
      // 纪念卡**不能用碎片合成**（用户 2026-09-18 紧急要求）：
      // 碎片若能换，就等于开了第二条获取途径，而「只可通过指定方式获取」正是这类卡的定义。
      // 2026-09-20 起纪念卡有两种来源，提示语要按这张卡**实际**的来源说，
      // 否则会指错路（让读者去重置一张重置拿不到的卡）。
      if (target.memorial) {
        var how = target.memorialFor
          ? '集齐「' + target.memorialFor + '」系列后自动获得（系列加新卡时会暂时回收）'
          : '只能在「清空缓存」（重置存档）时获赠'
        return {
          ok: false,
          error: '「' + (target.name || cardId) + '」是纪念卡 —— 不能用碎片合成，' + how,
        }
      }
      if (!target.rarityKnown) {
        return { ok: false, error: '「' + (target.name || cardId) + '」还没有设置稀有度，不能合成' }
      }
      // 档位必须与碎片档位一致 —— 否则就能用 SR 碎片换 UR 卡
      if (String(target.rarity) !== String(rarityId)) {
        return {
          ok: false,
          error: '「' + (target.name || cardId) + '」是 ' + String(target.rarity) + '，不是 ' + known.label +
            '，不能用 ' + known.label + ' 碎片合成',
        }
      }
      if (have < r.costForCard) {
        return {
          ok: false,
          error: known.label + ' 碎片不够：需要 ' + r.costForCard + ' 个，现有 ' + have + ' 个',
        }
      }
      return { ok: true, cost: r.costForCard, card: target, nextRarity: null }
    }

    var next = nextRarity(data, rarityId)
    if (!next) {
      return { ok: false, error: known.label + ' 已经是最高档，没有更高一级可以升' }
    }
    var upCost = upgradeCostFor(data, rarityId)
    if (have < upCost) {
      return {
        ok: false,
        error: known.label + ' 碎片不够：升档需要 ' + upCost + ' 个，现有 ' + have + ' 个',
      }
    }
    return { ok: true, cost: upCost, card: null, nextRarity: next }
  }

  /**
   * 计算一次交换的结果。**纯函数**：返回新的碎片表与（合成时的）卡牌，不改输入。
   *
   * @param {object} data 快照（需要 rarities / cards / player.shards / settings.shards）
   * @param {string} rarityId
   * @param {'card'|'upgrade'} action
   * @param {string} [cardId] action==='card' 时必须给（指定合成哪一张）
   * @returns {{ok:true, action, cost, shards, card, gainedShard, nextRarity}
   *          | {ok:false, error}}
   */
  function exchange(data, rarityId, action, cardId) {
    var check = canExchange(data, rarityId, action, cardId)
    if (!check.ok) return check

    var shards = Object.assign({}, (data && data.player && data.player.shards) || {})
    shards[rarityId] = Math.max(0, Number(shards[rarityId] || 0) - check.cost)
    if (shards[rarityId] === 0) delete shards[rarityId]

    if (action === 'upgrade') {
      var next = check.nextRarity
      shards[next.id] = Number(shards[next.id] || 0) + 1
      return {
        ok: true,
        action: action,
        cost: check.cost,
        shards: shards,
        card: null,
        gainedShard: { rarity: next.id, count: 1 },
        nextRarity: next,
      }
    }

    // 合成指定的那一张。canExchange 已经把「找不到/隐藏/没稀有度/档位不符」全挡过了，
    // 这里直接用它的结果 —— 不再自己查一遍（两处判断必然有一天会不一致）。
    return {
      ok: true,
      action: action,
      cost: check.cost,
      shards: shards,
      card: check.card,
      gainedShard: null,
      nextRarity: null,
    }
  }

  /**
   * 结算一次抽卡结果在碎片/拥有上的变化。**纯函数**。
   *
   * 「重复」的判定是：抽到的这张卡在**本次抽卡开始之前**就已经解锁过。
   * 所以一抽里连出两张同一张卡时，第一张算 NEW、第二张算重复 —— 必须在同一个
   * 循环里按顺序判断，不能先看整批。
   *
   * @param {object} data 快照（需要 settings.shards / player.owned / player.shards）
   * @param {Array<{card:{id,rarity}, rarityId}>} results drawMany 的结果
   * @param {object} [opts]
   *   @param {'shards'|'points'} [opts.reward='shards'] 重复卡返什么：
   *     普通池返**碎片**（按稀有度），追梦池返**点数**（用户要求：
   *     「不论品质均为 1 点，面闪/全闪/红碎额外返还 1/2/5 点」）。
   *   @param {string} [opts.poolId] 这一批是哪个池子抽的。红碎补偿要靠它
   *     找出「这一档还有哪些卡没拿到红碎」（只算这个池子抽得到的卡）。
   * @returns {{owned, shards, duplicates, newCards:Array, duplicateCards:Array,
   *            gainedShards:Object, gainedPoints:number, perCard:Array, reward:string,
   *            tickets:number, shatterHits:Array, shatterPity:Object|null,
   *            shatterFull:Array, shatterConverted:Array, shatterIdle:Array,
   *            shatterCompMissing?:boolean}}
   *   `tickets` 是红碎补偿返还的抽卡券；`shatterPity` 是**加上欠条之后完整的**
   *   未决表（调用方直接持久化整张表，别自己算增量）。
   *   `shatterFull` 是这一批「这一档红碎已集齐、按折价返还」的档位，
   *   `shatterConverted` 是其中来自旧欠条的那些（界面要说清欠条折成券了）。
   */
  function settleDraw(data, results, opts) {
    opts = opts || {}
    var r = rules(data)
    var reward = opts.reward === 'points' ? 'points' : 'shards'
    var dreamReward = dreamRewardRules(data)
    var dup = dupRewardRules(data)
    var owned = Object.assign({}, (data && data.player && data.player.owned) || {})
    var shards = Object.assign({}, (data && data.player && data.player.shards) || {})
    var duplicates = 0
    var newCards = []
    var duplicateCards = []
    var gainedShards = {}
    var gainedPoints = 0
    var perCard = []

    for (var i = 0; i < (results || []).length; i++) {
      var item = results[i]
      var card = item && (item.card || item)
      if (!card || !card.id) continue
      var rarity = card.rarity || (item && item.rarityId) || ''

      var isDuplicate = Number(owned[card.id] || 0) > 0
      owned[card.id] = Number(owned[card.id] || 0) + 1

      var gained = 0
      var points = 0
      var hrShards = 0
      if (isDuplicate) {
        duplicates++
        duplicateCards.push(card)
        // 这一张抽出来的工艺（没有 = 平卡）。两个池子都要看它。
        var fin = item && item.finish ? String(item.finish) : ''
        if (reward === 'points') {
          // 追梦池：碎片一个都不给，改成点数（基础 + 这一张的工艺加成）
          points = dreamReward.points + Number(dreamReward.foilBonus[fin] || 0)
          gainedPoints += points
        } else {
          gained = r.perDuplicate
          if (rarity) {
            shards[rarity] = Number(shards[rarity] || 0) + gained
            gainedShards[rarity] = Number(gainedShards[rarity] || 0) + gained
          }
        }
        /**
         * 闪卡重复的**额外**返还（用户 2026-09-19，两个池子都给）：
         *   平闪 -> 再给 `flatPoints` 点（作者定 1 点，「一点点数」）
         *   全闪 -> 再给 `fullHrShards` 个 **HR 碎片**（换动态卡面用的那种）
         * 红碎不在这条要求里：红碎重复已经由红碎补偿管（返券 + 攒欠条），
         * 再叠一笔会出现「两个机制都以为自己在管红碎」。
         */
        if (dup.enabled && fin === 'flat' && dup.flatPoints > 0) {
          points += dup.flatPoints
          gainedPoints += dup.flatPoints
        }
        if (dup.enabled && fin === 'full' && dup.fullHrShards > 0) {
          hrShards = dup.fullHrShards
          var hk = hrShardKey()
          shards[hk] = Number(shards[hk] || 0) + hrShards
          gainedShards[hk] = Number(gainedShards[hk] || 0) + hrShards
        }
      } else {
        newCards.push(card)
      }
      perCard.push({ card: card, rarity: rarity, duplicate: isDuplicate, shards: gained, points: points, hrShards: hrShards })
    }

    /**
     * 红碎补偿（用户 2026-09-19）：抽到「已经有了的红碎」时返券 + 攒一张欠条
     *（下次十连必出同档、自己还没有红碎的卡）。
     *
     * ⚠️ 规则本体在 `page/draw.js`（`shatterCompAfter`）—— 那里才有池子成员表
     * 与工艺判定，这里**只委托，不重写**。两份实现必然会在某次改动后分叉，
     * 而分叉的症状是「服务端记了、页面没记」（或反过来），极难查。
     * 委托不到时**不能假装补偿成功了**：明确标一个 missing 标志，由调用方留痕。
     */
    var comp = { tickets: 0, hits: [], armed: {}, pity: null, idle: [], full: [], converted: [] }
    var compMissing = false
    // 规则模块从两个地方取：浏览器里是全局的 Gacha；服务端里 shards.js 与 draw.js
    // 是两个独立的 vm 沙箱，摸不到彼此的全局，所以由调用方（lib/index.js）显式传进来。
    var g = (opts && opts.shatterApi) || (typeof globalThis !== 'undefined' && globalThis ? globalThis.Gacha : null)
    if (g && typeof g.shatterCompAfter === 'function') {
      var pool = null
      var pools = (data && data.pools) || []
      for (var pi = 0; pi < pools.length; pi++) {
        if (pools[pi].id === opts.poolId) pool = pools[pi]
      }
      if (pool) {
        var res = g.shatterCompAfter(data, pool, data && data.player, results)
        comp = res
      }
    } else {
      compMissing = true
    }

    return {
      owned: owned,
      shards: shards,
      duplicates: duplicates,
      newCards: newCards,
      duplicateCards: duplicateCards,
      gainedShards: gainedShards,
      gainedPoints: gainedPoints,
      perCard: perCard,
      reward: reward,
      tickets: comp.tickets,
      shatterHits: comp.hits,
      shatterPity: comp.pity,
      shatterArmed: comp.armed,
      shatterFull: comp.full || [],
      shatterConverted: comp.converted || [],
      shatterIdle: comp.idle,
      shatterCompMissing: compMissing,
    }
  }

  /**
   * 追梦池重复卡的返还规则（缺字段回落默认）。
   * @returns {{points:number, foilBonus:Object<string,number>}}
   */
  function dreamRewardRules(dataOrSettings) {
    var s = dataOrSettings && dataOrSettings.settings ? dataOrSettings.settings : dataOrSettings || {}
    var raw = s && s.dreamReward && typeof s.dreamReward === 'object' ? s.dreamReward : {}
    var bonus = {}
    var rawBonus = raw.foilBonus && typeof raw.foilBonus === 'object' ? raw.foilBonus : DREAM_REWARD_DEFAULTS.foilBonus
    var ids = Object.keys(DREAM_REWARD_DEFAULTS.foilBonus)
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i]
      var n = Number(rawBonus[id])
      bonus[id] = Number.isFinite(n) && n >= 0 ? Math.floor(n) : DREAM_REWARD_DEFAULTS.foilBonus[id]
    }
    var base = Number(raw.points)
    return {
      points: Number.isFinite(base) && base >= 0 ? Math.floor(base) : DREAM_REWARD_DEFAULTS.points,
      foilBonus: bonus,
    }
  }

  /**
   * 重复的**面闪/全闪**再额外返还什么（用户 2026-09-19）：
   * 「抽取到重复的面闪卡牌时，额外返回一点点数，不论是普通池还是逐梦池；
   *   抽取到重复的全闪卡牌时，额外返还一个 HR 碎片」。
   *
   * ⚠️ 与 `dreamRewardRules` 是**两笔**，不是一件事：
   *   · dreamReward 管「追梦池的重复卡改返点数」（普通池根本不走它）
   *   · 这一份管「重复的**闪卡**额外再给什么」，**两个池子都给**
   * 合成一处就会出现「普通池的重复面闪不给点数」或者「追梦池的重复全闪不给碎片」——
   * 两种都只在半边池子里错，页面上很难看出来。
   *
   * @returns {{enabled:boolean, flatPoints:number, fullHrShards:number}}
   */
  function dupRewardRules(dataOrSettings) {
    var s = dataOrSettings && dataOrSettings.settings ? dataOrSettings.settings : dataOrSettings || {}
    var raw = s && s.dupReward && typeof s.dupReward === 'object' ? s.dupReward : {}
    var pick = function (v, fallback) {
      var n = Number(v)
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
    }
    return {
      enabled: raw.enabled !== false,
      flatPoints: pick(raw.flatPoints, DUP_REWARD_DEFAULTS.flatPoints),
      fullHrShards: pick(raw.fullHrShards, DUP_REWARD_DEFAULTS.fullHrShards),
    }
  }

  /**
   * 「清空缓存（重置存档）」之后会拿到多少资源（点数 / 抽卡券）。
   *
   * 为什么单独抽成一个公开函数：**公告弹窗也要把这两个数说出来**
   *（「重置后会赠送：点数 300、抽卡券 20 张」）。弹窗自己读 settings 的话，
   * 数据里没配这一段时它会写「点数 0」，而 resetPlayer 实际给的是默认的 300
   * —— 那就是界面在骗人。所以两处都走这一份，兜底值也只有一处。
   */
  function resetGift(data) {
    var s = (data && data.settings) || {}
    var rs = s.reset && typeof s.reset === 'object' ? s.reset : {}
    var pick = function (v, fallback) {
      var n = Number(v)
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
    }
    return {
      points: pick(rs.points, RESET_DEFAULTS.points),
      tickets: pick(rs.tickets, RESET_DEFAULTS.tickets),
    }
  }

  /**
   * 「清空缓存」：把存档重置成起始状态 + 赠送纪念卡（**纯函数**）。
   *
   * 用户 2026-09-18：「清空当前拥有的所有碎片、卡牌，点数重置到 300，
   * 抽卡券重置到 20 张。然后赠送本地新增的三张纪念卡」。
   *
   * 纪念卡 = 数据里 `memorial` 非空的卡。**每张都同时拥有三种特殊工艺**
   *（用户 2026-09-18：「赠送的三张奇迹卡，都是同时拥有三种特殊工艺」），
   * 所以它们打开大图就能在 普通 / 平闪 / 全闪 / 红碎 之间切换。
   * **它们不进任何卡池**（见 lib/data.js 的 poolCardIds）。
   */
  function resetPlayer(data) {
    var giftCfg = resetGift(data)
    var points = giftCfg.points
    var tickets = giftCfg.tickets

    var gift = []
    var owned = {}
    var foils = {}
    var allFinishes = foilIds().slice()
    var cards = (data && data.cards) || []
    /*
     * ⚠️ 只赠送「重置就送」的那一批（`memorial` 有值、`memorialFor` 空）。
     *
     * 「集齐系列才有」的纪念卡（`memorialFor` 非空）**不能**在这里送：重置之后
     * 一张卡都没有、系列当然没集齐，送了等于凭空发一张 —— 而且**领完立刻会被
     * `reconcileMemorials` 回收**（用户要求：系列没集齐就没有它）。
     * 两处规则不一致的症状是「重置完弹窗说送了，关掉弹窗卡就没了」。
     */
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i]
      if (!c || !c.memorial || c.memorialFor) continue
      owned[c.id] = 1
      if (allFinishes.length) foils[c.id] = allFinishes.slice()
      gift.push({ card: c, finishes: allFinishes.slice(), finish: allFinishes[allFinishes.length - 1] || '' })
    }

    var player = {
      currency: tickets,
      currencyName: (data && data.player && data.player.currencyName) || '抽卡券',
      points: points,
      lastGift: '',
      pulls: 0,
      sinceTop: 0,
      history: [],
      owned: owned,
      shards: {},
      duplicates: 0,
      spPity: {},
      dream: {},
      // 红碎补偿的欠条也要清掉：重置之后连卡都没有了，欠着的「必出红碎」
      // 会变成一张凭空多出来的补偿（而且新号本来就能领三张纪念卡）
      shatterPity: {},
      foils: foils,
    }
    return { player: player, gift: gift, stats: { points: points, tickets: tickets, giftCount: gift.length } }
  }

  /** 纪念卡列表（图鉴里单独分一组；它们不进任何卡池） */
  function memorialCards(data) {
    var out = []
    var cards = (data && data.cards) || []
    for (var i = 0; i < cards.length; i++) {
      if (cards[i] && cards[i].memorial) out.push(cards[i])
    }
    return out
  }

  /**
   * 纪念卡里「**重置存档就送**」的那一批（`memorialFor` 为空）。
   *
   * 公告弹窗只该拿这一批去判断「缺不缺」并承诺「重置会送全部 N 张」——
   * 把「集齐系列才有」的卡也算进去，弹窗就会**骗人**：它会劝读者重置去领一张
   * 重置完立刻被回收的卡。这是 2026-09-20 加 `memorialFor` 时最容易漏的一处。
   */
  function resetMemorialCards(data) {
    var all = memorialCards(data)
    var out = []
    for (var i = 0; i < all.length; i++) if (!all[i].memorialFor) out.push(all[i])
    return out
  }

  /** 纪念卡里「**集齐某个系列才给**」的那一批（`memorialFor` 非空） */
  function seriesMemorialCards(data) {
    var all = memorialCards(data)
    var out = []
    for (var i = 0; i < all.length; i++) if (all[i].memorialFor) out.push(all[i])
    return out
  }

  /**
   * 某个系列的收集进度（**唯一一份判据**：界面、服务端、回收/发放都用它）。
   *
   * 三件容易写错的事：
   *   · **隐藏卡不算**（作者把一张卡设为隐藏 = 不想让它出现，不该卡住收集）；
   *   · **纪念卡不算**（它们本来就不进任何池子，抽不到，算进去就永远集不齐）；
   *   · **`owned > 0` 就算拥有**（重复张数不影响「集齐」，多抽几张不该更容易集齐）。
   * 系列里一张可收集的卡都没有时 `complete` 是 **false**（不是 true）——
   * 「空集合算完整」会让一张系列名写错的纪念卡直接白送。
   */
  function seriesProgress(data, series, ownedMap) {
    var name = String(series == null ? '' : series)
    var owned = ownedMap || {}
    var cards = (data && data.cards) || []
    var total = 0
    var got = 0
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i]
      if (!c || c.hidden || c.memorial) continue
      if (String(c.series || '') !== name) continue
      total++
      if (Number(owned[c.id] || 0) > 0) got++
    }
    return { series: name, total: total, got: got, complete: total > 0 && got >= total }
  }

  /**
   * 某张纪念卡的获取条件。返回 `null` = 这张不是「集齐系列」类的纪念卡。
   * 界面用它画「集齐「冥幽」系列 3/5」这类提示。
   */
  function memorialRequirement(data, card, ownedMap) {
    if (!card || !card.memorial || !card.memorialFor) return null
    var owned = ownedMap || (data && data.player && data.player.owned) || {}
    return seriesProgress(data, card.memorialFor, owned)
  }

  /**
   * 把「集齐系列才有」的纪念卡**对齐到当前收集状态**（纯函数，就地改 `data.player`）。
   *
   * 用户 2026-09-20：「在收集完成『冥幽』系列之后领取。如果后续『冥幽』系列推出
   * 新的卡片，则纪念卡会被回收，在重新收集完成时再次获得。」
   *
   * 这是一个**双向**判定，不是一个一次性发奖：
   *   · 系列集齐了、卡还没有 -> **发放**（`owned` +1，并附赠**全部**特殊工艺）
   *   · 系列没集齐、卡却有   -> **回收**（连同它的工艺一起删掉）
   * 所以它必须在**三处**都跑：服务端每次写存档之后、服务端每次下发状态之前
   *（系列扩编是改数据、不是改存档，只挂在写路径上会漏掉）、以及客户端本地记账之后。
   *
   * @returns {{changed:boolean, granted:Array, revoked:Array, owned:Object, foils:Object}}
   *          `granted`/`revoked` 里的每一项是 `{ card, progress }`，供界面报喜/说明。
   */
  function reconcileMemorials(data) {
    var player = data && data.player
    var quiet = { changed: false, granted: [], revoked: [], owned: {}, foils: {} }
    if (!player || typeof player !== 'object') return quiet

    var owned = {}
    var srcOwned = player.owned && typeof player.owned === 'object' ? player.owned : {}
    for (var k in srcOwned) if (Object.prototype.hasOwnProperty.call(srcOwned, k)) owned[k] = srcOwned[k]
    var foils = {}
    var srcFoils = player.foils && typeof player.foils === 'object' ? player.foils : {}
    for (var fk in srcFoils) if (Object.prototype.hasOwnProperty.call(srcFoils, fk)) foils[fk] = srcFoils[fk]

    var all = foilIds().slice()
    var granted = []
    var revoked = []
    var list = seriesMemorialCards(data)
    for (var i = 0; i < list.length; i++) {
      var card = list[i]
      var p = seriesProgress(data, card.memorialFor, owned)
      var has = Number(owned[card.id] || 0) > 0
      if (p.complete && !has) {
        owned[card.id] = 1
        // 「纪念卡的赠送同样会附赠所有特殊工艺」（用户 2026-09-20）
        if (all.length) foils[card.id] = all.slice()
        granted.push({ card: card, progress: p })
      } else if (!p.complete && has) {
        delete owned[card.id]
        delete foils[card.id]
        revoked.push({ card: card, progress: p })
      }
    }

    var changed = granted.length > 0 || revoked.length > 0
    if (changed) {
      player.owned = owned
      player.foils = foils
    }
    return { changed: changed, granted: granted, revoked: revoked, owned: owned, foils: foils }
  }

  var api = {
    DEFAULTS: DEFAULTS,
    TICKET_DEFAULTS: TICKET_DEFAULTS,
    DREAM_REWARD_DEFAULTS: DREAM_REWARD_DEFAULTS,
    RESET_DEFAULTS: RESET_DEFAULTS,
    FOIL_ID_FALLBACK: FOIL_ID_FALLBACK,
    foilIds: foilIds,
    rules: rules,
    upgradeCostFor: upgradeCostFor,
    dreamRewardRules: dreamRewardRules,
    dupRewardRules: dupRewardRules,
    hrShardKey: hrShardKey,
    resetGift: resetGift,
    resetPlayer: resetPlayer,
    memorialCards: memorialCards,
    resetMemorialCards: resetMemorialCards,
    seriesMemorialCards: seriesMemorialCards,
    seriesProgress: seriesProgress,
    memorialRequirement: memorialRequirement,
    reconcileMemorials: reconcileMemorials,
    ticketRules: ticketRules,
    ticketStatus: ticketStatus,
    canExchangeTickets: canExchangeTickets,
    exchangeTickets: exchangeTickets,
    sortedRarities: sortedRarities,
    nextRarity: nextRarity,
    prevRarity: prevRarity,
    cardCountOfRarity: cardCountOfRarity,
    findCard: findCard,
    status: status,
    canSynthesize: canSynthesize,
    canExchange: canExchange,
    exchange: exchange,
    settleDraw: settleDraw,
  }

  // ⚠️ 同时挂到全局与 CommonJS 导出，两个环境都要**明确**挂：
  //   · 浏览器以普通脚本加载 -> 需要 globalThis.GachaShards
  //   · Node 以 CJS 加载（服务端权威交换 / 测试）-> 需要 module.exports
  //
  // 曾经的写法是 `root.GachaShards = api` 然后靠文件末尾的 `this` 兜底。那在
  // Node 里是错的：CJS 模块作用域的 `this` 是 module.exports，于是 api 被挂到
  // module.exports 上、同时 module.exports 又被整个替换成 api —— 结果就是
  // 拿到的对象**一个方法都没有**（Object.keys 为空），而失败现象是
  // 「nextRarity is not a function」这种看起来像逻辑错的东西。
  root.GachaShards = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this)
