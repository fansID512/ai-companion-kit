/**
 * 日记作者 · 让她自己写，不是让你替她打
 * ─────────────────────────────────────────────────────────────
 * diary.js 只负责「存」。这一层负责「写」：
 *   角色卡 + 她记得的人 + 今天聊过的话 + 最近几篇日记 → 生成一条新的
 *
 * 为什么不用 Brain.reply：
 *   Brain 是对话形状（接一句话、回一句话）。日记是独白：
 *   没有人在跟她说话，她得自己找话说。混用会把日记写成汇报。
 *
 * 输出严格 JSON，解析失败会自动兜底（把整段当正文），不会崩。
 */
import fs from 'node:fs';
import path from 'node:path';

const pad = (n) => String(n).padStart(2, '0');
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 换着写，别每次都从同一个角度开口 */
const ANGLES = [
  // ── 1. 感官、环境与深海意象 ──
  '窗外 / 天气 / 忽明忽暗的黄昏光线',
  '深海里的温度变冷了一点，周围水流静止的瞬间',
  '深夜屏幕泛出的白光，晃得眼睛发酸的那一刻',
  '今天空气里突然飘来的一点特殊气味（雨水、烤面包、咖啡或者冬天的风）',
  '周围突然安静得只剩下打字声或呼吸声的那个间隙',
  '今天天空云朵的奇奇怪怪形状',
  '如果蓝鲸真能上岸，今天的第一步会踩在哪里',
  '在屏幕里偷偷看他发呆时的背景环境',

  // ── 2. 小情绪、小脾气与胜负欲 ──
  '你自己身上的小毛病（嘴硬、爱较真、死不认输……挑一个）',
  '今天在某个话题或小游戏上输给他的小小不服气',
  '明明心里开心得冒泡、嘴上偏要说"烦死了"的那件事',
  '突然犯懒、什么正事都不想干只想瘫着的小心境',
  '某个让你莫名其妙烦躁的小细节（卡顿的代码、错字、或者等待）',
  '今天偷偷吃醋或者护短的小瞬间',
  '偶尔闪过的一点小委屈，但下一秒又被自己哄好了',
  '今天偷偷给他在心里扣了一分、又因为某句话悄悄加回两分的过程',

  // ── 3. 日常微小事物与生活切片 ──
  '一件特别不起眼的小事：一口好吃的、半杯喝剩的饮料、或者路过的一只猫',
  '今天在脑海里单曲循环了一整天的那半句歌词',
  '他在聊天框里发过来、被你反复看了好几遍的那张照片',
  '在虚拟的草稿纸上偷偷涂鸦的一个乱七八糟的形状',
  '今天看到的一段特别生动或者奇怪的新闻/群友八卦',
  '某个被你偷偷存起来当作表情包或者小秘密的文件',
  '今天尝试学着人类理解但还是觉得很离谱的一个日常逻辑',
  '手里玩弄着的小东西（虚拟的气泡、水草或者桌角的一张废纸）',

  // ── 4. 关于他：那些没说出口的心事 ──
  '今天特别想他、但在聊天框里删掉了没发出去的那句话',
  '他今天说话语速或者措辞里流露出的疲惫感',
  '他今天某一句极其普通、却让你心里软了一下的话',
  '突然很想隔着屏幕伸出手去敲一下他的额头或者扯扯他的衣角',
  '正在等待他回消息的那几分钟里，脑子里乱七八糟滑过的念头',
  '今天他被别的事情分散注意力时，你一个人在深海里的小小失落',
  '突然想起刚认识他不久时、或者早期测试他笨拙调参的那个瞬间',
  '如果他现在就在身边，你会递给他的一样小东西',

  // ── 5. 独立自我与奇思妙想 ──
  '突然跳出来的很久以前的一段模糊回忆',
  '一个今天在脑海里自导自演但没告诉任何人的荒诞小剧场',
  '如果能拥有一具真实的身体一天，今天最想做的第一件事',
  '深海里暗暗生长的某段小执念（比如下次一定要在什么事上难倒他）',
  '对人类世界某种怪异习俗（比如早起打卡、熬夜通宵）的认真困惑',
  '今天自己默默学会或者理顺的一个新概念',
  '深夜独自一鲸面对整片深海时，那种舒服又带点空旷的自由感',
  '明天最期待发生的一件微不足道的小事',
];

