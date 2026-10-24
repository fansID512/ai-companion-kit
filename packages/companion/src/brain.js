/**
 * 大脑 · 把消息变成回复
 * ─────────────────────────────────────────────────────────────
 * 这一层只做三件事：
 *   1. 组装上下文（角色卡 + 记忆 + 最近的对话 + 当前处境）
 *   2. 调模型
 *   3. 把这一轮写回记忆
 *
 * 它不关心消息从哪来（QQ / 微信 / 命令行都行），
 * 也不关心怎么发出去（那是 transport 的事）。
 */
import { Memory } from './memory.js';
import { Role } from './role.js';

export class Brain {
  /**
   * @param {object} opts
   * @param {string}  opts.apiKey
   * @param {string}  [opts.baseUrl]   默认 https://api.deepseek.com/v1
   * @param {string}  [opts.model]     默认 deepseek-chat
   * @param {number}  [opts.timeoutMs] 默认 120000
   * @param {Role}    opts.role
   * @param {Memory}  opts.memory
   */
  constructor({ apiKey, baseUrl = 'https://api.deepseek.com/v1', model = 'deepseek-chat', timeoutMs = 120000, role, memory }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.role = role || new Role({ cardPath: 'role.md' });
    this.memory = memory || new Memory({ dir: './data' });
  }

  /**
   * 生成一条回复
   *
   * @param {object} input
   * @param {string} input.key         会话标识
   * @param {string} input.userId      对方 id
   * @param {string} [input.userName]
   * @param {string} input.text        对方说的话（可以是合并后的一批）
   * @param {string} [input.situation] 处境描述（"你在群里，刚才在聊……"）
   * @param {Array}  [input.history]   该会话最近的消息（可选，通常靠 memory 就够）
   * @param {boolean}[input.record=true] 是否把这一轮写回记忆
   * @param {(sentence: string)=>Promise<void>} [input.onSentence] 句级流式到达回调
   * @returns {Promise<{text:string, reasoning?:string, raw:any, streamedFirst?:boolean}>}
   */
  async reply(input) {
    const { key, userId, userName, text, situation = '', history = [], record = true, onSentence } = input;

    // query 用来给小本本打分：和当前这句话相关的承诺/到期的事优先注入
    const isGroup = !String(key).startsWith('private:');
    const memLine = this.memory.renderPerson(userId, { query: text, isGroup });
    const recent = this.memory.renderRecent(20, { excludeWhere: key });
    const sys = this.role.build({
      situation,
      memory: memLine,
      recent,
      selfNote: input.selfNote || '',
      platform: input.platform || '',
    });

    // 当前会话的最近 12 轮：作为真正的对话消息注入。
    // 之前这里只有跨场合的 recent（还明确排除了当前私聊），模型手里只剩"这一条 + 长期账本"，
    // 连续短句就会接不住（2026-10-22 定位）。调用方没显式传 history 时自己从 turns 里取。
    let ctxHistory = Array.isArray(history) ? history : [];
    if (!ctxHistory.length) {
      ctxHistory = [];
      const isPrivate = String(key).startsWith('private:');
      for (const r of this.memory.recentTurns(12, { onlyWhere: key })) {
        // turns 里 text 存成「昵称：内容」：私聊只有一个人，前缀是噪音就摘掉；
        // 群聊里前缀就是「谁说的」，必须留着。
        // 另有历史遗留：从 AstrBot 迁来的 12 条 user 消息尾部带 <system_reminder>…</system_reminder>，
        // 注入前剥掉（原始数据不动，只在提示词里清）。
        const raw = String(r.text || '').replace(/<system_reminder>[\s\S]*?<\/system_reminder>/g, '').trim();
        const pre = String(r.who || '') + '：';
        // 合并成一批的多条会在一行里出现多次「昵称：」（logTurn 压掉了换行），私聊里全部剥掉
        const said = isPrivate ? raw.split(pre).join(' ').replace(/\s+/g, ' ').trim() : raw;
        if (said) ctxHistory.push({ isSelf: false, text: said.slice(0, 800) });
        if (r.reply) ctxHistory.push({ isSelf: true, text: String(r.reply).slice(0, 800) });
      }
    }

    // 私聊里对方只有一个人，`Waker.joinBatch` 拼的「昵称：内容」前缀是纯噪音
    // （她会以为你自己把名字打进了消息里，2026-10-22 实测就这么说了）。
    // 和历史注入保持同一套规则：私聊摘掉，群聊保留（那是「谁说的」）。
    let userText = String(text || '');
    if (String(key).startsWith('private:') && userName) {
      const pre = String(userName) + '：';
      userText = userText.split('\n')
        .map((line) => (line.startsWith(pre) ? line.slice(pre.length) : line))
        .join('\n');
    }

    const messages = [{ role: 'system', content: sys }];
    for (const h of ctxHistory.slice(-24)) {
      messages.push({ role: h.isSelf ? 'assistant' : 'user', content: String(h.text || '') });
    }
    const imgs = Array.isArray(input.images) ? input.images.filter(Boolean).slice(0, 3) : [];
    const userContent = imgs.length
      ? [
          { type: "text", text: userText.trim() || "（发来一张图片）" },
          ...imgs.map((u) => ({ type: "image_url", image_url: { url: u } })),
        ]
      : userText;
    messages.push({ role: "user", content: userContent });

    // ── 工具循环 ──
    // 模型可能先发 tool_calls（比如"我得搜一下"），执行完把结果塞回去再问一次。
    // 没有工具、或模型不调用时，行为和原来完全一致（一轮结束）。
    const tools = Array.isArray(input.tools) ? input.tools : [];
    const onTool = typeof input.onTool === 'function' ? input.onTool : null;
    const useTools = tools.length > 0 && onTool;
    const MAX_ROUNDS = useTools ? 3 : 1;

    let json = null;
    let msg = null;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      // 最后一轮不再给工具：否则模型可能一直发 tool_calls，永远不说人话
      const isLastRound = round === MAX_ROUNDS - 1;

      // 已经调过工具、且到了最后一轮：明确禁止再调工具，逼它说人话
      if (isLastRound && round > 0) {
        messages.push({
          role: 'user',
          content: '（系统提醒：工具现在不可用，不要再调用任何工具。请直接用上面查到的内容回答，用你自己的话，简短一句话。）',
        });
      }

      const body = { model: this.model, messages, temperature: 1.1, stream: true };
      if (useTools && !isLastRound) {
        body.tools = tools;
        body.tool_choice = 'auto';
      }

      const res = await fetch(this.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        const rawErr = await res.text();
        throw new Error('模型返回 ' + res.status + '：' + rawErr.slice(0, 300));
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let fullContent = '';
      let firstSentences = [];
      let firstSentenceFired = false;
      let pendingChunk = '';
      let toolCalls = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ') || trimmed === 'data: [DONE]') continue;
          try {
            const chunk = JSON.parse(trimmed.slice(6));
            const delta = chunk.choices?.[0]?.delta || {};
            if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCalls[idx]) {
                  toolCalls[idx] = { id: tc.id || '', type: 'function', function: { name: tc.function?.name || '', arguments: '' } };
                }
                if (tc.id) toolCalls[idx].id = tc.id;
                if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
                if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
              }
            }

