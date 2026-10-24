/**
 * 唤醒判定 · 什么时候该说话，什么时候该安静
 * ─────────────────────────────────────────────────────────────
 * 一个不会看场合的机器人，比不会说话的更烦人。
 *
 * 这里把"要不要醒"拆成几个独立条件，任何一个命中就醒：
 *
 *   atMention    被 @ / 被引用
 *   nameMention  被叫到名字或昵称
 *   keywords     出现了约定好的关键词
 *   question     有人直接提问
 *   poke         被拍一拍
 *   speakerIds   指定的某几个人发言
 *   probability  普通消息按概率随机（让它偶尔插话，但别刷屏）
 *   anyMessage   任何消息都醒（"活跃模式"）
 *
 * 另外还有一个「无限期潜水」概念：醒过一次之后，接下来一段时间
 * 除非再次命中条件，否则都当没看见。这就是群聊里"潜水"的实现。
 */

/** 中文里"在问问题"的粗略特征 */
const QUESTION_HINTS = /[?？]|怎么|为什么|为啥|如何|是不是|能不能|可不可以|有没有|谁|哪儿|哪里|何时|多少/;

export class Waker {
  /**
   * @param {object} opts
   * @param {string[]} [opts.names]        她的名字/昵称列表
   * @param {string[]} [opts.keywords]     关键词
   * @param {string[]} [opts.ownerIds]     主人（说话必醒）
   * @param {number}  [opts.probability]   普通消息随机唤醒概率
   * @param {number}  [opts.batchWindowMs] 多条消息合并窗口
   */
  constructor(opts = {}) {
    this.names = (opts.names || []).filter(Boolean);
    this.keywords = (opts.keywords || []).filter(Boolean);
    this.ownerIds = (opts.ownerIds || []).map(String);
    /** 允许她说话的群（空 = 所有群静音） */
    this.groupWhitelist = (opts.groupWhitelist || []).map(String);
    this.probability = opts.probability ?? 0.05;
    this.ownerGroupProbability = opts.ownerGroupProbability ?? 0.75;
    this.batchWindowMs = opts.batchWindowMs ?? 3000;
    /** @type {Map<string, object>} 每个会话的唤醒配置 */
    this.configs = new Map();
    /** @type {Map<string, object>} 待合并的消息缓冲 */
    this.buffers = new Map();
    /** @type {Map<string, number>} 会话 → 上下文窗口截止时间（提到她名字后一段时间内，该会话消息也进判断） */
    this.contextUntil = new Map();
  }

  /** 给某个会话设置唤醒配置 */
  setConfig(key, cfg) {
    this.configs.set(key, {
      mode: 'diving',          // 'diving' 潜水 | 'active' 活跃
      infinite: true,          // 无限期，直到再次命中条件
      until: 0,                // 有限潜水时的截止时间
      atMention: true,
      nameMention: true,
      keywords: [],
      question: true,
      poke: true,
      speakerIds: [],
      probability: this.probability,
      ownerGroupProbability: this.ownerGroupProbability,
      anyMessage: false,
      contextWindowMs: 0,      // >0 时：提到她名字后，该会话接下来这段时间的消息也进判断
      ...cfg,
    });
  }

  getConfig(key) {
    if (!this.configs.has(key)) this.setConfig(key, {});
    return this.configs.get(key);
  }

  /** 现在是不是在潜水（潜水中 = 不该主动说话） */
  isDiving(key) {
    const c = this.getConfig(key);
    if (c.mode === 'active') return false;
    if (c.infinite) return true;
    return Date.now() < c.until;
  }

  /** 把它从潜水里叫起来 */
  wake(key) {
    const c = this.getConfig(key);
    c.lastWakeAt = Date.now();
    c.wakeCount = (c.wakeCount || 0) + 1;
  }

  /** 让它继续潜水（可以指定潜多久） */
  dive(key, ms = 0) {
    const c = this.getConfig(key);
    c.infinite = !ms;
    c.until = ms ? Date.now() + ms : 0;
  }