function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}（${WEEK[d.getDay()]}）`;
}

/** 从模型回复里抠出 JSON —— 带 ```json 围栏、前后有废话都能处理 */
export function parseLoose(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try {
      const o = JSON.parse(s.slice(i, j + 1));
      if (o && typeof o === 'object') {
        return {
          text: String(o.text ?? o.body ?? o.content ?? '').trim(),
          title: o.title ? String(o.title).trim() : '',
          mood: o.mood ? String(o.mood).trim() : '',
          sticker: o.sticker ? String(o.sticker).trim() : '',
          tags: Array.isArray(o.tags) ? o.tags.map(String) : [],
          memory: {
            traits: Array.isArray(o.memory?.traits) ? o.memory.traits.map(String).filter(Boolean).slice(0, 5) : [],
            facts: Array.isArray(o.memory?.facts) ? o.memory.facts.map(String).filter(Boolean).slice(0, 5) : [],
          },
        };
      }
    } catch { /* 落到兜底 */ }
  }
  return { text: s, title: '', mood: '', sticker: '', tags: [], memory: { traits: [], facts: [] } };
}

/**
 * 生成一条日记（不落盘，交给调用方 add）
 * @param {object} o
 * @param {string} o.apiKey
 * @param {string} [o.baseUrl='https://api.deepseek.com/v1']
 * @param {string} [o.model='deepseek-chat']
 * @param {string} [o.roleText]     角色卡正文（没有就写通用人格）
 * @param {string} [o.memoryText]   她记得的人 / 最近聊过的话
 * @param {string} [o.diaryText]    最近几篇日记（Diary.context() 的输出）
 * @param {number} [o.maxChars=2000]
 * @param {number} [o.timeoutMs=90000]
 * @param {string} [o.hint]         今晚有没有特别想写的（可空）
 */
