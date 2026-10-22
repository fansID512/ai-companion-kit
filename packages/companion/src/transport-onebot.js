/**
 * 传输层 · OneBot v11 适配
 * ─────────────────────────────────────────────────────────────
 * OneBot v11 是一个被广泛实现的机器人协议：
 *   NapCat / Lagrange / LLOneBot / go-cqhttp / SnowLuma 都实现了它。
 *
 * 这一层负责：
 *   - 连上 OneBot 的 WebSocket，收消息
 *   - 把 OneBot 的原始事件翻译成统一格式
 *   - 提供「发消息」「发图」「正在输入」等动作
 *
 * 如果你想接别的平台（微信/Telegram/自研），照着这个接口再写一个就行。
 */

/** 把 OneBot 消息段数组拼成纯文本 */
function segsToText(segs) {
  if (!Array.isArray(segs)) return String(segs || '');
  const out = [];
  for (const s of segs) {
    if (!s) continue;
    switch (s.type) {
      case 'text': out.push(s.data?.text || ''); break;
      case 'at': out.push('@' + (s.data?.qq || '')); break;
      case 'image': out.push('[图片]'); break;
      case 'mface': out.push('[动画表情]'); break;
      case 'face': out.push('[表情]'); break;
      case 'reply': break;   // 引用单独处理
      default: break;
    }
  }
  return out.join('').trim();
}

/** 从消息段里找引用 */
function findReply(segs) {
  if (!Array.isArray(segs)) return null;
  for (const s of segs) if (s?.type === 'reply') return String(s.data?.id || '');
  return null;
}

export class OneBot {
  /**
   * @param {object} opts
   * @param {string} opts.wsUrl       例如 ws://127.0.0.1:3001
   * @param {string} [opts.httpUrl]   例如 http://127.0.0.1:3000（发消息用）
   * @param {string} [opts.accessToken]
   * @param {(msg:object)=>void} [opts.onMessage]
   */
  constructor({ wsUrl, httpUrl, accessToken = '', httpToken = '', onMessage }) {
    this.wsUrl = wsUrl;
    this.httpUrl = (httpUrl || '').replace(/\/+$/, '');
    this.accessToken = accessToken;
    // SnowLuma 的 WS / HTTP 是两个不同的 token，NapCat 是同一个
    this.httpToken = httpToken || accessToken;
    this.onMessage = onMessage;
    this.selfId = '';
    this.ws = null;
    this.connected = false;
    this.#connect();
  }