  /**
   * 判定一条消息要不要唤醒
   *
   * @param {object} msg
   * @param {string} msg.key          会话标识，如 'group:123' / 'private:456'
   * @param {string} msg.userId       发送者
   * @param {string} [msg.name]       发送者昵称
   * @param {string} msg.text         正文
   * @param {boolean} [msg.isAtMe]    是否 @ 了我
   * @param {boolean} [msg.isPoke]    是否拍一拍
   * @param {boolean} [msg.isQuoteMe] 是否引用了我
   * @returns {{wake:boolean, reason:string}}
   */
  shouldWake(msg) {
    const c = this.getConfig(msg.key);
    const text = String(msg.text || '');
    const uid = String(msg.userId || '');

    // ── 安全闸（本地补丁）──
    // 0) 群聊一律不醒：否则群里有人 @ 或拍一拍就会调模型、往群里发消息
    //    用户要求：不在任何群里说话，也不消耗 token。
    if (String(msg.key || "").startsWith("group:")) {
      const gid = String(msg.key).split(":")[1];
      // 只有白名单里的群才允许开口；其余群完全静音，不消耗 token
      if (!this.groupWhitelist.includes(gid)) {
        return { wake: false, reason: "group-not-whitelisted" };
      }
      // 白名单群：往下走正常判断（被 @ / 主人说话 / 关键词 / 低概率插话）
    }

    // 私聊场景下只有 owner 能唤醒她。660 个好友里任何人发"在吗？"
    // 都不会触发，也不会有任何发送动作。
    if (String(msg.key || '').startsWith('private:') && !this.ownerIds.includes(uid)) {
      return { wake: false, reason: 'private-not-owner' };
    }

    // 私聊里主人说话一定醒；群里按主人专属高概率（如 75%）唤醒，让主人即使不 @ 也大概率得到回应
    const inGroup = String(msg.key || '').startsWith('group:');
    const isOwner = this.ownerIds.includes(uid);
    if (isOwner && !inGroup && c.mode !== 'active') return { wake: true, reason: 'owner' };
    if (isOwner && inGroup) {
      const ownerProb = Number(c.ownerGroupProbability ?? 0.75);
      if (Math.random() < ownerProb) {
        if (Number(c.contextWindowMs) > 0) {
          this.contextUntil.set(msg.key, Date.now() + Number(c.contextWindowMs));
        }
        return { wake: true, reason: 'owner-group-prob' };
      }
    }
    if (Array.isArray(c.speakerIds) && c.speakerIds.map(String).includes(uid)) {
      return { wake: true, reason: 'speaker' };
    }

    if (c.anyMessage) return { wake: true, reason: 'anyMessage' };
    if (c.mode === 'active') return { wake: true, reason: 'active' };

    if (c.atMention && (msg.isAtMe || msg.isQuoteMe)) return { wake: true, reason: 'atMention' };

    if (c.poke && msg.isPoke) return { wake: true, reason: 'poke' };

    if (c.nameMention) {
      const hit = this.names.find((n) => text.includes(n));
      if (hit) {
        // 被叫到名字 → 开一个上下文窗口：接下来一段时间这个会话的消息也进模型判断，
        // 这样"有人聊到她，后面接着说的话"她也能跟上，而不是死等再次 @。
        if (Number(c.contextWindowMs) > 0) {
          this.contextUntil.set(msg.key, Date.now() + Number(c.contextWindowMs));
        }
        return { wake: true, reason: 'name:' + hit };
      }
    }

    const kw = [...(c.keywords || []), ...this.keywords];
    if (kw.length) {
      const hit = kw.find((k) => k && text.includes(k));
      if (hit) return { wake: true, reason: 'keyword:' + hit };
    }

    if (c.question && QUESTION_HINTS.test(text) && [...text].length >= 4) {
      return { wake: true, reason: 'question' };
    }

    // 上下文窗口内（刚有人提到她）→ 也进模型判断，由模型决定要不要接
    if (Number(c.contextWindowMs) > 0) {
      const until = this.contextUntil.get(msg.key) || 0;
      if (Date.now() < until) return { wake: true, reason: 'context' };
    }

    if (Number(c.probability) > 0 && Math.random() < Number(c.probability)) {
      return { wake: true, reason: 'probability' };
    }

    return { wake: false, reason: '' };
  }

  /**
   * 多条消息合并 —— 真人在群里说话是一串一串的，
   * 等一小会儿把连着的几条凑一起再回，比一条条追着回自然得多。
   *
   * @returns {{ready:boolean, batch:object[]}}
   */
  batch(msg) {
    const key = msg.key;
    let b = this.buffers.get(key);
    if (!b) { b = { items: [], timer: null }; this.buffers.set(key, b); }
    b.items.push(msg);
    // 攒够 6 条只**告诉调用方该立刻处理**，绝不在这里自己出队：
    // 以前这里直接 #flush() 并把结果返回，而 index.js 丢弃返回值，
    // 于是「一口气发 6 条」时这 6 条被静默丢掉，她一个字都不回（2026-10-22 修）。
    return { ready: b.items.length >= 6, count: b.items.length, batch: [] };
  }

  #flush(key) {
    const b = this.buffers.get(key);
    if (!b) return [];
    const items = b.items;
    b.items = [];
    return items;
  }

  /** 合并窗口到了，把攒的都取出来 */
  flush(key) { return this.#flush(key); }

  /** 把一批消息拼成一段给模型的输入 */
  static joinBatch(items) {
    return items.map((m) => {
      const who = m.name || m.userId || '某人';
      return who + '：' + String(m.text || '').trim();
    }).join('\n');
  }
}

export default Waker;
