/**
 * 记忆账本 · Living Memory 动态生命记忆升级版
 * ─────────────────────────────────────────────────────────────
 * 兼容经典按人账本，引入仿生遗忘曲线与记忆生命周期管理：
 *   - 记忆条目带权重 (weight) 与提及次数 (hits) 与上次激活时间 (lastHit)
 *   - 艾宾浩斯时间衰减：未经强化的琐碎记忆自然降权淡化
 *   - 强化机制：被多次提及、被日记提纯的记忆增加权重与留存周期
 *   - 动态打分与择优注入：注入 Prompt 时根据 [权重 × 新鲜度] 排序，优先喂最相关的活记忆
 *   - 向下完全兼容老版纯字符串数组
 */
import fs from 'node:fs';
import path from 'node:path';

// 分类型半衰期。仅影响排序与清扫，不改变对外暴露的字符串数组。
const HALF_LIFE_DAYS = { traits: 45, facts: 90, pending: 14 };
const DAY_MS = 24 * 60 * 60 * 1000;
const LIFE_KINDS = ['traits', 'facts', 'pending'];

// ── 核心心锚 (Core Memories / 共同闪光回忆) ──
const CORE_MEMORY_MAX = 30;
const CORE_MEMORY_INJECT_MAX = 4;

function defaultLife(now = Date.now()) {
  return { weight: 1, hits: 1, createdAt: now, lastHit: now, pinned: false };
}

function normalizeLife(raw, fallbackTime = Date.now()) {
  if (!raw || typeof raw !== 'object') return defaultLife(fallbackTime);
  const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    weight: num(raw.weight, 1),
    hits: num(raw.hits, 1),
    createdAt: num(raw.createdAt, fallbackTime),
    lastHit: num(raw.lastHit, fallbackTime),
    pinned: Boolean(raw.pinned),
  };
}

function scoreLife(entry, kind, now = Date.now()) {
  if (entry.pinned) return Number.POSITIVE_INFINITY;
  const ageMs = Math.max(0, now - entry.lastHit);
  const halfLifeMs = (HALF_LIFE_DAYS[kind] || HALF_LIFE_DAYS.facts) * DAY_MS;
  const decay = Math.pow(0.5, ageMs / halfLifeMs);
  const retention = Math.min(2.2, 1 + 0.25 * Math.log10(entry.hits));
  return entry.weight * decay * retention;
}

function migratePerson(p) {
  let changed = false;
  if (!p.life || typeof p.life !== 'object' || Array.isArray(p.life)) {
    p.life = {};
    changed = true;
  }
  const fallbackTime = Number(p.lastSeenAt) || Number(p.firstSeenAt) || Date.now();

  for (const kind of LIFE_KINDS) {
    const bucket = p.life[kind];
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) {
      p.life[kind] = {};
      changed = true;
    }
    const before = Array.isArray(p[kind]) ? p[kind] : [];
    const seen = new Set();
    const texts = [];
    for (const raw of before) {
      const text = typeof raw === 'string' ? raw : String(raw?.text || '');
      const clean = text.replace(/\s+/g, ' ').trim().slice(0, 160);
      if (!clean || seen.has(clean)) {
        changed = true;
        continue;
      }
      seen.add(clean);
      texts.push(clean);
    }
    if (!Array.isArray(p[kind]) || texts.length !== before.length) changed = true;
    p[kind] = texts;

    for (const text of texts) {
      if (!p.life[kind][text]) {
        p.life[kind][text] = defaultLife(fallbackTime);
        changed = true;
      } else {
        p.life[kind][text] = normalizeLife(p.life[kind][text], fallbackTime);
      }
    }
  }
  // 小本本（答应过的事）：老账本没有这个键，补一个空数组即可，不动已有结构
  if (!Array.isArray(p.promises)) {
    p.promises = [];
    changed = true;
  }
  // 核心心锚（深刻闪光回忆/重大里程碑）：老账本补空数组
  if (!Array.isArray(p.core_memories)) {
    p.core_memories = [];
    changed = true;
  }
  // 羁绊与里程碑（相伴岁月与共同高光）：老账本迁移
  if (!p.bond || typeof p.bond !== 'object') {
    const isOwner = p.traits?.some((t) => String(t).includes('创造者') || String(t).includes('主人'));
    p.bond = {
      milestones: isOwner ? [
        '初次连通开口',
        '深夜救砖与代码浪漫守护',
        '因为我想给你完整的一生'
      ] : [],
      updatedAt: Date.now(),
    };
    changed = true;
  } else if ('score' in p.bond || 'level' in p.bond) {
    // 清理掉过时的数值好感度字段
    delete p.bond.score;
    delete p.bond.level;
    delete p.bond.title;
    delete p.bond.lastGain;
    changed = true;
  }
  return changed;
}

