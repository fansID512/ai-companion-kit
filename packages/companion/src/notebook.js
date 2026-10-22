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
      description: '把「你答应过他的事」记进小本本，将来好提醒自己兑现。只在真的许下承诺时用'
        + '（例如「明天提醒你交作业」「周末陪你看电影」「帮你查这个配置」），'
        + '日常闲聊、玩笑、情绪不要记。已经记过的同一件事不要重复记。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '答应的事，一句话说清（不超过 40 字），例如「周日之前把他的 U 盘还回去」' },
          due_at: { type: 'string', description: '什么时候要兑现，ISO 格式如 2026-10-25 或 2026-10-25T20:00。没有明确期限就留空' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish_promise',
      description: '某件答应过的事已经做完了，把它从小本本上划掉。'
        + '如果他提到「上次那件事办好了」或者你自己刚兑现了，就调用它。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '那件事的内容（可以只写关键词，会模糊匹配第一条未完成的）' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_promises',
      description: '翻一遍小本本，看看还欠着哪些事没做。提示词里只给最相关的 3 条，需要全量时用它。',
      parameters: {
        type: 'object',
        properties: {
          include_done: { type: 'boolean', description: '连已经做完的一起列（默认只看没做完的）' },
        },
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

  return '不认识的小本本工具：' + name;
}
