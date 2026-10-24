/**
 * 联网能力 · web_search + web_fetch
 * 参考 DDDMUC/dsh-free-search (MIT) 的 bing 实现，剥离 DSH 框架依赖。
 *
 * 两个坑（来自上游注释，实测有效）：
 *   1. 不要发 mkt=zh-CN —— 部分线路会返回空 SERP 容器（b_algo=0）
 *   2. Bing 对可疑出口 IP 会间歇性返回 ~91KB 空页 —— NAS 家宽比云机干净
 */

const BING_URL = 'https://www.bing.com/search';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ', ensp: ' ', emsp: ' ' };

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return m; }
    })
    .replace(/&#(\d+);/g, (m, n) => {
      try { return String.fromCodePoint(Number(n)); } catch { return m; }
    })
    .replace(/&([a-zA-Z]+);/g, (m, k) => ENTITIES[k] ?? m);
}

function stripTags(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bing 把结果包成 bing.com/ck/a?u=a1<base64url>，解出真实地址 */
function extractBingUrl(href) {
  if (!href) return href;
  const url = decodeEntities(href);
  if (!/^https?:\/\/(www\.)?bing\.com\/ck\/a/i.test(url)) return url;
  try {
    const u = new URL(url).searchParams.get('u');
    if (!u) return url;
    const b64 = u.startsWith('a1') ? u.slice(2) : u;
    const decoded = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return /^https?:\/\//i.test(decoded) ? decoded : url;
  } catch {
    return url;
  }
}

/** 只允许公网 http(s)：挡住内网/回环地址。
 *  2026-10-24 加固：她在群里被指挥去「打开 http://192.168.1.1」时，
 *  等于把家里的内网当成代理用（SSRF）。 */
const PRIVATE_HOST_RE = /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127(\.\d+){3}|10(\.\d+){3}|192\.168(\.\d+){2}|169\.254(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2}|\[::1\]|\[?f[cd][0-9a-f]{2}:.*)$/i;

export function assertPublicUrl(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { throw new Error('链接格式不对'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('只支持 http(s) 链接');
  if (PRIVATE_HOST_RE.test(url.hostname.toLowerCase())) throw new Error('这个地址在内网，不方便打开');
  return url;
}

async function fetchHtml(url, { timeout = 12000, acceptLanguage = 'zh-CN,zh;q=0.9,en;q=0.8' } = {}) {
  assertPublicUrl(url);
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml',
      'accept-language': acceptLanguage,
    },
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.text();
}

/** 返回 [{title, url, snippet}] */
export async function webSearch(query, maxResults = 5) {
  const params = new URLSearchParams({ q: String(query) });
  const html = await fetchHtml(`${BING_URL}?${params}`);
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? [];
  const out = [];
  const seen = new Set();
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"/);
    if (!hrefMatch) continue;
    const url = extractBingUrl(hrefMatch[1]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const titleMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/);
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    out.push({
      title: titleMatch ? stripTags(titleMatch[1]) : '',
      url,
      snippet: snippetMatch ? stripTags(snippetMatch[1]).slice(0, 300) : '',
    });
    if (out.length >= maxResults) break;
  }
  return out;
}

/** 抓网页正文，压成纯文本 */
export async function webFetch(url, maxChars = 3000) {
  if (!/^https?:\/\//i.test(String(url))) throw new Error('不是 http(s) 链接');
  const html = await fetchHtml(url, { timeout: 15000 });
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const body =
    (html.match(/<main[\s\S]*?<\/main>/i) || html.match(/<article[\s\S]*?<\/article>/i) || [html])[0];
  const text = stripTags(body).slice(0, maxChars);
  return { title: stripTags(title), text };
}

/** 把搜索结果压成给模型看的短文本 */
export function formatSearchResults(query, rows) {
  if (!rows.length) return `搜索「${query}」没有任何结果。`;
  return (
    `搜索「${query}」的结果：\n` +
    rows
      .map((r, i) => `${i + 1}. ${r.title || '(无标题)'}\n   ${r.url}\n   ${r.snippet || ''}`)
      .join('\n')
  );
}

/** OpenAI tools 定义 */
// ── 天气：直接查 Open-Meteo，比搜索引擎靠谱得多 ────────────────
const WMO = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '小雨', 55: '中雨',
  56: '冻毛毛雨', 57: '冻雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '中阵雨', 82: '强阵雨',
  85: '小阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷暴伴冰雹',
};

async function geocode(name) {
  const url = 'https://geocoding-api.open-meteo.com/v1/search?name='
    + encodeURIComponent(name) + '&count=1&language=zh';
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const d = await r.json();
  return (d.results || [])[0] || null;
}

export async function getWeather({ city } = {}) {
  const want = String(city || '').trim();
  if (!want) return '要查哪个城市？';

  let place = await geocode(want);
  let usedName = want;
  let degraded = false;

  // 区县级查不到 → 逐字截断退到上级（"武汉新洲" → "武汉"）
  if (!place) {
    for (let cut = 1; cut <= 3; cut++) {
      if (want.length - cut < 2) break;
      const shorter = want.slice(0, want.length - cut);
      place = await geocode(shorter);
      if (place) { usedName = shorter; degraded = true; break; }
    }
  }

  if (!place) return `没找到「${want}」，说个市名试试（比如「武汉」）`;

  const wxUrl = 'https://api.open-meteo.com/v1/forecast'
    + '?latitude=' + place.latitude + '&longitude=' + place.longitude
    + '&current=temperature_2m,weather_code,relative_humidity_2m,apparent_temperature'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
    + '&timezone=Asia%2FShanghai&forecast_days=3';

  const wr = await fetch(wxUrl, { signal: AbortSignal.timeout(12000) });
  const wx = await wr.json();

  const where = [place.name, place.admin2, place.admin1].filter(Boolean).join('·');
  const lines = [];
  lines.push(degraded
    ? `【${where}】（「${want}」没单独数据，这是最近的）`
    : `【${where}】`);

  if (wx.current) {
    const c = wx.current;
    lines.push('现在 ' + Math.round(c.temperature_2m) + '°C，'
      + (WMO[c.weather_code] || '未知')
      + '，体感 ' + Math.round(c.apparent_temperature) + '°C'
      + '，湿度 ' + c.relative_humidity_2m + '%');
  }

  const d = wx.daily;
  if (d && Array.isArray(d.time)) {
    for (let i = 0; i < d.time.length; i++) {
      const tag = i === 0 ? '今天' : i === 1 ? '明天' : '后天';
      const rain = d.precipitation_probability_max ? d.precipitation_probability_max[i] : null;
      lines.push(tag + ' ' + (WMO[d.weather_code[i]] || '')
        + ' ' + Math.round(d.temperature_2m_min[i]) + '~' + Math.round(d.temperature_2m_max[i]) + '°C'
        + (rain != null ? '，降水概率 ' + rain + '%' : ''));
    }
  }
  return lines.join('\n');
}

export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        '搜索互联网。用于查询实时信息：新闻、天气、价格、比赛结果、人物、事实核查等。' +
        '你的训练数据可能过时，不确定的事先搜。\n' +
        '搜索词要点（实测）：用短的口语短语，例如「北京明天天气」「iPhone 17 价格」。' +
        '**不要**在搜索词里塞日期或年份（「北京天气 2026-10-21」会被当成导航查询，返回百科词条而不是天气页）。' +
        '**一次够了**：搜一次看结果，不够就用 web_fetch 打开其中一条。别反复换词重搜，那会很慢。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，用自然语言或短语都行' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: '打开一个网页，读取它的正文内容。当搜索结果的摘要不够、需要细节时用。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '完整 http(s) 链接' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查真实天气（当前温度、未来三天、降水概率）。凡是问天气、气温、下不下雨、要不要带伞，一律用这个，不要用 web_search。',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: '地名，最好带市，比如「武汉」「武汉新洲」「北京朝阳」' },
        },
        required: ['city'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'see',
      description:
        '看一张图片的内容。给一个图片的 http(s) 地址（封面、配图、截图），下载后真的看图再描述/讨论。' +
        '凡是"这个图是什么""看看这张封面"都用这个，不要用 web_fetch（它只读文字、看不到图）。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '图片的完整 http(s) 地址' },
        },
        required: ['url'],
      },
    },
  },
];

