/**
 * 拟人化发送 · 让它打字不像机器
 * ─────────────────────────────────────────────────────────────
 * 一个真人发消息是这样的：
 *   1. 先"正在输入…"一会儿（时间跟字数成正比，但不完全成正比）
 *   2. 短句分几条发，不是一大段
 *   3. 条与条之间有停顿，偶尔停久一点（像在走神/被打断）
 *   4. 深夜和白天的节奏不一样
 *
 * 这个模块只做这件事。它不关心消息内容，只关心"怎么发出去"。
 */

/** 睡觉时段（本地时间），这段时间回复会明显变慢 */
const NIGHT = { from: 2, to: 7 };
/** 打字速度：每字毫秒。中文手打大概 80~140ms/字，这里给个偏快的值 */
const DEFAULT_MS_PER_CHAR = 85;

export class Humanizer {
  /**
   * @param {object} opts
   * @param {boolean} [opts.enabled=true]      总开关
   * @param {number}  [opts.msPerChar=85]      每字打字时间
   * @param {number}  [opts.minMs=1200]        最短"正在输入"时长
   * @param {number}  [opts.maxMs=6000]        最长"正在输入"时长
   * @param {number}  [opts.jitter=0.2]        抖动比例（±20%）
   * @param {number}  [opts.burstMax=4]        一次最多分几条发
   * @param {[number,number]} [opts.gapRange]  条间停顿范围（毫秒）
   * @param {number}  [opts.longGapChance=0.25] 出现"长停顿"的概率
   * @param {[number,number]} [opts.longGapRange] 长停顿范围
   */
  constructor(opts = {}) {
    this.enabled = opts.enabled !== false;
    this.msPerChar = opts.msPerChar ?? DEFAULT_MS_PER_CHAR;
    this.minMs = opts.minMs ?? 1200;
    this.maxMs = opts.maxMs ?? 6000;
    this.jitter = opts.jitter ?? 0.2;
    this.burstMax = opts.burstMax ?? 4;
    this.gapRange = opts.gapRange ?? [700, 2600];
    this.longGapChance = opts.longGapChance ?? 0.25;
    this.longGapRange = opts.longGapRange ?? [3000, 9000];
  }

  /** 按字数算"正在输入"该持续多久 */
  typingMsFor(text, profile = 'normal') {
    const n = [...String(text || '')].length;
    let msPerChar = this.msPerChar;
    let minMs = this.minMs;
    let maxMs = this.maxMs;

    if (profile === 'excited') {
      msPerChar = Math.round(msPerChar * 0.6);
      minMs = Math.round(minMs * 0.6);
      maxMs = Math.round(maxMs * 0.7);
    } else if (profile === 'sleepy') {
      msPerChar = Math.round(msPerChar * 1.5);
      minMs = Math.round(minMs * 1.4);
      maxMs = Math.round(maxMs * 1.3);
    }

    let ms = minMs + n * msPerChar;
    ms = Math.min(maxMs, Math.max(minMs, ms));
    // 抖动
    ms *= 1 + (Math.random() * 2 - 1) * this.jitter;
    // 深夜慢一点（半睡半醒）
    const h = new Date().getHours();
    if (h >= NIGHT.from && h < NIGHT.to && profile !== 'sleepy') ms *= 1.4;
    return Math.round(ms);
  }

  /** 条与条之间停多久 */
  gapMs(profile = 'normal') {
    let [a, b] = this.gapRange;
    let longChance = this.longGapChance;
    let [c, d] = this.longGapRange;

    if (profile === 'excited') {
      a = Math.round(a * 0.5);
      b = Math.round(b * 0.6);
      longChance = 0.05;
    } else if (profile === 'sleepy') {
      a = Math.round(a * 1.4);
      b = Math.round(b * 1.6);
      longChance = 0.35;
    }

    let ms = a + Math.random() * Math.max(0, b - a);
    if (Math.random() < longChance) {
      ms += c + Math.random() * Math.max(0, d - c);
    }
    return Math.round(ms);
  }

