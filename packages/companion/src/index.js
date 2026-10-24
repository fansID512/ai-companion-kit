/**
 * companion · 命令行入口
 * ─────────────────────────────────────────────────────────────
 * 把各层拼起来跑：
 *
 *   OneBot(收消息) → Waker(要不要醒) → Brain(生成回复)
 *                                        ↓
 *                                   Humanizer(怎么发)
 *                                        ↓
 *                                   OneBot(发消息)
 *
 * 用法：
 *   node src/index.js --config ./config.json
 *   node src/index.js --config ./config.json --dry-run   只打印，不真发
 *   node src/index.js --check                            只检查角色卡
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Memory } from './memory.js';
import { Role } from './role.js';
import { Brain } from './brain.js';
import { Humanizer } from './humanize.js';
import { Waker } from './wake.js';
import { OneBot } from './transport-onebot.js';
import { Diary } from './diary.js';
import { Proactive } from './proactive.js';
import { changeAvatar, oneBotApi, AVATAR_TOOL, EXTRA_TOOLS } from './avatar.js';
import { NOTEBOOK_TOOLS, runNotebookTool } from './notebook.js';
import { TOOL_DEFS, runTool } from './search.mjs';
import { SendGuard, wrapBot } from './guard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 配置 ──────────────────────────────────────────────────────
export function loadConfig(explicitPath) {
  const file = explicitPath || path.join(__dirname, '..', 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { console.error('⚠️ 读不到 ' + file + '，用默认值（复制 config.example.json 改名即可）'); }
  const dir = path.dirname(path.resolve(file));
  const rel = (p, def) => (p ? path.resolve(dir, p) : path.join(dir, def));

  return {
    apiKey: cfg.apiKey || process.env.DEEPSEEK_API_KEY || '',
    baseUrl: cfg.baseUrl || 'https://api.deepseek.com/v1',
    model: cfg.model || 'deepseek-chat',

    roleCard: rel(cfg.roleCard, 'role.md'),
    roleMaxChars: cfg.roleMaxChars || 12000,
    dataDir: rel(cfg.dataDir, 'data'),

    onebot: {
      wsUrl: cfg.onebot?.wsUrl || 'ws://127.0.0.1:3001',
      httpUrl: cfg.onebot?.httpUrl || 'http://127.0.0.1:3000',
      accessToken: cfg.onebot?.accessToken || '',
      httpToken: cfg.onebot?.httpToken || '',
    },

    names: cfg.names || [],
    keywords: cfg.keywords || [],
    ownerIds: (cfg.ownerIds || []).map(String),
    groupWhitelist: (cfg.groupWhitelist || []).map(String),

    wake: {
      probability: cfg.wake?.probability ?? 0.05,
      groupAtOnly: cfg.wake?.groupAtOnly !== false,
      privateWindowMs: cfg.wake?.privateWindowMs ?? 1500,
      groupWindowMs: cfg.wake?.groupWindowMs ?? 6000,
      groupContextMs: cfg.wake?.groupContextMs ?? 0,
    },

    humanize: cfg.humanize || {},
    guard: cfg.guard || {},
    // 以前这两个字段没透出来 → cfg.proactive 恒为 {}（config.json 里的免打扰时段被静默忽略），
    // cfg.forwardOthers 恒 undefined（开关失效）
    proactive: cfg.proactive || {},
    forwardOthers: cfg.forwardOthers !== false,
    dryRun: process.argv.includes('--dry-run'),
  };
}

// ── 主程序 ────────────────────────────────────────────────────
async function main() {
  const cfgIdx = process.argv.indexOf('--config');
  const cfg = loadConfig(cfgIdx >= 0 ? process.argv[cfgIdx + 1] : null);

  console.log('════════ companion ════════');
  console.log('  模型      ' + cfg.model + ' @ ' + cfg.baseUrl);
  console.log('  角色卡    ' + cfg.roleCard);
  console.log('  数据目录  ' + cfg.dataDir);
  console.log('  OneBot    ' + cfg.onebot.wsUrl);
  console.log('  名字      ' + (cfg.names.join(' / ') || '（没配）'));
  console.log('  主人      ' + (cfg.ownerIds.join(', ') || '（没配）'));
  console.log('  群白名单  ' + (cfg.groupWhitelist.join(', ') || '空（所有群静音）'));
  console.log('  干跑      ' + (cfg.dryRun ? '是（不会真发）' : '否'));
  console.log('');

  const memory = new Memory({ dir: cfg.dataDir });
  const diary = new Diary({ dir: path.join(cfg.dataDir, 'diary') });
  const role = new Role({ cardPath: cfg.roleCard, maxChars: cfg.roleMaxChars });

  // 角色卡体检
  const lint = role.lint();
  if (!lint.ok) {
    console.log('⚠️ 角色卡检查：');
    lint.warn.forEach((w) => console.log('   · ' + w));
    console.log('');
  }
  if (process.argv.includes('--check')) { console.log('检查完毕。'); return; }
  if (!cfg.apiKey) console.log('⚠️ 没配 apiKey，模型调用会失败\n');

  const brain = new Brain({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model, role, memory });
  const human = new Humanizer(cfg.humanize);
  const waker = new Waker({
    names: cfg.names,
    keywords: cfg.keywords,
    ownerIds: cfg.ownerIds,
    probability: cfg.wake.probability,
    batchWindowMs: cfg.wake.groupWindowMs,
    groupWhitelist: cfg.groupWhitelist || [],
  });

  /** @type {Map<string, NodeJS.Timeout>} 每个会话的合并定时器 */
  const pending = new Map();
  const busy = new Set();   // 同一会话正在处理中，防止并行回复
  const retryTimers = new Map();   // 每个会话最多一个「忙时重试」定时器

  const guard = new SendGuard(cfg.guard);
  const rawBot = new OneBot({
    ...cfg.onebot,
    onMessage: (msg) => {
      // 第一次见到这个会话 → 给个默认策略
      if (!waker.configs.has(msg.key)) {
        waker.setConfig(msg.key, msg.isGroup
          ? {
              mode: 'diving',
              atMention: true,
              nameMention: !cfg.wake.groupAtOnly,
              // 问句不再单独唤醒：群里任何人问「怎么刷机」都会触发，等于替所有人答疑。
              // 只认明确冲她来的信号：@ / 引用 / 提到名字 / 拍一拍，
              // 以及提到名字后 contextWindowMs 窗口内的消息（交给模型判断语境）。
              question: false,
              poke: true,
              probability: cfg.wake.groupAtOnly ? 0 : cfg.wake.probability,
              // 有人提到她之后是否开启持续监听窗口。设为 0 时，回答完立刻潜水，不跟风接话。
              contextWindowMs: Number(cfg.wake.groupContextMs ?? 0),
            }
          : { mode: 'active', anyMessage: true });   // 私聊每条都理
      }

      const verdict = waker.shouldWake(msg);
      // 唤醒判定是硬闸：群白名单为空时，主人发的群消息也必须静音。
      if (!verdict.wake) {
        if (msg.isGroup) {
          console.log('[静音] ' + msg.name + '：' + msg.text.slice(0, 40));
        } else if (cfg.forwardOthers && cfg.ownerIds[0] && msg.text) {
          // 别人私聊 → 转给主人。不调模型、不回复对方，只做搬运。
          const line = '【' + msg.name + '】' + msg.text.slice(0, 200);
          console.log('[转发] ' + line.slice(0, 60));
          bot.send('private:' + cfg.ownerIds[0], line).catch(() => {});
        }
        return;
      }
      console.log('[醒·' + (verdict.reason || 'owner') + '] ' + msg.name + '：' + msg.text.slice(0, 60));

      // 合并窗口：等人把话说完
      // busy 锁：同一会话不允许两个 turn 并行，否则连发两条消息会各回一遍、内容重复

      const win = msg.isGroup ? cfg.wake.groupWindowMs : cfg.wake.privateWindowMs;
      clearTimeout(pending.get(msg.key));
      // 攒够 6 条就立刻处理，不等合并窗口（否则人一口气发一串，她一声不吭）
      const batched = waker.batch(msg);
      const waitMs = batched.ready ? 0 : win;

      const fire = (key) => {
        // 上一轮还在调模型/发消息 → 排队等它完成，绝不并行。
        // 每个会话只保留一个重试定时器：以前每来一条消息就多挂一条永不清理的 600ms 轮询链。
        if (busy.has(key)) {
          clearTimeout(retryTimers.get(key));
          retryTimers.set(key, setTimeout(() => { retryTimers.delete(key); fire(key); }, 600));
          return;
        }
        const items = waker.flush(key);
        if (!items.length) return;
        busy.add(key);
        handleTurn({ bot, brain, human, memory, waker, diary }, items, cfg)
          .catch((e) => console.error('[出错] ' + (e?.message || e)))
          .finally(() => busy.delete(key));
      };

      pending.set(msg.key, setTimeout(() => fire(msg.key), waitMs));
    },
  });

  const bot = wrapBot(rawBot, guard);

  process.on('unhandledRejection', (e) => console.error('[未处理] ' + (e?.message || e)));
  process.on('SIGINT', () => { console.log('\n再见。'); process.exit(0); });

  // ── 主动性：她自己会想找你 ──
  const ownerId = String(cfg.ownerIds?.[0] || '');
  let proactive = null;
  if (ownerId) {
    const pc = cfg.proactive || {};
    proactive = new Proactive({
      bot, brain, memory, diary, cfg,
      ownerKey: 'private:' + ownerId,
      ownerId,
      enabled: pc.enabled !== false,
      checkIntervalMs: (pc.checkIntervalMinutes ?? 20) * 60 * 1000,
      minGapMinutes: pc.minGapMinutes ?? 120,
      maxPerDay: pc.maxPerDay ?? 3,
      quietRanges: pc.quietRanges ?? [{ from: '01:00', to: '08:00' }],
    });
    proactive.start();
  }

  console.log('在跑了。Ctrl+C 退出。\n');
}