/** 下载一张图片转成 dataURL，供模型真正"看"（返回 {text, images}） */
export async function seeImage(url) {
  const u = String(url || '').trim();
  assertPublicUrl(u);
  const r = await fetch(u, {
    signal: AbortSignal.timeout(20000),
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (!r.ok) throw new Error('下载失败 HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) throw new Error('图片是空的');
  if (buf.length > 8 * 1024 * 1024) throw new Error('图片超过 8MB');
  const ct = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
  return { text: '图片已获取，我看看。', images: ['data:' + ct + ';base64,' + buf.toString('base64')] };
}

/** 执行一次工具调用 */
export async function runTool(name, args) {
  if (name === 'get_weather') return getWeather(args);

  if (name === 'web_search') {
    const q = String(args?.query || '').trim();
    if (!q) return '没给搜索词。';
    try {
      const rows = await webSearch(q, 5);
      return formatSearchResults(q, rows);
    } catch (e) {
      return `搜索失败：${e.message || e}`;
    }
  }
  if (name === 'web_fetch') {
    const u = String(args?.url || '').trim();
    if (!u) return '没给链接。';
    try {
      const { title, text } = await webFetch(u, 3000);
      return `【${title || u}】\n${text}`;
    } catch (e) {
      return `打开网页失败：${e.message || e}`;
    }
  }
  if (name === 'see') {
    const u = String(args?.url || '').trim();
    if (!u) return '没给图片链接。';
    try {
      return await seeImage(u);
    } catch (e) {
      return `看不了这张图：${e.message || e}`;
    }
  }
  return `未知工具：${name}`;
}
