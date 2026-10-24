/**
 * 发送闸门 · 熔断 + 限流 + typing 抑制
 * ─────────────────────────────────────────────────────────────
 * 教程第十三章的三条保命规则，全部收在这里：
 *
 *   ① 熔断：连续 3 次发送失败 → 停 180 秒，期间一条都不碰服务器
 *   ② 限流：每分钟最多 6 条、每小时最多 80 条
 *   ③ typing 抑制：短消息不发、最小间隔 45 秒、35% 概率
 *
 * 这一层从外面包住 OneBot，不修改原作者的任何逻辑。
 * 设计原则：宁可少说话，也不要制造"重试风暴"。
 */

export class SendGuard {
  constructor(opts = {}) {
    this.failThreshold = opts.failThreshold ?? 3;
    this.breakerMs = opts.breakerMs ?? 180000;
    this.maxPerMinute = opts.maxPerMinute ?? 6;
    this.maxPerHour = opts.maxPerHour ?? 80;
    this.typingMinChars = opts.typingMinChars ?? 20;
    this.typingMinIntervalMs = opts.typingMinIntervalMs ?? 45000;
    this.typingProbability = opts.typingProbability ?? 0.35;

    this.consecutiveFails = 0;
    this.openUntil = 0;
    this.sentMinute = [];
    this.sentHour = [];
    this.lastTypingAt = 0;
    this.lastTextLen = 0;
    this.stats = {
      sent: 0, blocked: 0, typingSent: 0, typingSkipped: 0, breakerTrips: 0,
    };
  }

  #prune(now) {
    this.sentMinute = this.sentMinute.filter((t) => now - t < 60000);
    this.sentHour = this.sentHour.filter((t) => now - t < 3600000);
  }

  canSend() {
    const now = Date.now();
    if (now < this.openUntil) {
      return { ok: false, reason: `熔断中，还有 ${Math.ceil((this.openUntil - now) / 1000)}s` };
    }
    this.#prune(now);
    if (this.sentMinute.length >= this.maxPerMinute) {
      return { ok: false, reason: `每分钟上限 ${this.maxPerMinute} 条` };
    }
    if (this.sentHour.length >= this.maxPerHour) {
      return { ok: false, reason: `每小时上限 ${this.maxPerHour} 条` };
    }
    return { ok: true };
  }

  recordSend() {
    const now = Date.now();
    this.sentMinute.push(now);
    this.sentHour.push(now);
    this.stats.sent++;
  }

  recordOk() {
    this.consecutiveFails = 0;
  }

  recordFail() {
    this.consecutiveFails++;
    if (this.consecutiveFails >= this.failThreshold) {
      this.openUntil = Date.now() + this.breakerMs;
      this.stats.breakerTrips++;
      this.consecutiveFails = 0;
      console.log(
        `[熔断] 连续失败 ${this.failThreshold} 次 → 停 ${this.breakerMs / 1000}s，期间不重试`
      );
    }
  }

  shouldType() {
    const now = Date.now();
    if (this.lastTextLen > 0 && this.lastTextLen < this.typingMinChars) {
      this.stats.typingSkipped++;
      return false;
    }
    if (now - this.lastTypingAt < this.typingMinIntervalMs) {
      this.stats.typingSkipped++;
      return false;
    }
    if (Math.random() > this.typingProbability) {
      this.stats.typingSkipped++;
      return false;
    }
    this.lastTypingAt = now;
    this.stats.typingSent++;
    return true;
  }

  noteText(text) {
    this.lastTextLen = [...String(text || '')].length;
  }

  status() {
    return {
      breakerOpen: Date.now() < this.openUntil,
      openUntil: this.openUntil,
      consecutiveFails: this.consecutiveFails,
      lastMinute: this.sentMinute.length,
      lastHour: this.sentHour.length,
      ...this.stats,
    };
  }
}

/** 用闸门包住 OneBot：只拦 send / setTyping，其余原样透传 */
export function wrapBot(bot, guard, log = console.log) {
  const wrapped = Object.create(bot);

  wrapped.send = async (key, msg, opts) => {
    const gate = guard.canSend();
    if (!gate.ok) {
      guard.stats.blocked++;
      log(`[挡住] ${gate.reason} —— 本轮不发`);
      return { ok: false, skipped: true, reason: gate.reason };
    }
    guard.noteText(msg);
    try {
      const r = await bot.send(key, msg, opts);
      guard.recordSend();
      guard.recordOk();
      return r;
    } catch (e) {
      guard.recordFail();
      throw e;
    }
  };

  wrapped.setTyping = async (key, on) => {
    if (on && !guard.shouldType()) return { ok: true, skipped: true };
    try {
      return await bot.setTyping(key, on);
    } catch {
      return { ok: false };
    }
  };

  return wrapped;
}