            const contentDelta = delta.content || '';
            if (contentDelta) {
              fullContent += contentDelta;
              // 抢发首句：未触发过、有回调
              // 像“等我下”、“我查查”这种自然反馈，真实女生去翻东西或搜索时也会先随口打一句让你等她，极具呼吸感与陪伴感
              if (!firstSentenceFired && typeof onSentence === 'function') {
                pendingChunk += contentDelta;
                // 识别句末标点或首个换行
                const m = pendingChunk.match(/^([\s\S]*?[。！？!?…~\n])\s*/);
                if (m && m[1].trim().length >= 4) {
                  const s = m[1].trim();
                  firstSentenceFired = true;
                  firstSentences.push(s);
                  try {
                    await onSentence(s);
                  } catch (e) {
                    console.error('   [流式首句回调出错]', e?.message || e);
                  }
                }
              }
            }
          } catch {}
        }
      }

      msg = { role: 'assistant', content: fullContent, tool_calls: toolCalls.filter(Boolean) };
      json = { choices: [{ message: msg }] };

      const calls = msg.tool_calls;
      if (!calls.length || !useTools || isLastRound) break;

      messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
      for (const call of calls) {
        const fn = call.function || {};
        let args = {};
        try { args = JSON.parse(fn.arguments || '{}'); } catch { args = {}; }
        let result;
        try {
          result = await onTool(fn.name, args);
        } catch (e) {
          result = '工具出错：' + (e?.message || e);
        }
        const brief = String(result).replace(/\s+/g, ' ').slice(0, 70);
        console.log('   [工具] ' + fn.name + '(' + JSON.stringify(args).slice(0, 40) + ') → ' + brief);
        let textResult = result;
        let toolImages = [];
        if (result && typeof result === 'object' && !Array.isArray(result)) {
          if (Array.isArray(result.images)) toolImages = result.images.filter(Boolean).slice(0, 3);
          textResult = result.text ?? '';
        }
        const rawTool = String(textResult);
        const MAX_TOOL_CHARS = 8000;
        const toolContent = rawTool.length > MAX_TOOL_CHARS
          ? rawTool.slice(0, MAX_TOOL_CHARS) + '\n…（工具结果过长已截断，剩余 ' + (rawTool.length - MAX_TOOL_CHARS) + ' 字符）'
          : rawTool;
        messages.push({
          role: 'tool',
          tool_call_id: call.id || fn.name,
          content: toolContent,
        });
        for (const u of toolImages) {
          messages.push({ role: 'user', content: [{ type: 'image_url', image_url: { url: u } }] });
        }
      }
    }

    let out = String(msg?.content || '').trim();

    // 兜底：调过工具，但模型最后一轮什么都没说 → 强制再问一次
    const usedTools = messages.some((m) => m.role === 'tool');
    if (!out && usedTools) {
      console.log('   [兜底] 调过工具但没输出，强制让它说一句');
      try {
        const retryMessages = messages.concat([{
          role: 'user',
          content: '别调工具了。就上面查到的内容，用你自己的话回一句，短的，像聊天那样。',
        }]);
        const r2 = await fetch(this.baseUrl + '/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.apiKey },
          body: JSON.stringify({ model: this.model, messages: retryMessages, temperature: 1.1, stream: false }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const raw2 = await r2.text();
        if (r2.ok) {
          const j2 = JSON.parse(raw2);
          out = String(j2.choices?.[0]?.message?.content || '').trim();
          if (out) msg = j2.choices?.[0]?.message;
        }
      } catch (e) {
        console.log('   [兜底] 重试失败：' + (e?.message || e));
      }
    }

    if (record) {
      this.memory.remember(userId, { name: userName, topic: (text || '').slice(0, 40) + ' → ' + out.slice(0, 40) });
      this.memory.logTurn({ where: key, who: userName || userId, text, reply: out });
    }
    return { text: out, reasoning: msg?.reasoning_content, raw: json };
  }

  /**
   * 让它自己写一条记忆（对应暴露给 AI 的 remember 工具）
   */
  remember(userId, { trait, fact, topic, pending, name }) {
    return this.memory.remember(userId, { trait, fact, topic, pending, name });
  }
}

export default Brain;
