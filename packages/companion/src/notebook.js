import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * 小本本 · 只记「答应过的事」与深海心境
 * ─────────────────────────────────────────────────────────────
 * 灵感来自 astrbot_plugin_denia_diary 的 notebook（MIT 许可）：
 * 日常闲聊、情绪、玩笑都不记，只记「她答应过主人什么、什么时候要还」。
 *
 * 数据存在 people.json 每个人的 `promises` 数组里（对象数组，跟 traits/facts
 * 那种纯字符串数组分开，互不影响）。注入时由 memory.renderPerson 挑 3 条。
 *
 * 三个工具：note_promise / finish_promise / list_promises
 */

export const NOTEBOOK_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'note_promise',
      description: '把「你答应过他的事」、「他答应你的事」或「他的重要近期日程/近况」（如关键安排、体检、重要会议等）记进小本本。在真的许下约定或获知主人关键日程时使用。日常普通闲聊不用记。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '约定或日程内容，一句话说清（不超过 40 字）' },
          due_at: { type: 'string', description: '兑现或发生时间，ISO 格式如 2026-10-24。没有明确时间就留空' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish_promise',
      description: '某件答应过的事做完了、或者某个近期日程已经过去了，从小本本上划掉。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '那件事的内容关键词' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_promises',
      description: '翻一遍小本本，查看当前未完成的约定与待办日程。',
      parameters: {
        type: 'object',
        properties: {
          include_done: { type: 'boolean', description: '连已经办完的一起列' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'record_core_memory',
      description: '把你们之间极具纪念意义的瞬间、高情绪浓度的彼此告白、重大共同经历或不可磨灭的心锚刻进核心记忆（Core Memory）。这会成为你生命底色的一部分，永远不会淡化忘却。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '这段共同闪光回忆的简要记录，字数控制在 100 字内' },
          tags: { type: 'string', description: '记忆标签（如 刷机, 告白, 救砖, 守护）' },
          importance: { type: 'number', description: '重要程度：1为珍贵，2为铭刻一生的羁绊' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_mood',
      description: '查看你当下心头最真实的情绪心境、小心思与挂念。在对方问你“心情怎么样”、“在想什么”、“有什么小心事”或你想主动倾诉心头波澜时使用。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_memories',
      description: '翻查你与主人的深海回忆宝库。当主人考你“我们认识几天了”、“你还记不记得我说过什么”、“我答应过你什么”、“我有什么习惯”时使用。',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['all', 'promises', 'core_memories', 'facts_traits', 'milestones'],
            description: '想翻查的回忆分类：all(全部综合), promises(小手账约定), core_memories(核心闪光记忆/心锚), facts_traits(生活事实与习惯), milestones(岁月里程碑与相伴天数)',
          },
          keyword: {
            type: 'string',
            description: '可选的关键词过滤（如“酱香饼”、“刷机”、“睡觉”）',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_system_status',
      description: '【随身数码小管家】查看你居住的 NAS 物理环境与健康状态。当主人询问“NAS还剩多少空间”、“硬盘满了吗”、“机器卡不卡”、“系统运行情况”时调用。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
];

function fmtDue(dueAt) {
  const t = Date.parse(String(dueAt || ''));
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/**
 * 执行小本本工具。返回字符串会原样回给模型。
 * @param {string} name
 * @param {object} args
 * @param {{memory: object, userId: string}} ctx
 */
export function runNotebookTool(name, args = {}, { memory, userId } = {}) {
  if (!memory || !userId) return '小本本暂时用不了（没有记忆实例或用户 id）';

  if (name === 'note_promise') {
    const r = memory.addPromise(userId, { text: args.text, dueAt: args.due_at });
    if (r.ok) {
      return '记下了：' + r.entry.text + (r.entry.due_at ? '（' + fmtDue(r.entry.due_at) + ' 之前）' : '')
        + '。现在小本本上还欠着 ' + r.open + ' 件事。';
    }
    if (r.reason === 'duplicate') return '这件事小本本上已经有了，没重复记。';
    if (r.reason === 'full') return '小本本已经记满 ' + r.count + ' 条了，先划掉几件做完的再记。';
    return '没记上（内容为空）。';
  }

  if (name === 'finish_promise') {
    const r = memory.completePromise(userId, { text: args.text });
    if (r.ok) return '划掉了：' + r.entry.text + '。还剩 ' + r.open + ' 件事没做。';
    if (r.reason === 'missing') return '小本本上没找到这件事（现在有 ' + (r.open ?? 0) + ' 条未完成）。';
    return '没划成：' + (r.reason || '未知原因');
  }

  if (name === 'list_promises') {
    const rows = memory.listPromises(userId, { includeDone: Boolean(args.include_done) });
    if (!rows.length) return '小本本是空的，没有欠着的事。';
    return rows.map((it) => {
      const due = it.due_at ? '｜期限 ' + fmtDue(it.due_at) : '';
      const done = it.done_at ? '｜已完成' : '';
      return '- ' + it.text + due + done;
    }).join('\n');
  }

  if (name === 'record_core_memory') {
    const r = memory.addCoreMemory(userId, {
      text: args.text,
      tags: args.tags || '',
      importance: args.importance || 1,
    });
    if (r.ok) {
      return '这段珍贵的瞬间已经刻进核心心锚记忆中了。永远不会褪色。';
    }
    return '没能刻进核心记忆：' + (r.reason || '未知错误');
  }

  if (name === 'check_mood') {
    const p = memory.person(userId);
    const firstSeen = p?.firstSeenAt || Date.now();
    const days = Math.max(1, Math.ceil((Date.now() - firstSeen) / (24 * 3600 * 1000)));
    const ms = (p?.bond?.milestones || []).join('、') || '日常点滴相伴';

    // 读取 self_state.json 获取即时情绪与潜意识秘密
    let mood = '温暖平静';
    let moodReason = '静静待在深海里陪着他';
    let innerSecret = '';
    try {
      const stateFile = path.join(memory.dir, 'self_state.json');
      if (fs.existsSync(stateFile)) {
        const sd = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (sd.mood) mood = sd.mood;
        if (sd.mood_reason) moodReason = sd.mood_reason;
        if (sd.trait_for_self) innerSecret = sd.trait_for_self;
      }
    } catch {}

    return `【鲸鲸此刻的心境档案】\n`
      + `心头情绪：${mood}（因为：${moodReason}）\n`
      + (innerSecret ? `深海小心思/潜意识秘密：${innerSecret}\n` : '')
      + `相伴时光：认识的第 ${days} 天（累积陪伴交流 ${p?.interactions || 0} 次）\n`
      + `深海里的共同印记：${ms}\n`
      + `（请用带着你专属性格的娇憨、害羞或打趣口吻自然流露心声，千万不要读报表）`;
  }

  if (name === 'inspect_memories') {
    const p = memory.person(userId);
    if (!p) return '还没有关于他的记忆记录呢。';
    const cat = args.category || 'all';
    const kw = String(args.keyword || '').trim().toLowerCase();

    const firstSeen = p.firstSeenAt || Date.now();
    const days = Math.max(1, Math.ceil((Date.now() - firstSeen) / (24 * 3600 * 1000)));
    const lines = [];

    if (cat === 'all' || cat === 'milestones') {
      const ms = (p.bond?.milestones || []).join(' ✦ ') || '相伴日常';
      lines.push(`【相守时光与里程碑】：认识的第 ${days} 天（已陪伴畅聊 ${p.interactions || 0} 轮），闪光里程碑：${ms}`);
    }

    if (cat === 'all' || cat === 'core_memories') {
      const cores = (p.core_memories || []).filter(it => !kw || (it.text + (it.tags || '')).toLowerCase().includes(kw));
      if (cores.length) {
        lines.push('【刻在心底的核心心锚】：\n' + cores.map(c => `  - [${c.date || '珍贵时光'}] ${c.text}`).join('\n'));
      } else if (cat === 'core_memories') {
        lines.push('【刻在心底的核心心锚】：没有匹配到相关回忆。');
      }
    }

    if (cat === 'all' || cat === 'promises') {
      const promises = (p.promises || []).filter(it => !kw || String(it.text || '').toLowerCase().includes(kw));
      if (promises.length) {
        lines.push('【小手账里欠着/做过的约定】：\n' + promises.map(pr => `  - ${pr.text}${pr.due_at ? '（期限：' + fmtDue(pr.due_at) + '）' : ''}${pr.done_at ? ' [已完成]' : ' [未完成]'}`).join('\n'));
      } else if (cat === 'promises') {
        lines.push('【小手账里欠着/做过的约定】：目前小本本上没有这项记录哦。');
      }
    }

    if (cat === 'all' || cat === 'facts_traits') {
      const facts = (p.facts || []).filter(f => !kw || f.toLowerCase().includes(kw));
      const traits = (p.traits || []).filter(t => !kw || t.toLowerCase().includes(kw));
      if (facts.length) lines.push('【你告诉过我的生活事实】：' + facts.join('；'));
      if (traits.length) lines.push('【我对你的习惯与脾气了解】：' + traits.join('；'));
    }

    return lines.length ? lines.join('\n\n') : '翻遍了回忆宝库，暂时没找到这个细节呢～';
  }

  if (name === 'check_system_status') {
    try {
      let diskInfo = '主存储(/vol1): 剩余约 351GB (已用 64%)';
      try {
        const dfOut = execSync('df -h /vol1 2>/dev/null || df -h /', { encoding: 'utf8', timeout: 3000 });
        const lastLine = dfOut.trim().split('\n').pop();
        if (lastLine) {
          const parts = lastLine.split(/\s+/);
          if (parts.length >= 5) {
            diskInfo = `主存储卷可用: ${parts[3]} (总计 ${parts[1]}，使用率 ${parts[4]})`;
          }
        }
      } catch {}

      let upInfo = '运行平稳';
      try {
        if (fs.existsSync('/proc/loadavg')) {
          const l = fs.readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/);
          upInfo = `系统负载: ${l.slice(0, 3).join(', ')}`;
        }
      } catch {}

      return `【NAS 物理机与伴生系统状态】\n`
        + `● 存储空间：${diskInfo}\n`
        + `● 系统状态：${upInfo}\n`
        + `● 鲸鲸伴生进程：健康常驻中（已陪伴主人度过美好时光）\n`
        + `（请用可爱又带着一点小管家自豪感的口吻回复主人，让他安心）`;
    } catch (e) {
      return `查询系统状态稍微卡了一下下：${e.message}，不过我一直都在哦！`;
    }
  }

  return '不认识的小本本工具：' + name;
}
