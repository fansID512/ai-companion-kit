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
  return changed;
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
      // 只做保守去重；模糊相似会把“喜欢猫/不喜欢猫”这类相反事实误合成一条。
      return a === b || a.includes(b) || b.includes(a);
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

  renderPerson(id) {
    const p = this.#readAll()[String(id)];
    if (!p) return '';
    migratePerson(p);
    const L = [];

    // 按衰减综合分挑选最鲜活的前 N 条；文案仍原样输出，不改元素类型。
    const getTopActiveTexts = (kind, limit) => {
      const arr = Array.isArray(p[kind]) ? p[kind] : [];
      if (!Array.isArray(arr) || !arr.length) return [];
      return arr.slice().sort((a, b) => {
        const ae = normalizeLife(p.life[kind]?.[a]);
        const be = normalizeLife(p.life[kind]?.[b]);
        return scoreLife(be, kind) - scoreLife(ae, kind);
      }).slice(0, limit);
    };

    // 扩容前台记忆容量：Gemini 3.8 Flash 百万上下文，无需过度压缩记忆
    const topTraits = getTopActiveTexts('traits', 24);
    const topFacts = getTopActiveTexts('facts', 24);
    const topPending = getTopActiveTexts('pending', 8);

    if (topTraits.length) L.push('你了解他：' + topTraits.join('；'));
    if (topFacts.length) L.push('他告诉过你：' + topFacts.join('；'));
    if (p.topics?.length) L.push('你们聊过：' + p.topics.slice(-8).join('；'));
    if (topPending.length) L.push('⚠️ 你心里还记着没说出口的事：' + topPending.join('；'));
    if (p.interactions) L.push('你们互动过 ' + p.interactions + ' 次');
    if (!L.length) return '';
    return '【关于 ' + (p.name || id) + '（' + id + '）的一本账】\n' + L.join('\n') + '\n';
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

  dump() {
    return { people: this.#readAll(), turns: this.recentTurns(1e9) };
  }
}

export default Memory;