  /** 推断情绪节奏 Profile */
  inferProfile(text, hintMood = '') {
    const raw = String(text || '') + ' ' + String(hintMood || '');
    if (/(困|困倦|睡着|打哈欠|迷糊|半夜|慢吞吞|懒洋洋)/.test(raw)) return 'sleepy';
    if (/(！|!|抓包|好家伙|哇|快去|哼|气死|急|哈哈|开心|大魔王|胜负|较真)/.test(raw)) return 'excited';
    return 'normal';
  }

  /**
   * 把一段长回复切成"像人打出来的"若干条
   * - 已经在换行的地方切开
   * - 太长的一句按标点再切
   * - 切完不超过 burstMax 条（多余的合并回最后一条）
   */
  split(text, max = this.burstMax) {
    const raw = String(text || '').trim();
    if (!raw) return [];
    // 先按换行
    let parts = raw.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    // 再按中文标点切过长的
    const out = [];
    for (const p of parts) {
      if ([...p].length <= 40) { out.push(p); continue; }
      const segs = p.split(/(?<=[。！？!?…~])\s*/).map((s) => s.trim()).filter(Boolean);
      out.push(...(segs.length ? segs : [p]));
    }
    // 合并太短的相邻项
    // 注意：纯标点（例如被 ~ 切开后剩下的 ” " ）必须并回前一条，
    // 否则会单独成一条消息发出去（2026-10-21 实际发生过：鲸鲸发了一条只有 ” 的消息）
    const merged = [];
    for (const s of out) {
      const last = merged[merged.length - 1];
      const punctOnly = /^[\p{P}\p{S}\s]+$/u.test(s);
      if (last && punctOnly) {
        merged[merged.length - 1] = last + s;
        continue;
      }
      if (last && [...last].length < 6 && [...last].length + [...s].length <= 24) merged[merged.length - 1] = last + s;
      else merged.push(s);
    }
    // 超量就合并
    if (merged.length > max) {
      const head = merged.slice(0, max - 1);
      head.push(merged.slice(max - 1).join(' '));
      return head;
    }
    return merged;
  }

  /**
   * 执行一次拟人化发送
   *
   * @param {string|string[]} text        要说的话（字符串会被自动切分）
   * @param {object} io
   * @param {(on:boolean)=>Promise<void>} [io.setTyping]  切换"正在输入"状态
   * @param {(msg:string)=>Promise<any>}  io.send          真正发一条
   * @param {(ms:number)=>Promise<void>}  [io.sleep]       等待（默认 setTimeout，测试时可注入）
   * @returns {Promise<{sent:number, parts:string[]}>}
   */
  async say(text, { setTyping, send, sleep, max, mood, skipFirst = false } = {}) {
    const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    // max 不传 → split 的默认参数生效，用全局 burstMax
    const parts = Array.isArray(text) ? text.map((s) => String(s)) : this.split(text, max);
    if (!parts.length) return { sent: 0, parts: [] };

    if (!this.enabled) {
      const toSend = skipFirst ? parts.slice(1) : parts;
      for (const p of toSend) await send(p);
      return { sent: toSend.length, parts };
    }

    const fullText = parts.join(' ');
    const profile = this.inferProfile(fullText, mood);

    let sent = 0;
    const startIndex = skipFirst ? 1 : 0;
    for (let i = startIndex; i < parts.length; i++) {
      const p = parts[i];
      // 1) 先"正在输入"（非首句需要打字模拟；如果 skipFirst=true，说明第0句已经被流式秒发了，第1句也要打字模拟）
      if (i > 0) {
        if (setTyping) { try { await setTyping(true); } catch { /* 有些平台不支持，忽略 */ } }
        await wait(this.typingMsFor(p, profile));
        if (setTyping) { try { await setTyping(false); } catch {} }
      }
      // 2) 发出去
      await send(p);
      sent++;
      // 3) 条间停顿
      if (i < parts.length - 1) await wait(this.gapMs(profile));
    }
    return { sent, parts };
  }
}

export default Humanizer;