  #headers(forHttp = false) {
    const h = {};
    const token = forHttp ? this.httpToken : this.accessToken;
    if (token) h.Authorization = 'Bearer ' + token;
    return h;
  }

  async #connect() {
    const { WebSocket } = await import('ws').catch(() => ({ WebSocket: globalThis.WebSocket }));
    const sock = new WebSocket(this.wsUrl, { headers: this.#headers() });
    this.ws = sock;

    sock.on?.('open', () => { this.connected = true; console.log('[onebot] 已连接 ' + this.wsUrl); });
    sock.on?.('close', () => {
      this.connected = false;
      console.log('[onebot] 断开，5 秒后重连');
      setTimeout(() => this.#connect(), 5000);
    });
    sock.on?.('error', (e) => console.log('[onebot] 出错 ' + (e?.message || e)));
    sock.on?.('message', (data) => {
      let ev;
      try { ev = JSON.parse(String(data)); } catch { return; }
      this.#handle(ev);
    });
  }

  #handle(ev) {
    if (ev.post_type === 'meta_event' && ev.meta_event_type === 'lifecycle') {
      this.selfId = String(ev.self_id || '');
      return;
    }
    // ── 拍一拍（notice/notify/poke）──
    // OneBot v11 形状：{ post_type:'notice', notice_type:'notify', sub_type:'poke',
    //                    group_id?, user_id, target_id }
    // poke 不是 message 事件，下面那句 `post_type !== 'message'` 会把它整个丢掉，
    // 于是 wake.js 里的 `c.poke && msg.isPoke` 永远不成立
    // （2026-10-22 实测：2021Pro 群被拍拍完全没反应）。
    if (ev.post_type === 'notice' && ev.notice_type === 'notify' && ev.sub_type === 'poke') {
      if (ev.self_id) this.selfId = String(ev.self_id);
      const me = String(this.selfId || '');
      const target = String(ev.target_id || '');
      // 只处理「拍的是我」；没给 target_id 的实现按拍我处理
      if (target && me && target !== me) return;

      const pokeGroup = Boolean(ev.group_id);
      this.onMessage?.({
        key: pokeGroup ? 'group:' + ev.group_id : 'private:' + ev.user_id,
        isGroup: pokeGroup,
        groupId: pokeGroup ? String(ev.group_id) : '',
        userId: String(ev.user_id),
        name: String(ev.sender?.card || ev.sender?.nickname || ev.user_id),
        // 给模型一个能读懂的动作描述，否则 text 为空、模型不知道发生了什么
        text: '[拍了拍我]',
        raw: [],
        isAtMe: false,
        isQuoteMe: false,
        replyTo: null,
        messageId: '',
        time: (ev.time || Math.floor(Date.now() / 1000)) * 1000,
        isPoke: true,
      });
      return;
    }

    if (ev.post_type !== 'message') return;
    if (ev.self_id) this.selfId = String(ev.self_id);

    const isGroup = ev.message_type === 'group';
    const segs = ev.message;
    const replyId = findReply(segs);
    // 有没有 @ 我
    const atMe = Array.isArray(segs) && segs.some((s) => s?.type === 'at' && String(s.data?.qq) === this.selfId);

    const msg = {
      key: isGroup ? 'group:' + ev.group_id : 'private:' + ev.user_id,
      isGroup,
      groupId: isGroup ? String(ev.group_id) : '',
      userId: String(ev.user_id),
      name: String(ev.sender?.card || ev.sender?.nickname || ev.user_id),
      text: segsToText(segs),
      raw: segs,
      isAtMe: atMe,
      isQuoteMe: false,   // 需要额外查询被引用消息的发送者，见 resolveQuote
      replyTo: replyId,
      messageId: String(ev.message_id || ''),
      time: (ev.time || Math.floor(Date.now() / 1000)) * 1000,
    };
    this.onMessage?.(msg);
  }

  /** 调 OneBot 的 HTTP API */
  async api(action, params = {}) {
    if (!this.httpUrl) return { ok: false, error: '没配 httpUrl' };
    try {
      const r = await fetch(this.httpUrl + '/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.#headers(true) },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(30000),
      });
      const t = await r.text();
      let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
      return { ok: r.ok && j.status !== 'failed', data: j, error: j.message || j.wording };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  /** 发一条纯文本 */
  send(key, text, { atUserId } = {}) {
    const isGroup = key.startsWith('group:');
    const id = key.split(':')[1];
    let message = String(text);
    if (atUserId) message = '[CQ:at,qq=' + atUserId + '] ' + message;
    return isGroup
      ? this.api('send_group_msg', { group_id: id, message })
      : this.api('send_private_msg', { user_id: id, message });
  }

  /** 发一张图（本地文件或 URL） */
  sendImage(key, file) {
    const isGroup = key.startsWith('group:');
    const id = key.split(':')[1];
    const message = '[CQ:image,file=' + file + ']';
    return isGroup
      ? this.api('send_group_msg', { group_id: id, message })
      : this.api('send_private_msg', { user_id: id, message });
  }

  /**
   * 「正在输入…」
   * OneBot 扩展接口，部分实现支持（SnowLuma 是 set_input_status）
   */
  async setTyping(key, on) {
    const isGroup = key.startsWith('group:');
    const id = key.split(':')[1];
    return this.api('set_input_status', isGroup
      ? { group_id: id, event_type: on ? 1 : 0 }
      : { user_id: id, event_type: on ? 1 : 0 });
  }

  /** 查一条消息是谁发的（用来判断引用的是不是我） */
  async whoSent(messageId) {
    const r = await this.api('get_msg', { message_id: messageId });
    return r.ok ? String(r.data?.data?.user_id || '') : '';
  }
}

export { segsToText };
export default OneBot;
