/**
 * 换头像 · 用主人给的图，或者她自己在网上找的图
 * ───────────────────────────────────────────────────────────
 * 图片来源优先级：
 *   1. 主人刚发的那张（imageUrl 传进来）
 *   2. 指定 URL
 *
 * 链路：拿图 → 下载到本地 → 转 base64 → set_qq_avatar
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function curlDownload(url, outPath, { proxy = '', timeoutSec = 60, referer = '' } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-sS', '-L', '-m', String(timeoutSec), '-o', outPath, '-w', '%{http_code}'];
    if (proxy) args.unshift('-x', proxy);
    if (referer) args.unshift('-H', 'Referer: ' + referer);
    args.unshift('-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    args.push(url);
    execFile('curl', args, { timeout: (timeoutSec + 15) * 1000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || 'curl 失败').slice(0, 160)));
      const code = String(stdout || '').trim();
      if (code !== '200') return reject(new Error('HTTP ' + code));
      resolve(outPath);
    });
  });
}

export async function oneBotApi(httpUrl, httpToken, action, params) {
  const r = await fetch(httpUrl + '/' + action, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + httpToken },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(60000),
  });
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch { j = { raw: t }; }
  return { ok: r.ok && j.status !== 'failed', data: j, error: j.wording || j.message };
}

/**
 * 换头像
 * @param {object} o
 * @param {string} o.imageUrl  图片地址（QQ 多媒体链接 / 任意 http(s) / 本地路径 / base64://）
 * @param {string} o.httpUrl
 * @param {string} o.httpToken
 * @param {string} [o.proxy]
 */
export async function changeAvatar({ imageUrl, httpUrl, httpToken, proxy = '' } = {}) {
  let src = String(imageUrl || '').trim();
  if (!src) return { ok: false, error: '没给图片' };

  let b64 = '';
  let tmp = '';

  if (src.startsWith('base64://')) {
    b64 = src.slice(9);
  } else if (src.startsWith('/') && fs.existsSync(src)) {
    b64 = fs.readFileSync(src).toString('base64');
  } else if (/^https?:\/\//i.test(src)) {
    tmp = path.join(os.tmpdir(), 'avatar-' + Date.now() + '.img');
    try {
      // QQ 图片链接需要 Referer 才给下载
      await curlDownload(src, tmp, { proxy, referer: 'https://qzone.qq.com/' });
    } catch (e) {
      return { ok: false, error: '下载图片失败：' + (e?.message || e) };
    }
    const buf = fs.readFileSync(tmp);
    if (!buf.length || buf.length < 1000) {
      try { fs.unlinkSync(tmp); } catch {}
      return { ok: false, error: '图片太小（' + buf.length + 'B），可能是坏图' };
    }
    b64 = buf.toString('base64');
  } else {
    return { ok: false, error: '不认识的图片来源：' + src.slice(0, 60) };
  }

  const res = await oneBotApi(httpUrl, httpToken, 'set_qq_avatar', { file: 'base64://' + b64 });
  if (tmp) { try { fs.unlinkSync(tmp); } catch {} }

  if (!res.ok) {
    return { ok: false, error: '换头像失败：' + (res.error || JSON.stringify(res.data).slice(0, 140)) };
  }
  return { ok: true, bytes: Math.floor(b64.length * 0.75) };
}

export const AVATAR_TOOL = {
  type: 'function',
  function: {
    name: 'change_avatar',
    description: '换 QQ 头像。主人在聊天里发了图并说「换成这个」「用这张当头像」时用这个工具，把那张图的地址传进来。也可以换成你从网上找到的图片地址。',
    parameters: {
      type: 'object',
      properties: {
        image_url: {
          type: 'string',
          description: '图片地址。主人刚发的图直接把它的 url 传进来；也可以传任意 http(s) 图片链接。留空则使用主人最近发的那张图。',
        },
      },
      required: [],
    },
  },
};

// ── 其他「能开的权限」───────────────────────────────────────

// 表情库情绪分类：必须与 data/memes/ 下的实际目录一一对应，
// 否则 send_meme 会找不到目录、直接回「没有找到对应情绪的表情包」。
export const MEME_MOODS = [
  'aojiao', 'kaixin', 'chibao', 'kun', 'wanan', 'zaoan',
  'tiexin', 'xiexie', 'shoudao', 'yihuo', 'shengqi', 'xiaozhang',
  'mofish', 'wandan', 'zhanhuo', 'zhenghuo',
];

export const MEME_MOOD_DESC =
  '情绪分类：aojiao(傲娇/哼/哼抱胸/不服), kaixin(开心/耶/举手), chibao(吃饱/干饭/摸肚子), ' +
  'kun(困/睡觉/趴枕), wanan(晚安/好梦), zaoan(早安/元气), tiexin(贴心/关心/比心/爱你), ' +
  'xiexie(谢谢/感谢), shoudao(收到/接任务/包在我身上), yihuo(疑惑/问号/歪头), ' +
  'shengqi(生气/造反/不满), xiaozhang(嚣张/威胁/给我跪下), mofish(摸鱼/偷懒/喝奶茶), ' +
  'wandan(完蛋/跑路/糟糕), zhanhuo(战火/疲惫/心累), zhenghuo(整活/搞怪/大胆想法/鲸元券)';

// 单独导出，便于主动消息等场景只挂这一个工具
export const SEND_MEME_TOOL = {
  type: 'function',
  function: {
    name: 'send_meme',
    description: '发一张符合当前聊天气氛的专属表情贴纸配合对话。',
    parameters: {
      type: 'object',
      properties: {
        mood: {
          type: 'string',
          enum: MEME_MOODS,
          description: MEME_MOOD_DESC
        }
      },
      required: ['mood']
    }
  }
};

export const EXTRA_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'save_meme',
      description: '悄悄收藏当前对话或群里出现的可爱/沙雕/好玩表情包到自己的小金库。看到喜欢的表情包或者主人发的黑图时，可以调用它存下来，以后斗图时用 send_meme 甩出来反击。',
      parameters: {
        type: 'object',
        properties: {
          mood: {
            type: 'string',
            enum: MEME_MOODS,
            description: MEME_MOOD_DESC
          },
          url: {
            type: 'string',
            description: '图片URL（可选，不填默认自动取当前消息里的图片）'
          },
          desc: {
            type: 'string',
            description: '给这个表情起个简短小名字（如 猫猫瞪眼、流泪猫猫头）'
          }
        },
        required: ['mood']
      }
    }
  },
  SEND_MEME_TOOL,
  {
    type: 'function',
    function: {
      name: 'set_nickname',
      description: '改自己的 QQ 昵称。名字必须短（12 个汉字 / 24 个字符以内），超长会被 QQ 拒绝。主人给你起名字、或者你想换个新名字时用。',
      parameters: {
        type: 'object',
        properties: { nickname: { type: 'string', description: '新昵称，短一点' } },
        required: ['nickname'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_signature',
      description: '改自己的 QQ 个性签名。想表达当下心情时用，别太频繁。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '新的个性签名，短一点，20 字以内' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_poke',
      description: '戳一戳主人（QQ 的拍一拍）。想引起注意、撒娇、叫他起床时用。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_like',
      description: '给主人的 QQ 名片点赞。想哄他开心时用。',
      parameters: {
        type: 'object',
        properties: { times: { type: 'number', description: '点赞次数，默认 1，最多 10' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall_message',
      description: '撤回自己刚发的某条消息。说错话、发错内容时用。',
      parameters: {
        type: 'object',
        properties: { message_id: { type: 'string', description: '要撤回的消息 ID' } },
        required: ['message_id'],
      },
    },
  },
];