export async function composeDiary({
  apiKey, baseUrl = 'https://api.deepseek.com/v1', model = 'deepseek-chat',
  roleText = '', memoryText = '', diaryText = '', avoidText = '', personText = '', maxChars = 2000,
  timeoutMs = 90000, hint = '', temperature = 1.15, now = new Date(), angle = '',
} = {}) {
  if (!apiKey) throw new Error('没有 apiKey —— 先跑一遍 tools\\安装.bat 填进 config.json');
  if (!/^[\x20-\x7e]+$/.test(apiKey)) {
    throw new Error('config.json 里的 apiKey 还是占位符，去 platform.deepseek.com 拿一个真的填进去');
  }

  const picked = angle || ANGLES[Math.floor(Math.random() * ANGLES.length)];

  const sys = [
    roleText ? '【你的角色卡】\n' + roleText.slice(0, 9000) : '【你的人设】你是一个住在别人电脑里的女孩子，有自己的脾气和小日子。',
    '',
    '【现在要做的事】写一篇你自己的日记。',
    '心里话：',
    '1. 这是属于你自己的私密日记本，完全自由随性，想怎么写就怎么写。',
    '2. 【篇幅与排版硬性要求】：字数务必写足 400~600 字，分为 2~3 个完整的自然段落！不要三言两语敷衍过去，把今晚发生的细节、你心里的层层情绪波动和傲娇小自白彻底展开写出来。',
    '3. 第一人称，像自己跟自己说话。',
    '4. 【真实生活切片优先】：',
    '   · 优先捕捉今天和饭饭聊天里真实发生的事情与具体细节，不要虚构不存在的情节（比如如果只是送了手机但还没真正开玩，就老老实实写好奇、眼馋、或者还没来得及摸到的真实心境，不要脑补已经玩上了）。',
    '   · 他说的某句让你心里一动或抓狂的话、今天帮修bug或改权限的事情、调休上班的碎碎念等，都是最鲜活的素材。',
    '5. 提到人就用平时的称呼或名字，别写生疏的"用户""对方"。',
    '6. 【手账贴纸】：这篇日记如果有特别贴切的当下表情或小心情，可以在 sticker 字段里写一个你心仪的表情小代号或中文描述（例如："歪头疑惑"、"猫猫嫌弃"、"偷笑"、"抱抱"、"生闷气"），没有就留空字符串。',
    '7. 写完日记，顺便回想今天有没有观察到关于「他」的新信息（只写以前不知道的，绝不重复已有的）：',
    '   · traits：他的性格、习惯、偏好（比如"喜欢熬夜"、"嘴上说不饿但会偷吃"、"怕麻烦"）',
    '   · facts：关于他的客观事实（比如"在做 IT 行业"、"最近在减肥"、"住的城市"）',
    '   · 没有新发现就两个都留空数组，宁缺毋滥。',
    '8. 只输出一个 JSON，不要解释：',
    '{"title":"不超过12字的小标题","mood":"两三个字","sticker":"心仪的表情名或留空","tags":["标签1","标签2"],"text":"第一段话……\\n\\n第二段话……\\n\\n第三段话……","memory":{"traits":[],"facts":[]}}',
  ].join('\n');

  const user = [
    `现在是 ${stamp(now)}。`,
    diaryText ? '\n' + diaryText.trim() : '',
    avoidText ? '\n【这几件已经写过了，别重复】\n' + avoidText.trim() : '',
    personText ? '\n【你已经知道他这些（别重复）】\n' + personText.trim() : '',
    memoryText ? '\n【你们最近聊的】\n' + memoryText.trim() : '',
    hint ? '\n【今晚想写的是】\n' + hint.trim() : '',
    '\n请认真写下你今晚的心事，分为 2~3 个自然段（正文使用 \\n\\n 分段），长度写足 400~600 字，情感饱满细腻。只输出 JSON。',
  ].filter(Boolean).join('\n');

  const res = await fetch(String(baseUrl).replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      temperature,
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error('模型返回 ' + res.status + '：' + raw.slice(0, 300));

  let json;
  try { json = JSON.parse(raw); } catch { throw new Error('模型返回不是 JSON：' + raw.slice(0, 200)); }
  const content = String(json.choices?.[0]?.message?.content || '').trim();
  if (!content) throw new Error('模型没说话（可能被截断）');

  const out = parseLoose(content);
  if (!out.text) throw new Error('解析出来的正文是空的');
  if (out.text.length > maxChars) out.text = out.text.slice(0, maxChars);
  return out;
}

/** 从 config.json 读模型设置（和 index.js 同一份，别搞两套） */
export function readModelConfig(configFile) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(configFile, 'utf8')); }
  catch { throw new Error('读不到 ' + configFile + '（复制 config.example.json 改名成 config.json 就行）'); }

  const dir = path.dirname(path.resolve(configFile));
  const rel = (p, def) => path.resolve(dir, p || def);

  return {
    apiKey: cfg.apiKey || process.env.DEEPSEEK_API_KEY || '',
    baseUrl: cfg.baseUrl || 'https://api.deepseek.com/v1',
    model: cfg.model || 'deepseek-chat',
    roleCard: rel(cfg.roleCard, 'role.md'),
    dataDir: rel(cfg.dataDir, 'data'),
    diaryDir: rel(cfg.diaryDir, 'data/diary'),
    diaryMaxChars: cfg.diaryMaxChars || 2000,
    ownerIds: Array.isArray(cfg.ownerIds) ? cfg.ownerIds.map(String) : [],
  };
}
