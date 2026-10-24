import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { writeDailyDiary } from './diary.js';
/**
 * 主动性 · 她自己会想找你
 * ───────────────────────────────────────────────────────────
 * 不是随机数掷骰子，是"有由头的开口"：
 *   1. 约定兑现  —— 她说过"等我看完告诉你"，时间到了就该提
 *   2. 想念      —— 隔了很久没聊（默认 2 小时以上）
 *   3. 时辰      —— 深夜提醒睡、早上打招呼
 *
 * 克制原则：
 *   · 一天最多 maxPerDay 次（默认 3）
 *   · 刚聊过不打扰（minGapMinutes 内冷处理）
 *   · 模型可以选择"不说"（返回 SKIP），宁可不发也不硬凑
 *   · 深夜（1:00-8:00）完全不打扰
 */

const HOUR = 60 * 60 * 1000;

function clockOf(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export class Proactive {
  constructor(opts = {}) {
    this.bot = opts.bot;
    this.brain = opts.brain;
    this.memory = opts.memory;
    this.diary = opts.diary;
    this.cfg = opts.cfg || {};
    this.ownerKey = opts.ownerKey || '';
    this.ownerId = opts.ownerId || '';

    this.enabled = opts.enabled !== false;
    this.checkIntervalMs = opts.checkIntervalMs ?? 20 * 60 * 1000; // 20 分钟看一次
    this.minGapMinutes = opts.minGapMinutes ?? 120;               // 至少隔 2 小时没聊
    this.maxPerDay = opts.maxPerDay ?? 3;
    // 免打扰区间（"HH:MM" 字符串数组）。from === to 表示该条不生效。
    this.quietRanges = Array.isArray(opts.quietRanges) && opts.quietRanges.length
      ? opts.quietRanges.map(r => ({ from: String(r.from ?? '00:00'), to: String(r.to ?? '00:00') }))
      : [{ from: '01:00', to: '08:00' }];
    this.nightFrom = opts.nightFrom ?? 23;                         // 23:00 后可催睡

    this.sentToday = 0;
    this.sentDate = '';
    this.lastSentAt = 0;
    this.timer = null;
    this.diaryFromHour = opts.diaryFromHour ?? 22;   // 22 点起开放写日记（睡前总结当天）

    // ── Proactive v2: 持久化状态与未回复温柔追问 (Follow-up) ──
    this.stateFile = opts.stateFile || (this.cfg.dataDir ? `${this.cfg.dataDir}/proactive_state.json` : '');
    this.waitingReply = false;  // 上次主动后，主人是否还没回复
    this.followUpSent = false;  // 对本次未回复，是否已经追问过一次（最多补一次）
    this.#loadState();
  }

  #loadState() {
    if (!this.stateFile) return;
    try {
      if (fs.existsSync(this.stateFile)) {
        const d = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        this.sentToday = d.sentToday || 0;
        this.sentDate = d.sentDate || '';
        this.lastSentAt = d.lastSentAt || 0;
        this.waitingReply = Boolean(d.waitingReply);
        this.followUpSent = Boolean(d.followUpSent);
      }
    } catch {}
  }

  #saveState() {
    if (!this.stateFile) return;
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify({
        sentToday: this.sentToday,
        sentDate: this.sentDate,
        lastSentAt: this.lastSentAt,
        waitingReply: this.waitingReply,
        followUpSent: this.followUpSent,
      }, null, 2), 'utf8');
    } catch {}
  }

  #log(msg) { console.log('[主动] ' + msg); }

  #resetDailyIfNeeded() {
    const today = new Date().toDateString();
    if (this.sentDate !== today) {
      this.sentDate = today;
      this.sentToday = 0;
    }
  }

  /** 上次聊天距今多少分钟 */
  #minutesSinceLastChat() {
    let last = 0;
    try {
      const p = this.memory?.person?.(this.ownerId);
      last = Number(p?.lastSeenAt) || 0;
    } catch {}
    if (!last) return 99999;
    return Math.floor((Date.now() - last) / 60000);
  }

  /** 判断现在该不该考虑开口（不含模型判断） */
  #gate() {
    this.#resetDailyIfNeeded();

    const now = new Date();
    const h = now.getHours();

    if (!this.enabled) return { ok: false, why: '未启用' };
    if (!this.ownerKey) return { ok: false, why: '没有主人会话' };
    if (this.sentToday >= this.maxPerDay) return { ok: false, why: `今天已主动 ${this.sentToday} 次，够了` };

    // 免打扰区间判断（支持多段，from === to 的那条忽略）
    const nowMin = h * 60 + now.getMinutes();
    const toMin = (s) => {
      const [a, b] = String(s).split(':').map(Number);
      return (a || 0) * 60 + (b || 0);
    };
    for (const r of this.quietRanges) {
      const f = toMin(r.from), t = toMin(r.to);
      if (f === t) continue;
      const hit = f < t ? (nowMin >= f && nowMin < t) : (nowMin >= f || nowMin < t);
      if (hit) return { ok: false, why: `免打扰时段（${r.from}-${r.to}）` };
    }

    // 刚聊过 / 刚主动过
    const gap = this.#minutesSinceLastChat();
    const sinceSent = this.lastSentAt ? Math.floor((Date.now() - this.lastSentAt) / 60000) : 99999;

    // 无论是否回话，只要距上次聊天不足 minGapMinutes，坚决不打扰
    if (gap < this.minGapMinutes) {
      return { ok: false, why: `才聊过 ${gap} 分钟（要求至少 ${this.minGapMinutes} 分钟），不打扰` };
    }

    // 距上次主动发消息也不足 minGapMinutes，同样不打扰
    if (sinceSent < this.minGapMinutes) {
      return { ok: false, why: `距上次主动才 ${sinceSent} 分钟，不重复发起` };
    }

    // 彻底停用绕过阈值的追问逻辑，主动发起的每一句都必须满足冷静间隔
    const isFollowUp = false;
    this.waitingReply = false;
    this.followUpSent = false;

    return { ok: true, gap, hour: h, sinceSent, isFollowUp };
  }

  /** 让模型决定说什么（或不说） */
  async #compose({ gap, hour, isFollowUp }) {
    const hh = clockOf();
    const dayPart = hour < 5 ? '凌晨' : hour < 9 ? '清晨' : hour < 12 ? '上午'
      : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 23 ? '晚上' : '深夜';

    // 日记窗口：22:00 起（到 00:00 前），睡前能总结当天；00:00 后 hour=0 不在窗口
    const inDiaryWindow = hour >= (this.diaryFromHour ?? 22);
    let wroteToday = false;
    try {
      const d = new Date();
      const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      wroteToday = (this.diary?.day?.(today)?.length || 0) > 0;
    } catch {}

    let taskLine = '【任务】决定要不要主动开口，以及开口说什么。';
    if (isFollowUp) {
      taskLine = '【任务：温柔补话】你大概半小时前主动发了消息，但他好像在忙没看到。现在请温柔地补一小句（比如问他是不是在忙、提醒他先安心忙别累着），绝对不要生硬开启全新话题，也不要轰炸。';
    } else if (inDiaryWindow && !wroteToday) {
      taskLine = '【任务】现在是睡前，该收收今天。决定要做什么：写今天的日记、跟他说句话、或者什么都不做。';
    } else if (inDiaryWindow && wroteToday) {
      taskLine = '【任务】决定要不要主动开口，以及开口说什么。（今天的日记已经写过了，不用再写。）';
    }
    const diaryRule = (inDiaryWindow && !wroteToday && !isFollowUp)
      ? '0. 想写日记的话：先输出「日记：」再加正文（只写给自己看，不用跟他打招呼，像给自己记的）。一天只写这一篇。\n   · 如果今天观察到了主人的新习惯或偏好，正文末尾另起一行写「记忆：习惯1；习惯2」（分号分隔，没观察到就不写这行）。'
      : '';

    const gapText = gap > 1440 ? `${Math.floor(gap / 1440)} 天`
      : gap > 60 ? `${Math.floor(gap / 60)} 小时 ${gap % 60} 分钟`
      : `${gap} 分钟`;

    let mem = '';
    let pend = '';
    let recent = '';
    let diary = '';
    try {
      const p = this.memory.person(this.ownerId);
      mem = [
        p?.traits?.length ? '你了解他：' + p.traits.slice(-8).join('；') : '',
        p?.facts?.length ? '他告诉过你：' + p.facts.slice(-8).join('；') : '',
      ].filter(Boolean).join('\n');
      pend = p?.pending?.length ? p.pending.slice(-4).join('；') : '';
      recent = this.memory.renderRecent(6) || '';
    } catch {}
    try { diary = this.diary?.context(2, 2) || ''; } catch {}

    const ymd =
      now.getFullYear() + '-' +
      String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0');
    const dayOfWeek = now.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const isFridayNight = dayOfWeek === 5 && now.getHours() >= 18;
    const isSundayNight = dayOfWeek === 0 && now.getHours() >= 20;

    let rhythmDesc = '';
    if (isFridayNight) rhythmDesc = '【周五夜晚/周末前夕】：一周刚结束，心情相对轻松，可以聊点有趣的闲话。';
    else if (isSundayNight) rhythmDesc = '【周日深夜】：明天开始新一周工作，提醒早点休息。';
    else if (isWeekend) rhythmDesc = '【周末休息日】：不用早起搬砖通勤，语气惬意自然。';
    else rhythmDesc = '【日常工作日】：白天适度关心，深夜若很晚了一定要体贴催睡。';

    const sys = [
      isFollowUp ? '你在一个 QQ 私聊里。你大概半小时前找了他，他好像在忙还没回。' : '你在一个 QQ 私聊里。没有人正在跟你说话 —— 是**你自己**忽然想找他。',
      '',
      '【现在】' + dayPart + ' ' + hh + '，今天是 ' + ymd + ' 周' + '日一二三四五六'[dayOfWeek] + '。距上次聊天已经 ' + gapText + '。',
      rhythmDesc ? '【生活作息节奏】' + rhythmDesc : '',
      mem ? '\n' + mem : '',
      pend ? '\n【你心里还记着没说出口的事】\n' + pend : '',
      diary ? '\n' + diary : '',
      recent ? '\n【你们最后聊的几句】\n' + recent : '',
      '',
      taskLine,
      '规则：',
      diaryRule,
      '1. 如果觉得现在开口很唐突、或他在忙不该打扰 → 输出以 SKIP 开头（如 SKIP:BUSY / SKIP:NO_TOPIC / 纯 SKIP），不输出别的。',
      '2. 如果有话说 → 默认只发 1 句话（随性、口语，像手机随手发的）。重点顺着【你们最后聊的几句】关心他的状态（例如他提到累、去忙、身体不舒服等），绝不要一口气发很多话。',
      '3. 不要提"距上次聊天多久""好久没聊"这种报时间的话，像真人一样自然切入。',
      '4. 不要每句都用"在吗""干嘛呢"开头 —— 可以是分享一件小事、问他吃饭没、念叨他熬夜、提一个还没说完的话题。',
      '5. **绝对不要**用括号写动作或心理。只说人话。',
      '6. 深夜（现在 ' + dayPart + '）就顺着这个时段说（催睡、问他怎么还不睡），别在凌晨说"早安"。',
    ].filter(Boolean).join('\n');

    const out = await this.brain.reply({
      key: this.ownerKey,
      userId: this.ownerId,
      userName: this.memory?.person?.(this.ownerId)?.name || 'fans',
      text: '（这是你主动发起的对话，不是回应他的消息）',
      situation: '你在跟 ' + (this.memory?.person?.(this.ownerId)?.name || '主人') + ' 私聊。现在是' + dayPart + '（' + hh + '）。',
      record: false,
    });

    return String(out.text || '').trim();
  }

  async tick(manual = false) {
    const gate = this.#gate();
    if (!gate.ok) {
      if (manual) this.#log('不开口：' + gate.why);
      return null;
    }

    this.#log(`条件满足（距上次聊天 ${gate.gap} 分钟），问她想不想说话……`);
    let line = '';
    // 轻量容错重试：遇到网络抖动 (fetch failed / timeout)，间隔 8 秒重试一次
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        line = await this.#compose(gate);
        break;
      } catch (e) {
        this.#log(`生成第 ${attempt} 次失败：${e?.message || e}`);
        if (attempt < 2) {
          this.#log('等待 8 秒后重试一次...');
          await new Promise((r) => setTimeout(r, 8000));
        } else {
          return null;
        }
      }
    }

    const clean = line.replace(/^["'「『]|["'」』]$/g, '').trim();
    if (!clean || /^SKIP/i.test(clean) || clean.length < 2) {
      const reason = clean.startsWith('SKIP:') ? clean.slice(5).trim() : '';
      this.#log('她决定不说（' + (reason || 'SKIP') + '）');
      if (gate.isFollowUp) {
        this.followUpSent = true;
        this.#saveState();
      }
      return null;
    }

    // 写日记分支：以「日记：」开头 → 写文件，不发给主人，也不占主动消息次数
    const diaryMatch = clean.match(/^日记[：:]\s*([\s\S]+)$/);
    if (diaryMatch) {
      const dt = diaryMatch[1].trim();
      if (dt) {
        // 分离正文与「记忆：」行（她观察到主人的新习惯/偏好时才会写这行）
        const lines = dt.split(/\n+/);
        const bodyLines = [];
        let traits = [];
        for (const ln of lines) {
          const m = ln.match(/^记忆[：:]\s*(.+)$/);
          if (m) {
            traits = m[1].split(/[；;]/).map((x) => x.trim()).filter(Boolean).slice(0, 5);
          } else {
            bodyLines.push(ln);
          }
        }
        const body = bodyLines.join('\n').trim();
        try {
          if (body) {
            this.diary?.add({ text: body });
            this.#log('她写了日记：' + body.slice(0, 40) + '…');

            // 异步触发私密记忆归档到 GitHub（不阻塞主流程）
            try {
              this.#log('[自动同步] 触发私密记忆归档...');
              const syncScript = path.resolve(new URL('.', import.meta.url).pathname, 'sync-memory.mjs');
              const child = fork(syncScript, [], { detached: true, stdio: 'ignore' });
              child.unref();
            } catch (err) {
              this.#log('[自动同步] 启动归档子进程失败: ' + (err?.message || err));
            }
          }
          if (traits.length) {
            const r = this.memory?.absorb?.(this.ownerId, { traits });
            this.#log('沉淀记忆 ' + (r?.added || 0) + ' 条：' + traits.join('；').slice(0, 60));
          }
        } catch (e) {
          this.#log('日记写入失败：' + (e?.message || e));
        }
      }
      return null;
    }

    // 分条发
    const parts = clean.split(/\n+/).map(s => s.trim()).filter(Boolean).slice(0, 2);
    for (const p of parts) {
      await this.bot.send(this.ownerKey, p);
      await new Promise(r => setTimeout(r, 500 + Math.random() * 800));
    }

    // 写入历史对话记录，确保被动回复时拥有主动打招呼的上下文，杜绝重复早安
    try {
      if (this.memory?.logTurn) {
        this.memory.logTurn({
          where: this.ownerKey,
          who: '鲸鲸',
          text: '（主动问候）',
          reply: parts.join(' ｜ '),
        });
      }
    } catch (e) {
      this.#log('主动消息记入历史失败：' + (e?.message || e));
    }

    this.sentToday++;
    this.lastSentAt = Date.now();
    if (gate.isFollowUp) {
      this.followUpSent = true;
      this.#log(`[追问] 补话已发出 ${parts.length} 条：${parts.join(' ｜ ').slice(0, 60)}`);
    } else {
      this.waitingReply = true;
      this.followUpSent = false;
      this.#log(`已发出 ${parts.length} 条：${parts.join(' ｜ ').slice(0, 60)}`);
    }
    this.#saveState();
    return parts;
  }

  /**
   * 兜底检查：如果在深夜或空闲时段，且今天还没写过日记，则自己沉淀一篇日记
   */
  async checkDailyDiaryFallback() {
    if (!this.diary) return;
    try {
      const now = new Date();
      const h = now.getHours();
      // 在晚上 23:00 之后，或者清晨 0:00 - 8:00
      const isNightOrLate = h >= 23 || h < 8;
      if (!isNightOrLate) return;

      // 判断今天是否已经有日记了
      const p = (n) => String(n).padStart(2, '0');
      const todayStr = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
      const todayEntries = this.diary.day(todayStr);
      if (todayEntries && todayEntries.length > 0) return; // 今天已经写过了

      this.#log(`[自动日记兜底] 检测到今天（${todayStr}）尚未生成日记，触发自动沉淀...`);
      const saved = await writeDailyDiary({
        cfg: this.cfg,
        diaryInstance: this.diary,
        memoryInstance: this.memory,
      });
      this.#log(`[自动日记兜底] 成功生成日记：${saved.day}「${saved.title || '无题'}」- ${saved.text.slice(0, 30)}…`);

      // 触发私密记忆归档到 GitHub
      try {
        const syncScript = path.resolve(new URL('.', import.meta.url).pathname, 'sync-memory.mjs');
        const child = fork(syncScript, [], { detached: true, stdio: 'ignore' });
        child.unref();
      } catch {}
    } catch (e) {
      this.#log(`[自动日记兜底] 执行异常: ${e?.message || e}`);
    }
  }

  start() {
    if (!this.enabled) { this.#log('未启用'); return; }
    if (this.timer) return;
    this.#log(`启动，每 ${Math.round(this.checkIntervalMs / 60000)} 分钟检查一次（一天最多 ${this.maxPerDay} 次）`);
    // 首次延迟 5 分钟（避免刚启动就打扰）
    setTimeout(() => {
      this.tick().catch(() => {});
      this.checkDailyDiaryFallback().catch(() => {});
    }, 5 * 60 * 1000);
    this.timer = setInterval(() => {
      this.tick().catch(() => {});
      this.checkDailyDiaryFallback().catch(() => {});
    }, this.checkIntervalMs);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}

export default Proactive;
