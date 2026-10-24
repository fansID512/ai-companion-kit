/**
 * 小本本 · 只记「答应过的事」
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
      name: 'check_bond',
      description: '查看你与对方当下的好感度、灵魂羁绊阶位（Level 1~5）与共同解锁的里程碑时刻。在对方好奇询问好感度、羁绊程度或聊起陪伴回忆时使用。',
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

  if (name === 'check_bond') {
    const p = memory.person(userId);
    if (!p) return '还没有记录到对方的信息。';
    const bond = p.bond || { score: 10, level: 1, title: '初相识' };
    const firstSeen = p.firstSeenAt || Date.now();
    const days = Math.max(1, Math.ceil((Date.now() - firstSeen) / (24 * 3600 * 1000)));
    const ms = (bond.milestones || []).join('、') || '日常点滴相伴';
    return `当前羁绊阶位：第 ${bond.level} 阶「${bond.title}」\n`
      + `好感成长值：${bond.score}\n`
      + `相伴天数：认识的第 ${days} 天（累积互动 ${p.interactions || 0} 次）\n`
      + `共同高光里程碑：${ms}\n`
      + `（请用符合你性格的方式娇憨自然地回复对方，别像念系统报表）`;
  }

  return '不认识的小本本工具：' + name;
}