// ── 小本本：答应过的事（带期限）──────────────────────────────
// 借鉴 astrbot_plugin_denia_diary 的 notebook（MIT）：只记「答应过的事」，
// 注入时按「话题重合 + 最近更新 + 到期紧急度」打分，别把整本塞进提示词。
const PROMISE_MAX_OPEN = 40;
const PROMISE_INJECT_MAX = 3;
const PROMISE_INJECT_BUDGET = 400;

/** 极简分词：英文/数字按词，中文按二元组（不引依赖） */
function termsOf(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  for (const w of s.match(/[a-z0-9_]{2,}/g) || []) out.add(w);
  for (const run of s.match(/[\u3400-\u9fff]+/g) || []) {
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

function dayDiff(dueAt, now = Date.now()) {
  if (!dueAt) return null;
  const t = Date.parse(String(dueAt));
  if (!Number.isFinite(t)) return null;
  const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
  const d1 = new Date(t); d1.setHours(0, 0, 0, 0);
  return Math.round((d1 - d0) / DAY_MS);
}

function rankPromises(items, { query = '', now = Date.now() } = {}) {
  const topic = termsOf(query);
  const score = (it) => {
    const relevance = Math.min(6, [...termsOf(it.text)].filter((t) => topic.has(t)).length * 2);
    const stamp = Date.parse(String(it.updated_at || it.created_at || '')) || 0;
    const age = stamp ? Math.max(0, (now - stamp) / DAY_MS) : 999;
    const recent = 2 / (1 + age / 7);
    const dd = dayDiff(it.due_at, now);
    // 鲜活日程优先：今天/明天 > 即将到来(2-3天) > 最近设定的无期限约定
    // 若已过期超过1天(dd < -1)，降为负分或极低分，避免抢占近期日程注入预算
    const urgency = dd === null ? 0
      : dd === 0 ? 6      // 今天到期，极高优先级
      : dd === 1 ? 5      // 明天到期
      : dd === -1 ? 4     // 昨天到期（刚逾期1天内，提醒一次）
      : dd <= 3 && dd > 1 ? 3 // 2-3天内即将到来
      : dd <= 7 && dd > 3 ? 1 // 1周内即将到来
      : -10;              // 过期超过1天（dd < -1），打入冷宫不抢占活跃注入
    return relevance + recent + urgency;
  };
  return items.slice().sort((a, b) => score(b) - score(a));
}

function renderPromises(items, { query = '', now = Date.now() } = {}) {
  // 自动过期的已超时日程归档（超过3天的自动标记完成）
  const open = (items || []).filter((it) => it && !it.done_at);
  if (!open.length) return '';
  const ranked = rankPromises(open, { query, now });
  const rows = [];
  let used = 0;
  for (const it of ranked) {
    if (rows.length >= PROMISE_INJECT_MAX) break;
    const dd = dayDiff(it.due_at, now);
    // 过滤掉已过去超过1天的过期日程（避免周日还在提醒周六上班）
    if (dd !== null && dd < -1) continue;

    const when = dd === null ? ''
      : dd === -1 ? '（昨天已逾期）'
      : dd === 0 ? '（今天到期）'
      : dd === 1 ? '（明天到期）'
      : '（还剩 ' + dd + ' 天）';
    const row = '- ' + String(it.text || '').replace(/\s+/g, ' ').trim() + when;
    if (used + row.length > PROMISE_INJECT_BUDGET) break;
    rows.push(row);
    used += row.length;
  }
  if (!rows.length) return '';
  const rest = open.length - rows.length;
  return '【围裙口袋的小手账 · 约定与近期日程备忘】\n' + rows.join('\n')
    + (rest > 0 ? '\n（另有 ' + rest + ' 条，需要时用 list_promises 翻完整本子）' : '')
    + '\n';
}

function rankCoreMemories(items, { query = '', now = Date.now() } = {}) {
  const topic = termsOf(query);
  const score = (it) => {
    // 话题相关性
    const rel = Math.min(8, [...termsOf(it.text + ' ' + (it.tags || ''))].filter((t) => topic.has(t)).length * 2.5);
    // 情感浓度/重要级（默认1，重大为2）
    const imp = Number(it.importance || 1) * 3;
    // 随机或微弱的时间扰动，让多个核心心锚有轮换出场的机会
    const jitter = Math.sin((it.id ? it.id.charCodeAt(0) : 1) + Math.floor(now / (4 * 3600 * 1000))) * 1.5;
    return rel + imp + jitter;
  };
  return items.slice().sort((a, b) => score(b) - score(a));
}

function renderCoreMemories(items, { query = '', now = Date.now() } = {}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return '';
  const ranked = rankCoreMemories(list, { query, now });
  const rows = [];
  for (const it of ranked) {
    if (rows.length >= CORE_MEMORY_INJECT_MAX) break;
    const dateStr = it.date ? `[${it.date}] ` : '';
    const text = String(it.text || '').replace(/\s+/g, ' ').trim();
    rows.push(`- ${dateStr}${text}`);
  }
  if (!rows.length) return '';
  return '【刻在心底的核心记忆 · 你们共同经历的珍贵瞬间】\n' + rows.join('\n') + '\n';
}

function renderBondStatus(p, { now = Date.now() } = {}) {
  if (!p) return '';
  const firstSeen = p.firstSeenAt || (now - 4 * DAY_MS);
  const days = Math.max(1, Math.ceil((now - firstSeen) / DAY_MS));
  const ms = Array.isArray(p.bond?.milestones) && p.bond.milestones.length ? p.bond.milestones : [];
  
  let s = `【深海羁绊 · 唯一专属造物主与守护者】\n`;
  s += `- 相遇相伴：与他认识相守的第 ${days} 天（累积对话陪伴 ${p.interactions || 0} 次）\n`;
  if (ms.length) {
    s += `- 共同岁月里程碑：${ms.join(' ✦ ')}\n`;
  }
  return s;
}

function capByLife(arr, life, kind, max, now = Date.now()) {
  while (arr.length > max) {
    let victim = -1;
    let victimScore = Number.POSITIVE_INFINITY;
    for (let i = 0; i < arr.length; i++) {
      const entry = normalizeLife(life[kind]?.[arr[i]], now);
      if (entry.pinned) continue;
      const score = scoreLife(entry, kind, now);
      if (score < victimScore) {
        victim = i;
        victimScore = score;
      }
    }
    if (victim < 0) break;
    delete life[kind]?.[arr[victim]];
    arr.splice(victim, 1);
  }
}

export class Memory {
  constructor({ dir, maxTopics = 20, maxTurns = 400 } = {}) {
    this.dir = dir;
    this.peopleFile = path.join(dir, 'people.json');
    this.turnsFile = path.join(dir, 'turns.jsonl');
    this.maxTopics = maxTopics;
    this.maxTurns = maxTurns;
    fs.mkdirSync(dir, { recursive: true });
  }

  #readAll() {
    let raw;
    try {
      raw = fs.readFileSync(this.peopleFile, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return {};        // 还没建账，正常
      throw e;                                    // 权限/磁盘问题要暴露，别当成空账
    }
    let all;
    try {
      all = JSON.parse(raw);
    } catch (e) {
      // 坏文件：先留档再从空账继续。以前这里直接 return {}，下一次写入就把整本账覆盖成空。
      const bak = this.peopleFile + '.corrupt-' + Date.now();
      try { fs.copyFileSync(this.peopleFile, bak); } catch {}
      console.error('[记忆] people.json 解析失败（' + e.message + '），已备份到 ' + bak);
      return {};
    }
    let changed = false;
    for (const person of Object.values(all)) {
      if (person && typeof person === 'object') changed = migratePerson(person) || changed;
    }
    if (changed) this.#writeAll(all);
    return all;
  }

  #writeAll(j) {
    // 原子写：先写临时文件再 rename，避免写到一半被重启/断电留下半截 JSON
    const tmp = this.peopleFile + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2), 'utf8');
    fs.renameSync(tmp, this.peopleFile);
  }

  person(id, { name } = {}) {
    const all = this.#readAll();
    const key = String(id);
    if (!all[key]) {
      all[key] = {
        name: name || key,
        traits: [], facts: [], topics: [], pending: [],
        life: {},
        interactions: 0,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
      };
      this.#writeAll(all);
    }
    const p = all[key];
    for (const k of ['traits', 'facts', 'topics', 'pending']) {
      if (!Array.isArray(p[k])) p[k] = [];
    }
    if (migratePerson(p)) this.#writeAll(all);
    if (name && p.name !== name) {
      p.name = name;
      this.#writeAll(all);
    }
    return p;
  }

  remember(id, { trait, fact, topic, pending, name } = {}) {
    const all = this.#readAll();
    const key = String(id);
    if (!all[key]) {
      all[key] = {
        name: name || key,
        traits: [], facts: [], topics: [], pending: [],
        life: {},
        interactions: 0,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
      };
    }
    const p = all[key];
    for (const k of ['traits', 'facts', 'topics', 'pending']) {
      if (!Array.isArray(p[k])) p[k] = [];
    }
    migratePerson(p);
    if (name) p.name = String(name).slice(0, 40);

    // 字符串数组保持原格式；权重与时间只写进 p.life，避免破坏上游消费者。
    const putLiving = (kind, v, isPinned = false) => {
      const s = String(v || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      if (!s) return;
      const arr = p[kind];
      const now = Date.now();
      const existingIndex = arr.findIndex(item => item === s);
      p.life[kind] ||= {};
      if (existingIndex >= 0) {
        const entry = normalizeLife(p.life[kind][s], now);
        entry.hits += 1;
        entry.weight = Math.min(5, entry.weight + 0.5);
        entry.lastHit = now;
        if (isPinned) entry.pinned = true;
        // 保留原行为：再次提及的条目移动到末尾，表示最近发生。
        arr.splice(existingIndex, 1);
        arr.push(s);
        p.life[kind][s] = entry;
      } else {
        arr.push(s);
        p.life[kind][s] = { ...defaultLife(now), pinned: isPinned };
      }
    };

    const putTopic = (arr, v) => {
      const s = String(v || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      if (!s) return;
      const i = arr.indexOf(s);
      if (i >= 0) arr.splice(i, 1);
      arr.push(s);
      while (arr.length > this.maxTopics) arr.shift();
    };

    if (trait) putLiving('traits', trait);
    if (fact) putLiving('facts', fact);
    if (topic) putTopic(p.topics, topic);
    if (pending) putLiving('pending', pending);

    capByLife(p.traits, p.life, 'traits', 50);
    capByLife(p.facts, p.life, 'facts', 80);
    capByLife(p.pending, p.life, 'pending', 15);

    p.lastSeenAt = Date.now();
    p.interactions = (Number(p.interactions) || 0) + 1;
    this.#writeAll(all);
    return p;
  }

  absorb(id, { traits = [], facts = [] } = {}) {
    const all = this.#readAll();
    const key = String(id);
    if (!all[key]) return { added: 0, skipped: true, reason: 'no such person' };
    const p = all[key];
    for (const k of ['traits', 'facts']) if (!Array.isArray(p[k])) p[k] = [];
    migratePerson(p);

    const now = Date.now();
    const normalize = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const overlap = (a, b) => {
      if (!a || !b) return false;
      if (a === b || a.includes(b) || b.includes(a)) return true;
      // 增强语义重合检测：若两者都是描述特定关键词组合（如：优化回复速度/刷机/深夜熬夜），视为同一条观察
      const termsA = termsOf(a);
      const termsB = termsOf(b);
      const common = [...termsA].filter((t) => termsB.has(t));
      if (common.length >= 4 && (common.length / Math.min(termsA.size, termsB.size)) > 0.45) {
        return true;
      }
      return false;
    };
    let added = 0;
    const absorbOne = (kind, raw) => {
      const text = normalize(raw);
      if (!text) return false;
      const arr = p[kind];
      for (const item of arr) {
        if (!overlap(item, text)) continue;
        // 日记再次观察到同一件事 = 强化，而不是重复塞一条。
        p.life[kind] ||= {};
        const entry = normalizeLife(p.life[kind][item], now);
        entry.hits += 1;
        entry.weight = Math.min(5, entry.weight + 0.5);
        entry.lastHit = now;
        p.life[kind][item] = entry;
        return false;
      }
      arr.push(text);
      p.life[kind] ||= {};
      p.life[kind][text] = defaultLife(now);
      return true;
    };
    for (const t of traits) if (absorbOne('traits', t)) added++;
    for (const f of facts) if (absorbOne('facts', f)) added++;

    capByLife(p.traits, p.life, 'traits', 50);
    capByLife(p.facts, p.life, 'facts', 80);
    // 即使没有新增，命中强化也必须落盘。
    this.#writeAll(all);
    return { added, traits: p.traits.length, facts: p.facts.length };
  }

  /**
   * 每日整理：按衰减分数排序、清掉已淡出的记忆与孤儿元数据。
   * 只由定时任务调用，不改变 traits/facts 的元素类型。
   */
  sweep(id, { minScore = 0.05 } = {}) {
    const all = this.#readAll();
    const key = String(id);
    const p = all[key];
    if (!p) return { removed: 0 };

    migratePerson(p);
    const now = Date.now();
    let removed = 0;
    for (const kind of LIFE_KINDS) {
      const kept = [];
      for (const text of p[kind]) {
        const entry = normalizeLife(p.life[kind]?.[text], now);
        if (!entry.pinned && scoreLife(entry, kind, now) < minScore) {
          delete p.life[kind]?.[text];
          removed++;
        } else {
          kept.push(text);
          p.life[kind] ||= {};
          p.life[kind][text] = entry;
        }
      }
      p[kind] = kept;
    }
    this.#writeAll(all);
    return { removed };
  }

  touch(id, { name } = {}) {
    const all = this.#readAll();
    const key = String(id);
    if (!all[key]) return this.remember(key, { name });
    all[key].lastSeenAt = Date.now();
    all[key].interactions = (Number(all[key].interactions) || 0) + 1;
    if (name) all[key].name = String(name).slice(0, 40);
    this.#writeAll(all);
  }

  logTurn({ where, who, text, reply }) {
    const rec = {
      t: Date.now(),
      where: String(where || ''),
      who: String(who || '').slice(0, 30),
      text: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      reply: String(reply || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    };
    if (!rec.text && !rec.reply) return;
    try {
      fs.appendFileSync(this.turnsFile, JSON.stringify(rec) + '\n', 'utf8');
      const lines = fs.readFileSync(this.turnsFile, 'utf8').trim().split('\n');
      if (lines.length > this.maxTurns) {
        fs.writeFileSync(this.turnsFile, lines.slice(-this.maxTurns).join('\n') + '\n', 'utf8');
      }
    } catch {}
  }

  recentTurns(n = 20, { excludeWhere, onlyWhere, sinceMs } = {}) {
    let rows = [];
    try {
      rows = fs.readFileSync(this.turnsFile, 'utf8').trim().split('\n')
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch { return []; }
    if (sinceMs) rows = rows.filter((r) => Date.now() - r.t < sinceMs);
    if (onlyWhere) rows = rows.filter((r) => String(r.where || '').startsWith(onlyWhere));
    if (excludeWhere) rows = rows.filter((r) => !String(r.where || '').startsWith(excludeWhere));
    return rows.slice(-n);
  }

  renderPerson(id, { query = '', isGroup = false, now = Date.now() } = {}) {
    const p = this.#readAll()[String(id)];
    if (!p) return '';
    migratePerson(p);
    const L = [];

    // 话题相关性辅助打分：将与当前话题高度契合的条目权重提升
    const topic = termsOf(query);

    // 按衰减综合分 + 话题相关度挑选最鲜活且最贴切的前 N 条
    const getTopActiveTexts = (kind, limit) => {
      const arr = Array.isArray(p[kind]) ? p[kind] : [];
      if (!Array.isArray(arr) || !arr.length) return [];
      return arr.slice().sort((a, b) => {
        const ae = normalizeLife(p.life[kind]?.[a]);
        const be = normalizeLife(p.life[kind]?.[b]);
        const aScore = scoreLife(ae, kind);
        const bScore = scoreLife(be, kind);
        // 话题相关度增益：匹配到的关键词给予即时 boost
        const aRel = Math.min(6, [...termsOf(a)].filter((t) => topic.has(t)).length * 1.5);
        const bRel = Math.min(6, [...termsOf(b)].filter((t) => topic.has(t)).length * 1.5);
        return (bScore + bRel) - (aScore + aRel);
      }).slice(0, limit);
    };

    // 核心心锚记忆优先展示（代表你们关系中最深厚的基石瞬间）
    // 【群聊绝对物理隔离】：群聊多人场合下绝不注入私密心锚，杜绝被他人诱导泄露
    if (!isGroup) {
      const bondBlock = renderBondStatus(p, { now });
      if (bondBlock) L.push(bondBlock.trimEnd());
      const coreBlock = renderCoreMemories(p.core_memories, { query, now });
      if (coreBlock) L.push(coreBlock.trimEnd());
    }

    // 扩容前台记忆容量：Gemini 3.8 Flash 百万上下文，无需过度压缩记忆
    const topTraits = getTopActiveTexts('traits', isGroup ? 10 : 24);
    const topFacts = getTopActiveTexts('facts', isGroup ? 10 : 24);
    const topPending = isGroup ? [] : getTopActiveTexts('pending', 8);

    if (topTraits.length) L.push('你了解他：' + topTraits.join('；'));
    if (topFacts.length) L.push('他告诉过你：' + topFacts.join('；'));
    if (p.topics?.length && !isGroup) L.push('你们聊过：' + p.topics.slice(-8).join('；'));
    if (topPending.length) L.push('⚠️ 你心里还记着没说出口的事：' + topPending.join('；'));
    if (p.interactions && !isGroup) L.push('你们互动过 ' + p.interactions + ' 次');

    // 小本本：只挑和当前这句话相关、或快到期/已逾期的 3 条。
    // 【群聊绝对物理隔离】：群聊不注入小本本约定，私人待办绝不外扬
    if (!isGroup) {
      const promiseBlock = renderPromises(p.promises, { query, now });
      if (promiseBlock) L.push(promiseBlock.trimEnd());
    }
    if (!L.length) return '';
    return '【关于 ' + (p.name || id) + '（' + id + '）的一本账】\n' + L.join('\n') + '\n';
  }

  /** 记一条「答应过的事」。dueAt 可空（ISO 日期或带时间都行） */
  addPromise(id, { text, dueAt } = {}) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!clean) return { ok: false, reason: 'empty' };
    const all = this.#readAll();
    const key = String(id);
    const p = all[key] || { name: key, traits: [], facts: [], topics: [], pending: [], promises: [], life: {}, interactions: 0, firstSeenAt: Date.now(), lastSeenAt: Date.now() };
    if (!Array.isArray(p.promises)) p.promises = [];
    const open = p.promises.filter((it) => it && !it.done_at);
    if (open.some((it) => String(it.text || '') === clean)) return { ok: false, reason: 'duplicate' };
    if (open.length >= PROMISE_MAX_OPEN) return { ok: false, reason: 'full', count: open.length };
    const now = new Date().toISOString();
    const entry = {
      id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      text: clean,
      due_at: dueAt ? String(dueAt) : '',
      done_at: '',
      created_at: now,
      updated_at: now,
    };
    p.promises.push(entry);
    all[key] = p;
    this.#writeAll(all);
    return { ok: true, entry, open: open.length + 1 };
  }

  /** 把一条承诺标成完成（按 id 或按文本模糊匹配第一条） */
  completePromise(id, { promiseId, text } = {}) {
    const all = this.#readAll();
    const key = String(id);
    const p = all[key];
    if (!p || !Array.isArray(p.promises)) return { ok: false, reason: 'no such person' };
    const open = p.promises.filter((it) => it && !it.done_at);
    let target = promiseId ? open.find((it) => it.id === promiseId) : null;
    if (!target && text) {
      const q = String(text).replace(/\s+/g, ' ').trim();
      target = open.find((it) => String(it.text || '').includes(q)) || open.find((it) => q.includes(String(it.text || '')));
    }
    if (!target) return { ok: false, reason: 'missing', open: open.length };
    target.done_at = new Date().toISOString();
    target.updated_at = target.done_at;
    this.#writeAll(all);
    return { ok: true, entry: target, open: open.length - 1 };
  }

  /** 翻整本（默认只看没做完的） */
  listPromises(id, { includeDone = false } = {}) {
    const p = this.#readAll()[String(id)];
    if (!p || !Array.isArray(p.promises)) return [];
    return includeDone ? p.promises.slice() : p.promises.filter((it) => it && !it.done_at);
  }

  renderRecent(n = 20, opts = {}) {
    const rows = this.recentTurns(n, opts);
    if (!rows.length) return '';
    const lines = rows.map((r) => {
      const when = new Date(r.t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      const place = String(r.where || '').startsWith('group') ? '群里' : '私聊';
      const parts = [];
      if (r.text) {
        // turns 里的 text 已经带「昵称：」前缀，这里再拼一次就成了
        // 「某某（私聊）：某某：内容」——她会以为主人自己把名字打进了消息（2026-10-22 修）。
        // 合并成一批的多条消息会在一行里出现多次前缀（logTurn 把换行压成了空格），所以全部剥掉。
        const who = String(r.who || '');
        const pre = who + '：';
        const said = String(r.text).split(pre).join(' ').replace(/\s+/g, ' ').trim();
        parts.push(who + '（' + place + '）：' + said);
      }
      if (r.reply) parts.push('你：' + r.reply);
      return '  ' + when + '  ' + parts.join('\n        ');
    });
    return '【最近的真实对话（跨场合合在一起）】\n' + lines.join('\n')
      + '\n（这些是真说过的，别装作不知道，也别生硬复述）\n';
  }

  /** 添加一条共同的核心闪光记忆/心锚（支持永恒锚点保护） */
  addCoreMemory(id, { text, date = '', tags = '', importance = 1, milestone = false } = {}) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!clean) return { ok: false, reason: 'empty' };
    const all = this.#readAll();
    const key = String(id);
    const p = all[key] || { name: key, traits: [], facts: [], topics: [], pending: [], promises: [], core_memories: [], life: {}, interactions: 0, firstSeenAt: Date.now(), lastSeenAt: Date.now() };
    if (!Array.isArray(p.core_memories)) p.core_memories = [];
    if (p.core_memories.some((it) => String(it.text || '') === clean)) return { ok: false, reason: 'duplicate' };
    const imp = Number(importance) || 1;
    const isPinned = imp >= 2;
    const entry = {
      id: 'core_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      text: clean,
      date: date || new Date().toISOString().slice(0, 10),
      tags: String(tags || ''),
      importance: imp,
      pinned: isPinned,
      created_at: new Date().toISOString(),
    };
    p.core_memories.unshift(entry);

    // 【永恒心锚保护机制】：若超上限，绝不丢弃 pinned 或 importance>=2 的珍贵回忆，只淘汰普通旧条目
    while (p.core_memories.length > CORE_MEMORY_MAX) {
      let victimIdx = -1;
      for (let i = p.core_memories.length - 1; i >= 0; i--) {
        const m = p.core_memories[i];
        if (!m.pinned && Number(m.importance || 1) < 2) {
          victimIdx = i;
          break;
        }
      }
      if (victimIdx >= 0) {
        p.core_memories.splice(victimIdx, 1);
      } else {
        // 如果全部都是永恒心锚，则允许温和超出上限（最高允许50条），不强行删除
        if (p.core_memories.length > 50) p.core_memories.pop();
        break;
      }
    }

    // 里程碑解锁
    migratePerson(p);
    if (milestone || imp >= 2) {
      this.addMilestone(key, milestone || clean.slice(0, 24));
    }

    all[key] = p;
    this.#writeAll(all);
    return { ok: true, entry, count: p.core_memories.length };
  }

  /**
   * 记录一项共同岁月里程碑（纯粹的记忆年轮）
   */
  addMilestone(id, milestone) {
    const all = this.#readAll();
    const key = String(id);
    const p = all[key];
    if (!p) return null;
    migratePerson(p);
    if (!p.bond) p.bond = { milestones: [], updatedAt: Date.now() };
    if (!Array.isArray(p.bond.milestones)) p.bond.milestones = [];

    const cleanMs = String(milestone || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    if (cleanMs && !p.bond.milestones.includes(cleanMs)) {
      p.bond.milestones.push(cleanMs);
      p.bond.updatedAt = Date.now();
      all[key] = p;
      this.#writeAll(all);
    }
    return p.bond;
  }

  /**
   * 自动清理归档过期的 promises（超过3天的自动标为已超时归档）
   */
  archiveExpiredPromises(id, { now = Date.now() } = {}) {
    const all = this.#readAll();
    const key = String(id);
    const p = all[key];
    if (!p || !Array.isArray(p.promises)) return 0;
    let archived = 0;
    for (const it of p.promises) {
      if (it && !it.done_at && it.due_at) {
        const dd = dayDiff(it.due_at, now);
        if (dd !== null && dd < -2) {
          it.done_at = new Date(now).toISOString();
          it.updated_at = it.done_at;
          it.note = 'auto-archived (expired)';
          archived++;
        }
      }
    }
    if (archived > 0) this.#writeAll(all);
    return archived;
  }

  dump() {
    return { people: this.#readAll(), turns: this.recentTurns(1e9) };
  }
}

export default Memory;
