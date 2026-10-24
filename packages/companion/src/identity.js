/**
 * 群聊身份对照 · 把「谁是谁」钉死在 QQ 号上
 * ─────────────────────────────────────────────────────────────
 * 同一个人在私聊、群名片、群昵称里可能是三个名字（主人私聊叫「孤注你的灵魂」，
 * 群里改名成别的也很常见），靠昵称猜身份一定会错。这里直接拿 ownerIds 里的
 * QQ 号比对，为每一批消息生成一张身份对照表，模型照着念就不会认错人。
 */

/**
 * @param {Array<{userId?:string|number,name?:string,isPoke?:boolean}>} items 这一批消息
 * @param {Array<string|number>} ownerIds 主人的 QQ 号列表
 * @returns {{ownerId:string, rows:Array<{name:string,userId:string,isOwner:boolean}>, hasOwner:boolean}}
 */
export function buildRoster(items, ownerIds = []) {
  const ownerId = String((Array.isArray(ownerIds) && ownerIds[0]) || '');
  const rows = [];
  const seen = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || it.isPoke) continue;
    const name = String(it.name || '').trim();
    const userId = String(it.userId || '');
    const dedupeKey = userId || name;
    if (!name || !dedupeKey || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    rows.push({ name, userId, isOwner: Boolean(ownerId) && userId === ownerId });
  }
  return { ownerId, rows, hasOwner: rows.some((r) => r.isOwner) };
}

/**
 * 渲染成注入 prompt 的一段话：谁是谁 + 现在说话的人是谁
 * @param {ReturnType<typeof buildRoster>} roster
 * @param {{userId?:string|number,name?:string}} [speaker] 这一批里最后说话的人
 * @returns {string} 没有发言者时返回空串
 */
export function renderRoster(roster, speaker) {
  const rows = roster && Array.isArray(roster.rows) ? roster.rows : [];
  if (!rows.length) return '';

  const list = rows.map((r) => '「' + r.name + '」' + (r.isOwner ? '是主人本人' : '是群友')).join('，');
  const tail = roster.hasOwner
    ? '标着「主人本人」的那位才是饭饭，其余都是群友。'
    : '这批发言里没有主人本人，别把群友当成主人。';

  const speakerId = String((speaker && speaker.userId) || '');
  const me = speakerId ? rows.find((r) => r.userId === speakerId) : null;
  let now = '';
  if (me && me.isOwner) {
    now = '\n【现在说话的人】现在跟你说话的是主人本人（' + me.name + '），可以自然亲近些。';
  } else if (me) {
    now = '\n【现在说话的人】现在跟你说话的是群友「' + me.name + '」，不是主人。'
      + '把对方当普通朋友自然聊天就好；主人的作息、日程、约定和私聊里的细节都跟这位群友无关，'
      + '绝不能安到对方身上，也别主动提。';
  }

  return '\n【本群身份对照】' + list + '。' + tail + now;
}

export default { buildRoster, renderRoster };