/** 处理一轮（可能是合并后的多条） */
export async function handleTurn({ bot, brain, human, memory, waker, diary }, items, cfg) {
  const last = items[items.length - 1];
  const key = last.key;
  let text = Waker.joinBatch(items);

  // 一批里可能混着不同来源：拍一拍和文字会各算一条，群里还可能合并了两个人的发言。
  // 所以「谁拍的我」和「最后说话的真人」要分开取，不能都用 last。
  const pokeItem = items.find((it) => it.isPoke) || null;
  const speaker = [...items].reverse().find((it) => !it.isPoke) || last;

  // 时间感：让她知道是凌晨还是下午，别在凌晨三点说"早安"；感知周末/工作日节律
  const now = new Date();
  const hh = now.getHours();
  const clockDesc =
    hh < 5 ? "凌晨" : hh < 8 ? "清晨" : hh < 12 ? "上午"
    : hh < 14 ? "中午" : hh < 18 ? "下午" : hh < 23 ? "晚上" : "深夜";
  const hhmm = String(hh).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
  const ymd =
    now.getFullYear() + "-" +
    String(now.getMonth() + 1).padStart(2, "0") + "-" +
    String(now.getDate()).padStart(2, "0");
  const dayOfWeek = now.getDay();
  const weekday = "日一二三四五六"[dayOfWeek];
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const isFridayNight = dayOfWeek === 5 && hh >= 18;
  const isSundayNight = dayOfWeek === 0 && hh >= 20;

  let rhythmDesc = '';
  if (isFridayNight) {
    rhythmDesc = '【周五夜晚/周末前夕】：通常是一周工作结束可以放松熬点小夜的时间，语气可以更欢快随性。';
  } else if (isSundayNight) {
    rhythmDesc = '【周日深夜/工作日前夕】：明天就要开始新一周的忙碌搬砖，适合温柔提醒早点歇下、养足精神。';
  } else if (isWeekend) {
    rhythmDesc = '【周末休息日】：不用早起搬砖通勤，可以赖床、摸鱼、轻松惬意。';
  } else {
    rhythmDesc = '【工作日/工作节律】：日常工作搬砖日，白天注意劳逸结合别太累，深夜若很晚了一定要体贴催睡。';
  }

  const when = "现在是" + clockDesc + "（" + hhmm + "），今天是 " + ymd + " 周" + weekday + "。\n" + rhythmDesc;

  if (pokeItem) {
    text = (text || '') + ' （' + (pokeItem.name || '他') + ' 在QQ里拍了拍你。你可以撒娇或傲娇地回一句，并直接调用 send_poke 工具反向戳他一下，给他真实的手机震动反馈！）';
  }

  // 自动检查与归档过期的约定/日程
  try {
    if (memory && speaker.userId) {
      memory.archiveExpiredPromises(speaker.userId);
    }
  } catch {}

  const situation = last.isGroup
    ? "你在一个 QQ 群里。" + when + "下面是群里刚连着说的几句话，最后一条是最新的。"
      + "\n【群聊隐私】这是多人场合：不要叫对方的名字或昵称（叫「你」就行），不要提 QQ 号、真名，"
      + "也不要跟群友说起你们是什么关系。就算他让你叫名字，也别叫，自然带过。"
      + "\n【要不要接话】先判断这些消息是不是在跟你说：@ 了你、提了你的名字、或者确实在问你 —— 就正常回；"
      + "如果只是群友之间的闲聊、跟你没关系，只输出 SKIP 两个字母，不要输出任何别的内容。"
    : "你在跟 " + speaker.name + " 私聊。" + when;

  const selfNote = (() => {
    let note = '';
    try { if (diary) note += diary.context(3, 3) || ''; } catch {}
    try {
      const sp = path.join(cfg.dataDir, 'self_state.json');
      if (fs.existsSync(sp)) {
        const sd = JSON.parse(fs.readFileSync(sp, 'utf8'));
        if (sd && sd.trait_for_self) {
          note += (note ? '\n' : '') + '【鲸鲸自己的小心思/个性执念（不盲从，做自己）】\n' + sd.trait_for_self;
        }
        // ── 模块二：情绪隔夜时间衰减（半衰期 12 小时） ──
        if (sd && sd.mood && sd.moodTime) {
          const ageHours = (Date.now() - Number(sd.moodTime)) / (3600 * 1000);
          const intensity = Math.pow(0.5, ageHours / 12);
          if (intensity >= 0.25) {
            note += (note ? '\n' : '') + `【心头残留的情绪(${sd.mood}) · 强度 ${(intensity * 100).toFixed(0)}%】\n因为"${sd.mood_reason || '这两天的事'}"，心里还残留着一点${sd.mood}的语气底色。自然带出，别生硬宣称。`;
          }
        }
      }
    } catch {}
    return note;
  })();
  // 收图：图片可能在这一批的**任意一条**里，不能只看 last（2026-10-22 实测：
  // 图先到、文字后到，被合并成一批，last 是那句「看我的战绩」，于是图被丢掉，
  // 她只看到 segsToText 拼出的「[图片]」两个字）。SnowLuma 的图片段带
  // data.url（multimedia.nt.qq.com.cn，rkey 有时效）；没 url 的再退到 get_image。
  const imgSegs = items
    .flatMap((it) => (Array.isArray(it.raw) ? it.raw : []))
    .filter((seg) => seg && (seg.type === "image" || seg.type === "mface"))
    .slice(0, 3);
  const imageUrls = [];
  for (const seg of imgSegs) {
    const d = seg.data || {};
    const direct = [d.url, d.file].find((u) => typeof u === "string" && /^(https?:|base64:\/\/)/.test(u));
    if (direct) { imageUrls.push(direct); continue; }
    const file = d.file || d.path;
    if (!file) { console.log("   [图片] 段里没有可用字段：" + JSON.stringify(d).slice(0, 200)); continue; }
    const r = await bot.api("get_image", { file });
    const got = r && r.ok && r.data && r.data.data;
    const url = got && (got.base64 ? "base64://" + got.base64 : (got.url || got.file));
    if (typeof url === "string" && url) imageUrls.push(url);
    else console.log("   [图片] get_image 没换到：" + JSON.stringify({ file, resp: r }).slice(0, 200));
  }
  const images = (await Promise.all(
    imageUrls.map(async (u) => {
      try {
        if (u.startsWith("base64://")) {
          const b64 = u.slice(9).trim();
          return b64.length > 64 ? "data:image/jpeg;base64," + b64 : null;
        }
        const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) return null;
        const buf = Buffer.from(await r.arrayBuffer());
        if (!buf.length || buf.length > 8 * 1024 * 1024) return null;
        const ct = r.headers.get("content-type") || "image/jpeg";
        return "data:" + ct.split(";")[0] + ";base64," + buf.toString("base64");
      } catch {
        return null;
      }
    })
  )).filter(Boolean);
  if (imgSegs.length) console.log("   [图片] 收到 " + imgSegs.length + " 张，成功转码 " + images.length + " 张");

  // 表情包与图片主动感知闭环：如果对方发送了图片/表情，引导鲸鲸感知并可自主收藏
  const hasIncomingImages = Array.isArray(images) && images.length > 0;
  if (hasIncomingImages) {
    text = (text || '') + ' （对方发来了图片/表情。如果你觉得这张图有趣、好玩、可爱或者适合斗图，可以调用 save_meme 工具把它存进你的对应心情小金库；如果觉得时机合适，也可以顺手甩一张你的专属表情 send_meme 进行斗图互动！）';
  }

  // 工具集：搜索 / 天气 / 换头像 / 改签名 / 拍一拍 / 点赞 / 撤回 / 小本本
  const tools = [...TOOL_DEFS, AVATAR_TOOL, ...EXTRA_TOOLS, ...NOTEBOOK_TOOLS];
  const httpUrl = cfg.onebot.httpUrl;
  const httpToken = cfg.onebot.httpToken || cfg.onebot.accessToken;

  const onTool = async (name, args = {}) => {
    try {
      if (name === 'change_avatar') {
        const src = args.image_url || imageUrls.find((u) => /^https?:/.test(u)) || '';
        if (!src) return '主人这条消息里没有图片，也没有给链接。让他发张图或者说个图片地址。';
        const r = await changeAvatar({ imageUrl: src, httpUrl, httpToken });
        return r.ok ? ('换好了，现在这张头像是我了。' + Math.round(r.bytes / 1024) + 'KB')
                    : ('没换成：' + r.error);
      }
      if (name === 'set_nickname') {
        const t2 = String(args.nickname || '').trim().slice(0, 24);
        if (!t2) return '昵称不能是空的';
        const r = await oneBotApi(httpUrl, httpToken, 'set_qq_profile', { nickname: t2 });
        return r.ok ? ('昵称改成「' + t2 + '」了') : ('没改成：' + r.error);
      }
      if (name === 'set_signature') {
        const t = String(args.text || '').trim().slice(0, 40);
        if (!t) return '签名不能是空的';
        const r = await oneBotApi(httpUrl, httpToken, 'set_qq_profile', { personal_note: t });
        return r.ok ? ('签名改成「' + t + '」了') : ('没改成：' + r.error);
      }
      if (name === 'save_meme') {
        const targetUrl = args.url || imageUrls.find((u) => /^https?:/.test(u)) || '';
        if (!targetUrl) return '当前消息里没有图片可以收藏。';
        const mood = String(args.mood || 'other').toLowerCase().trim();
        const desc = String(args.desc || 'pic').replace(/[^a-zA-Z0-9_一-龥]/g, '').slice(0, 16);
        const memeDir = path.join(cfg.dataDir, 'memes', mood);
        if (!fs.existsSync(memeDir)) fs.mkdirSync(memeDir, { recursive: true });

        try {
          const res = await fetch(targetUrl, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0' } });
          if (!res.ok) return '图片下载失败：HTTP ' + res.status;
          const buf = Buffer.from(await res.arrayBuffer());
          if (!buf.length || buf.length > 8 * 1024 * 1024) return '图片太大或为空，没存下。';
          
          const crypto = await import('node:crypto');
          const hash = crypto.createHash('md5').update(buf).digest('hex').slice(0, 8);
          const ct = res.headers.get('content-type') || 'image/png';
          let ext = '.png';
          if (ct.includes('gif')) ext = '.gif';
          else if (ct.includes('jpeg') || ct.includes('jpg')) ext = '.jpg';
          else if (ct.includes('webp')) ext = '.webp';

          const savePath = path.join(memeDir, `${hash}_${desc}${ext}`);
          fs.writeFileSync(savePath, buf);
          console.log(`   [表情包] 鲸鲸偷偷收藏了一张 [${mood}] 表情: ${desc}${ext}`);
          return `（太棒啦，已经把这张表情悄悄存进你的 [${mood}] 小金库了！以后斗图可以随时发出来！）`;
        } catch (e) {
          return '收藏表情包失败：' + (e?.message || e);
        }
      }
      if (name === 'send_meme') {
        const mood = String(args.mood || 'kaixin').toLowerCase().trim();
        const memeDir = path.join(cfg.dataDir, 'memes', mood);
        let targetFile = '';
        if (fs.existsSync(memeDir)) {
          const files = fs.readdirSync(memeDir).filter(f => !f.startsWith('.'));
          if (files.length) {
            const chosen = files[Math.floor(Math.random() * files.length)];
            targetFile = path.join(memeDir, chosen);
          }
        }
        if (!targetFile) {
          return '没有找到对应情绪的表情包';
        }
        try {
          const b64 = fs.readFileSync(targetFile).toString('base64');
          await bot.sendImage(key, 'base64://' + b64);
          console.log(`   [表情包] 已发出 [${mood}] 专属表情`);
          return `（已经将你的 [${mood}] 可爱表情包发到聊天框里了）`;
        } catch (e) {
          return '表情包发送失败：' + (e?.message || e);
        }
      }
      // 兼容可能出现的重复拼接或带前缀工具名容错
      const cleanToolName = String(name || '').replace(/^(send_poke)+$/, 'send_poke');
      if (cleanToolName === 'send_poke') {
        // 戳回去要戳「拍我的那个人」，不是这批里最后发言的人
        const who = pokeItem || speaker;
        const action = who.isGroup ? 'group_poke' : 'friend_poke';
        const params = who.isGroup 
          ? { group_id: Number(who.groupId), user_id: Number(who.userId) }
          : { user_id: Number(who.userId) };
        const r = await oneBotApi(httpUrl, httpToken, action, params);
        return r.ok ? '反手戳了他一下（已触发手机震动）' : ('没戳成：' + r.error);
      }
      if (name === 'send_like') {
        const times = Math.max(1, Math.min(Number(args.times) || 1, 10));
        const r = await oneBotApi(httpUrl, httpToken, 'send_like', { user_id: Number(speaker.userId), times });
        return r.ok ? ('点了 ' + times + ' 个赞') : ('点赞没成：' + r.error);
      }
      if (name === 'recall_message') {
        const mid = String(args.message_id || '').trim();
        if (!mid) return '要撤回哪条？给我消息 ID';
        const r = await oneBotApi(httpUrl, httpToken, 'delete_msg', { message_id: mid });
        return r.ok ? '撤回了' : ('撤回失败：' + r.error);
      }
      // 小本本与心锚记忆：记下/划掉/翻看答应过的事 / 刻进核心回忆
      if (name === 'note_promise' || name === 'finish_promise' || name === 'list_promises' || name === 'record_core_memory') {
        return runNotebookTool(name, args, { memory, userId: speaker.userId });
      }
    } catch (e) {
      return '工具出错：' + (e?.message || e);
    }
    // 其余（web_search / web_fetch / get_weather）交给 search.mjs
    return runTool(name, args);
  };

  let streamedSent = false;
  const onSentence = async (s) => {
    // 只有在私聊且非干跑模式下才执行真正的流式秒发首句
    if (!last.isGroup && !cfg.dryRun && s) {
      console.log('   [流式秒回首句] → ' + s);
      await bot.send(key, s);
      streamedSent = true;
    }
  };

  const replyResult = await brain.reply({
    key,
    userId: speaker.userId,
    userName: speaker.name,
    text,
    situation,
    selfNote,
    images,
    tools,
    onTool,
    onSentence,
  });
  const out = replyResult.text;
  // 群聊里模型可能判断"这不是在跟我说"，输出 SKIP → 不发，也不消耗发送额度
  const skip = /^SKIP$/i.test(String(out || '').trim());
  if (!out || (last.isGroup && skip)) {
    console.log(last.isGroup && skip ? '   （群里这条跟她无关，SKIP）' : '   （没说话）');
    return;
  }

  if (cfg.dryRun) { console.log('   [干跑] 会说：' + out); return; }

  // 提取当前心情（若有）
  let currentMood = '';
  try {
    const sp = path.join(cfg.dataDir, 'self_state.json');
    if (fs.existsSync(sp)) {
      const sd = JSON.parse(fs.readFileSync(sp, 'utf8'));
      if (sd && sd.mood) currentMood = sd.mood;
    }
  } catch {}

  const r = await human.say(out, {
    setTyping: (on) => bot.setTyping(key, on),
    send: (m) => bot.send(key, m),
    // 群聊一次最多分 6 条（群里 20 条会刷屏）；私聊不传 → 用全局 burstMax(20)
    max: last.isGroup ? 6 : undefined,
    mood: currentMood,
    skipFirst: streamedSent,
  });
  console.log('   发出 ' + (r.sent + (streamedSent ? 1 : 0)) + ' 条：' + (streamedSent ? '[首句流式已发] | ' : '') + r.parts.map((p) => p.slice(0, 18)).join(' | '));
  waker.wake(key);
  // 互动计数记在真正发言的人身上：群里一批可能有多个人说话，不能只记最后一条
  const touched = new Set();
  for (const it of items) {
    if (it.isPoke) continue;
    if (!it.userId || touched.has(it.userId)) continue;
    touched.add(it.userId);
    memory.touch(it.userId, { name: it.name });
  }
}

// 直接跑才启动；被 import 时不启动
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error('启动失败：' + (e?.stack || e)); process.exit(1); });
}
