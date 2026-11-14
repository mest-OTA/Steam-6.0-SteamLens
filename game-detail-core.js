/**
 * SteamLens · 游戏详情（玩法 + 成就）
 *
 * 取数优先级（按用户要求）：
 *  1) 永久缓存 data/game-details/<appid>.json —— 玩法一旦写入就永不过期，「以后打开永远是这个」。
 *  2) Steam 本地文件（只读，不需要联网、不需要 API Key）：
 *     - appcache/stats/UserGameStatsSchema_<appid>.bin  → 成就名称 + 说明 + 图标
 *     - appcache/stats/UserGameStats_<uid>_<appid>.bin  → 我账号的成就解锁时间（精确到秒）
 *     - appinfo.vdf / httpcache / librarycache / appmanifest → 游戏名、封面、以及「临时文件里的描述」
 *  3) 联网搜索（Bing / 百度 / Steam 商店）→ 玩法压缩到 100 字以内 → 写入永久缓存。
 *
 * 关键修正：以前「抓失败也缓存空结果」，导致玩法/成就永远是空白。
 * 现在：空结果绝不写缓存；成就每次从本地文件实时读（解锁状态会变），玩法则永久不变。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const gameMeta = require('./game-meta-core');   // AppID → 中文名 / 封面（永久缓存）

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const CACHE_DIR = path.join(DATA_DIR, 'game-details');

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
function safeJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function ensureDir() { try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* */ } }
function cacheFile(appid) { return path.join(CACHE_DIR, `${appid}.json`); }

/* ---------------------- Steam 安装目录（只读探测） ---------------------- */
let _rootCache = null;
function steamRoots() {
  if (_rootCache) return _rootCache;
  const found = [];
  const push = p => {
    if (!p) return;
    const n = path.normalize(String(p));
    if (exists(path.join(n, 'appcache')) && !found.includes(n)) found.push(n);
  };
  // 1) 上次自动发现的路径（不触发注册表，最快）
  const prev = safeJson(path.join(DATA_DIR, 'discovered.json'), {});
  push(prev.path);
  // 2) 配置里手动指定的路径
  const cfg = safeJson(path.join(DATA_DIR, 'config.json'), {});
  push(cfg.steamPath);
  // 3) 常见位置
  for (const c of [
    'C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam',
    'D:\\Steam', 'E:\\Steam', 'F:\\Steam', 'G:\\Steam', 'H:\\Steam',
    'D:\\360Downloads\\Software\\steam',
    path.join(process.env.USERPROFILE || '', 'Steam')
  ]) push(c);
  // 4) 兜底：交给 steam-core 自己发现（含注册表），失败也不影响
  if (!found.length) {
    try { for (const r of require('./steam-core').detectSteamRoots()) push(r.path); } catch { /* */ }
  }
  _rootCache = found;
  return found;
}
function firstRoot() { return steamRoots()[0] || ''; }

/* ---------------------- Steam 二进制 KeyValues 解析 ---------------------- */
function readCString(b, p) {
  const s = b.indexOf(0, p);
  return s < 0 ? { v: '', end: b.length } : { v: b.toString('utf8', p, s), end: s + 1 };
}
function parseKV(buf, start = 0, depth = 0) {
  const out = {};
  let p = start;
  while (p < buf.length && depth < 24) {
    const t = buf[p++];
    if (t === 0x08) return { out, end: p };                 // 段结束
    if (t === 0x00) {                                        // 子表
      const k = readCString(buf, p); p = k.end;
      const c = parseKV(buf, p, depth + 1);
      out[k.v] = c.out; p = c.end; continue;
    }
    const k = readCString(buf, p); p = k.end;
    if (t === 0x01) { const v = readCString(buf, p); p = v.end; out[k.v] = v.v; }
    else if (t === 0x02 || t === 0x03 || t === 0x04 || t === 0x06) {
      if (p + 4 > buf.length) break;
      out[k.v] = buf.readUInt32LE(p); p += 4;
    } else if (t === 0x07) {
      if (p + 8 > buf.length) break;
      try { out[k.v] = Number(buf.readBigUInt64LE(p)); } catch { out[k.v] = 0; }
      p += 8;
    } else if (t === 0x05) {                                 // UTF-16 宽字符串
      let e = p;
      while (e + 1 < buf.length && !(buf[e] === 0 && buf[e + 1] === 0)) e += 2;
      out[k.v] = buf.toString('utf16le', p, e); p = e + 2;
    } else {
      return { out, end: p };                               // 未知类型，安全退出
    }
  }
  return { out, end: p };
}
function parseBinVDF(file) {
  try { return parseKV(fs.readFileSync(file), 0, 0).out; } catch { return null; }
}

/** display.name / display.desc 可能是字符串，也可能是 {schinese, english, token} */
function pickLang(v) {
  if (typeof v === 'string') return v.trim();
  if (!v || typeof v !== 'object') return '';
  for (const k of ['schinese', 'tchinese', 'simp_chinese', 'english', 'japanese', 'koreana']) {
    if (typeof v[k] === 'string' && v[k].trim()) return v[k].trim();
  }
  for (const [k, x] of Object.entries(v)) {
    if (k === 'token' || typeof x !== 'string') continue;
    if (x.trim() && !/^[A-Z0-9_]+$/.test(x.trim())) return x.trim();
  }
  return '';
}

/* ---------------------- 本地成就（定义 + 我的解锁状态） ---------------------- */
function statsDir() { const r = firstRoot(); return r ? path.join(r, 'appcache', 'stats') : ''; }

function readLocalAchievements(appid) {
  const sd = statsDir();
  const out = { available: false, list: [], fileName: '', unlockedCount: 0 };
  if (!sd || !exists(sd)) return out;

  const schemaFile = path.join(sd, `UserGameStatsSchema_${appid}.bin`);
  if (!exists(schemaFile)) return out;
  const parsed = parseBinVDF(schemaFile);
  const root = parsed && (parsed[appid] || parsed[Object.keys(parsed)[0]]);
  const groups = root && root.stats;
  if (!groups || typeof groups !== 'object') return out;

  out.available = true;
  out.fileName = path.basename(schemaFile);

  for (const [gid, g] of Object.entries(groups)) {
    if (!g || typeof g !== 'object' || g.type !== 'ACHIEVEMENTS' || !g.bits || typeof g.bits !== 'object') continue;
    for (const [bit, a] of Object.entries(g.bits)) {
      if (!a || typeof a !== 'object') continue;
      const d = a.display || {};
      const name = pickLang(d.name) || pickLang(a.name) || a.name || '';
      const desc = pickLang(d.desc) || '';
      if (!name) continue;
      out.list.push({
        name, desc,
        hidden: !!a.hidden,
        icon: typeof a.icon === 'string' ? a.icon : '',
        group: gid, bit,
        unlocked: false, unlockedAt: 0, unlockedIso: ''
      });
    }
  }

  // 解锁记录：UserGameStats_<账号ID>_<appid>.bin → cache.<组>.AchievementTimes.<位> = Unix 秒
  let unlockFile = '';
  try {
    unlockFile = fs.readdirSync(sd).find(f => new RegExp(`^UserGameStats_\\d+_${appid}\\.bin$`).test(f)) || '';
  } catch { /* */ }
  if (unlockFile) {
    const u = parseBinVDF(path.join(sd, unlockFile));
    const cache = u && u.cache;
    if (cache && typeof cache === 'object') {
      for (const a of out.list) {
        const times = cache[a.group] && cache[a.group].AchievementTimes;
        const ts = times && times[a.bit];
        // 也兼容位掩码形式：cache.<组>.data 的第 bit 位（bit 从 1 起，0 不适用）
        const bitNo = Number(a.bit);
        const maskOk = !!(bitNo >= 1 && cache[a.group] && typeof cache[a.group].data === 'number' &&
          (Math.floor(cache[a.group].data / Math.pow(2, bitNo - 1)) % 2 === 1));
        if ((typeof ts === 'number' && ts > 0) || maskOk) {
          a.unlocked = true;
          if (typeof ts === 'number' && ts > 0) {
            a.unlockedAt = ts;
            a.unlockedIso = new Date(ts * 1000).toISOString();
          }
        }
      }
      out.unlockFileName = unlockFile;
    }
  }
  out.unlockedCount = out.list.filter(a => a.unlocked).length;
  return out;
}

/* ---------------------- 本地名称 / 封面 / 临时文件里的描述 ---------------------- */
function localGameName(appid) {
  const st = safeJson(path.join(DATA_DIR, 'state.json'), {});
  const g = (st.games || []).find(x => String(x.appid) === String(appid));
  if (g && g.name) return g.name;
  // appmanifest 兜底
  const r = firstRoot();
  if (r) {
    const f = path.join(r, 'steamapps', `appmanifest_${appid}.acf`);
    if (exists(f)) {
      const m = fs.readFileSync(f, 'utf8').match(/"name"\s*"([^"]+)"/);
      if (m) return m[1];
    }
  }
  return '';
}

function localCover(appid) {
  const r = firstRoot();
  if (!r) return '';
  const d = path.join(r, 'appcache', 'librarycache', String(appid));
  if (!exists(d)) return '';
  try {
    const names = fs.readdirSync(d);
    const prefer = names.find(n => /^header_schinese\.(jpg|png|webp)$/i.test(n))
      || names.find(n => /^header\.(jpg|png|webp)$/i.test(n))
      || names.find(n => /^library_600x900.*\.(jpg|png|webp)$/i.test(n))
      || names.find(n => /^library_hero.*\.(jpg|png|webp)$/i.test(n));
    return prefer ? path.join(d, prefer) : '';
  } catch { return ''; }
}

let _localDescScan = null;   // 每次进程只扫一次 httpcache
function localDescriptionScan(appid) {
  const r = firstRoot();
  if (!r) return '';
  // 1) appinfo.vdf：找该 appid 附近的描述类字段（本机实测通常没有）
  // 2) httpcache：Steam 缓存的商店页 / appdetails 响应
  if (_localDescScan && _localDescScan.scanned) return _localDescScan.map[appid] || '';
  const map = {};
  const scanText = txt => {
    if (!txt) return;
    for (const m of txt.matchAll(/"(\d{2,7})"\s*:\s*\{[\s\S]{0,4000}?"short_description"\s*:\s*"((?:[^"\\]|\\.){10,400})"/g)) {
      const id = m[1];
      if (!map[id]) {
        try { map[id] = JSON.parse('"' + m[2] + '"'); } catch { map[id] = m[2]; }
      }
    }
    // 商店页缓存里的 game_description_snippet
    if (!Object.keys(map).length) {
      const sn = txt.match(/class="game_description_snippet">([\s\S]{10,500}?)<\/div>/);
      if (sn) map.__snippet = cleanText(sn[1]);
    }
  };
  try {
    const ai = path.join(r, 'appcache', 'appinfo.vdf');
    if (exists(ai)) scanText(fs.readFileSync(ai, 'latin1'));
    const hc = path.join(r, 'appcache', 'httpcache');
    if (exists(hc)) {
      let n = 0;
      const walk = (dir, depth) => {
        if (depth > 3 || n > 400) return;
        let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of es) {
          if (n > 400) break;
          const p = path.join(dir, e.name);
          if (e.isDirectory()) { walk(p, depth + 1); continue; }
          n++;
          let b; try { b = fs.readFileSync(p); } catch { continue; }
          const texts = [b.toString('utf8')];
          try { texts.push(require('node:zlib').gunzipSync(b).toString('utf8')); } catch { /* */ }
          try { texts.push(require('node:zlib').inflateSync(b).toString('utf8')); } catch { /* */ }
          for (const t of texts) if (t.includes('short_description') || t.includes('game_description_snippet')) scanText(t);
        }
      };
      walk(hc, 0);
    }
  } catch { /* */ }
  _localDescScan = { scanned: true, map };
  return map[appid] || map.__snippet || '';
}

/* ---------------------- 文本清洗 / 100 字压缩 ---------------------- */
function cleanText(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&[a-zA-Z#0-9]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function to100(s, max = 100) {
  let t = cleanText(s)
    .replace(/^\s*(?:\d+\s*(?:天|小时|分钟)前|·|•|[-—])\s*/g, '')
    .replace(/^(?:https?:\/\/\S+\s*)/g, '')
    .trim();
  if (t.length > max) {
    const cut = t.slice(0, max);
    const stops = [cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('；'), cut.lastIndexOf('，')];
    const last = Math.max(...stops);
    t = (last >= 45 ? cut.slice(0, last + 1) : cut).trim();
  }
  return t;
}

/* ---------------------- 联网搜索玩法 ---------------------- */
function httpGet(url, timeout = 9000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      host: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
      headers: {
        Host: u.hostname,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
        Accept: 'text/html,application/json,*/*'
      }
    }, resp => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        resp.resume();
        const next = new URL(resp.headers.location, url).toString();
        if (next !== url) { httpGet(next, timeout).then(resolve, reject); return; }
      }
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => resolve({ status: resp.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

const PLAY_WORDS = /(游戏|玩家|玩法|模式|操作|射击|模拟|解谜|建造|对战|剧情|关卡|角色|任务|竞技|生存|策略|冒险|动作|休闲|桌宠|壁纸|成就|联机|多人|单人|开放世界|回合|战斗|逃脱|推理|恐怖|沙盒|像素|互动)/;

async function searchWebGameplay(name, appid) {
  const q = `"${name}" Steam 游戏 玩法 简介`;
  const engines = [
    'https://cn.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-CN',
    'https://www.baidu.com/s?wd=' + encodeURIComponent(q),
    'https://cn.bing.com/search?q=' + encodeURIComponent(`site:store.steampowered.com/app/${appid} 关于此游戏`)
  ];
  for (const url of engines) {
    let html;
    try { html = (await httpGet(url)).text; } catch { continue; }
    if (!html) continue;
    const caps = [];
    for (const m of html.matchAll(/<p[^>]*class="[^"]*(?:b_lineclamp|b_paractl|b_caption)[^"]*"[^>]*>([\s\S]*?)<\/p>/g)) caps.push(cleanText(m[1]));
    for (const m of html.matchAll(/<div[^>]*class="[^"]*(?:c-abstract|content-right_8Zsdu|c-span-last)[^"]*"[^>]*>([\s\S]{20,600}?)<\/div>/g)) caps.push(cleanText(m[1]));
    if (!caps.length) {
      for (const m of html.matchAll(/<p[^>]*>([\s\S]{40,400}?)<\/p>/g)) caps.push(cleanText(m[1]));
    }
    // 严格相关性过滤：自动搜索结果质量参差，宁可留空也绝不能把新闻/词典写进永久缓存
    const key = String(name).replace(/[^\p{L}\p{N}]/gu, '').toLowerCase().slice(0, 8);
    const BAD = /(学信网|验证码|登录入口|教育部|招聘|考试报名|词典|爱词霸|在线观看|电视剧|ChinaJoy|展会|论坛|贴吧|百度一下|帮助中心|京ICP|About Baidu|股票|柜台|counter\b|哔哩哔哩|攻略站|下载站|最新版下载|蒸汽平台是畅玩|Steam\s*是全球PC游戏平台|畅玩游戏、讨论游戏|数万款作品|立省\s*\d+%|折后[为:：]\s*[\d.]+)/i;
    const good = caps
      .map(c => c.replace(/^\s*(?:\d+\s*(?:天|小时|分钟)前|·|•|[-—]|\d{4}年\d{1,2}月\d{1,2}日)\s*/g, '').trim())
      .filter(c => c.length >= 25 && c.length <= 600 && PLAY_WORDS.test(c))
      .filter(c => !BAD.test(c))
      .filter(c => !/^20\d\d年/.test(c))
      // 必须提到游戏名，或者明确在描述游戏玩法
      .filter(c => {
        const flat = c.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
        return (key && key.length >= 3 && flat.includes(key)) ||
          (c.match(/(游戏|玩家|玩法|模式|关卡|成就|联机|模拟|沙盒|射击|解谜|建造)/g) || []).length >= 2;
      })
      .sort((a, b) => {
        const score = s => (key && s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').includes(key) ? 20 : 0) + Math.min(s.length, 120) / 100;
        return score(b) - score(a);
      });
    if (good.length) {
      const text = to100(good.slice(0, 2).join(' '));
      if (text.length >= 20 && !BAD.test(text)) return { text, source: '网上搜索（已永久保存）' };
    }
  }
  // Steam 官方接口（本机 DNS 常不通，放最后，失败也不影响）
  try {
    const r = await httpGet(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=schinese&cc=CN`, 5000);
    const j = JSON.parse(r.text);
    const d = j[appid] && j[appid].success && j[appid].data;
    if (d && d.short_description) return { text: to100(d.short_description), source: 'Steam 商店（已永久保存）' };
  } catch { /* */ }
  return null;
}

/* ---------------------- 系统需求（Steam 商店 pc_requirements） ---------------------- */
function reqFile(appid) { return path.join(CACHE_DIR, `${appid}.req.json`); }

/** 从 Steam 商店官方 appdetails 抓 pc_requirements（minimum / recommended 原始 HTML），并缓存 */
async function fetchRequirements(appid) {
  const cached = safeJson(reqFile(appid), null);
  if (cached && (cached.minimum || cached.recommended)) return cached;
  try {
    const r = await httpGet(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=schinese&cc=CN`, 6000);
    const j = JSON.parse(r.text);
    const d = j[appid] && j[appid].success && j[appid].data;
    const pc = d && d.pc_requirements;
    if (pc && (pc.minimum || pc.recommended)) {
      const out = { minimum: pc.minimum || '', recommended: pc.recommended || '' };
      try { ensureDir(); fs.writeFileSync(reqFile(appid), JSON.stringify(out)); } catch { /* */ }
      return out;
    }
  } catch { /* 商店不通就返回空，不影响玩法/成就 */ }
  return { minimum: '', recommended: '' };
}

/** 把 Steam 返回的原始 {minimum, recommended} 两段 HTML 各自解析成结构化字段 */
function parseRequirements(raw) {
  const res = { minimum: {}, recommended: {} };
  if (raw && raw.minimum) res.minimum = parseReqHtml(raw.minimum);
  if (raw && raw.recommended) res.recommended = parseReqHtml(raw.recommended);
  return res;
}

/** 把一段需求 HTML（<strong>标签: 值</strong>）拆成 {os, cpu, ram, gpu, storage, directx, network, sound} */
function parseReqHtml(html) {
  const out = {};
  if (!html) return out;
  const segs = String(html)
    .split(/<br\s*\/?>|<\/li>|<\/ul>|<ul[^>]*>/gi)
    .map(s => cleanText(s))
    .filter(Boolean);
  for (const seg of segs) {
    const m = seg.match(/^([^：:]{1,18})[：:]\s*([\s\S]+)$/);
    if (!m) continue;
    const key = normReqKey(m[1].trim());
    if (key) out[key] = m[2].trim();
  }
  return out;
}

function normReqKey(k) {
  const s = String(k || '').toLowerCase().replace(/[\s（）()]/g, '');
  if (/(操作系统|作业系统|^os$|operatingsystem)/.test(s)) return 'os';
  if (/(处理器|cpu|processor)/.test(s)) return 'cpu';
  if (/(内存|memory|ram)/.test(s)) return 'ram';
  if (/(显卡|图形|graphics|videocard|gpu)/.test(s)) return 'gpu';
  if (/directx/.test(s)) return 'directx';
  if (/(存储空间|硬盘|storage|disk)/.test(s)) return 'storage';
  if (/(网络|network|internet)/.test(s)) return 'network';
  if (/(声卡|sound|audio)/.test(s)) return 'sound';
  return '';
}

function parseGb(str) {
  if (!str) return 0;
  const m = String(str).match(/(\d+(?:\.\d+)?)\s*GB/i);
  return m ? parseFloat(m[1]) : 0;
}
function winMajor(str) {
  if (!str) return 0;
  // Steam 需求常写成 "Windows® 10" / "Windows® 11"，中间夹着 ® 等符号，需跳过非数字字符
  const m = String(str).match(/Windows[^\d]*?(10|11)/i);
  return m ? parseInt(m[1], 10) : 0;
}
/** Intel/AMD CPU 代数粗略估算（用于「我的配置够不够」的参考对比，不精确） */
function cpuTier(str) {
  if (!str) return null;
  const s = String(str);
  let m = s.match(/Ryzen\s*(\d)\s*(\d{3,4})/i);
  if (m) return { vendor: 'amd', gen: parseInt(m[1], 10) };
  m = s.match(/i[3579][- ](\d{3,5})/i);
  if (m) {
    const num = m[1];
    const gen = num.length >= 4 ? (num.startsWith('1') ? parseInt(num.slice(0, 2), 10) : parseInt(num[0], 10)) : parseInt(num[0], 10);
    return { vendor: 'intel', gen };
  }
  m = s.match(/Celeron|Pentium|Atom/i);
  if (m) return { vendor: 'intel', gen: 1 };
  return null;
}
/** 显卡代数 / 系列（参考对比用） */
function gpuTier(str) {
  if (!str) return null;
  const s = String(str);
  let m = s.match(/(?:GeForce\s*)?(RTX|GTX)\s*(\d{3,4})/i);
  if (m) return { vendor: 'nvidia', series: m[1].toUpperCase(), num: parseInt(m[2], 10) };
  m = s.match(/Radeon\s*(?:HD|RX)?\s*(?:RX\s*)?(\d{3,4})/i);
  if (m) return { vendor: 'amd', num: parseInt(m[1], 10) };
  if (/Intel/i.test(s)) return { vendor: 'intel', num: 0 };
  return null;
}

/* ---------------------- 硬件性能天梯（自动判定「谁更牛」） ---------------------- */
/* 参考分：以常见档位为基准的相对性能分，只用于「够不够」的比值判断，非精确跑分。
   GPU 基准约 gtx 1060 3gb=90；CPU 基准约 i5-12400=156。 */
const GPU_TABLE = {
  'rtx 4090': 550, 'rtx 4080': 420, 'rtx 4070 ti': 330, 'rtx 4070': 290, 'rtx 4060 ti': 230, 'rtx 4060': 200,
  'rtx 3090': 360, 'rtx 3080 ti': 330, 'rtx 3080': 300, 'rtx 3070 ti': 250, 'rtx 3070': 230, 'rtx 3060 ti': 200, 'rtx 3060': 175,
  'rtx 2080 ti': 290, 'rtx 2080': 250, 'rtx 2070 super': 220, 'rtx 2070': 200, 'rtx 2060 super': 175, 'rtx 2060': 160,
  'rtx 3080 laptop': 220, 'rtx 3070 laptop': 180, 'rtx 3060 laptop': 130, 'rtx 3050 laptop': 110, 'rtx 3050 ti': 160, 'rtx 3050': 150,
  'gtx 1660 ti': 135, 'gtx 1660 super': 132, 'gtx 1660': 128, 'gtx 1650 super': 120, 'gtx 1650': 105, 'gtx 1650 laptop': 95,
  'gtx 1080 ti': 150, 'gtx 1080': 135, 'gtx 1070 ti': 125, 'gtx 1070': 115, 'gtx 1060 6gb': 100, 'gtx 1060 3gb': 90, 'gtx 1060 laptop': 88,
  'gtx 1050 ti': 75, 'gtx 1050': 65, 'gtx 980': 100, 'gtx 970': 95, 'gtx 960': 70, 'gtx 950': 60, 'gtx 780 ti': 80, 'gtx 780': 75,
  'gtx 760': 55, 'gtx 750 ti': 50, 'gtx 660': 45, 'gtx 650 ti': 42, 'gtx 1030': 42, 'gtx 730': 30, 'gtx 710': 22,
  'mx 450': 60, 'mx 350': 50, 'mx 250': 45, 'mx 230': 42, 'mx 150': 42, 'mx 130': 38,
  'rx 7900 xtx': 560, 'rx 7900 xt': 500, 'rx 7800 xt': 390, 'rx 7700 xt': 340, 'rx 7600': 240,
  'rx 6900 xt': 420, 'rx 6800 xt': 380, 'rx 6800': 350, 'rx 6750 xt': 340, 'rx 6700 xt': 330, 'rx 6700': 300,
  'rx 6650 xt': 270, 'rx 6600 xt': 260, 'rx 6600': 230, 'rx 6500 xt': 180, 'rx 6400': 150,
  'rx 580': 210, 'rx 570': 170, 'rx 560': 130, 'rx 550': 110, 'rx 480': 150, 'rx 470': 130, 'rx 460': 115, 'rx 5600 xt': 250,
  'rx vega 64': 200, 'rx vega 56': 180, 'r9 390': 130, 'r9 290': 130, 'r9 380': 115, 'r7 370': 90,
  'hd 7970': 100, 'hd 7950': 90, 'hd 7870': 80, 'hd 7850': 70, 'hd 7770': 60, 'hd 7750': 55,
  'hd 6970': 85, 'hd 6950': 75, 'hd 6870': 65, 'hd 6850': 60, 'hd 6770': 55, 'hd 6750': 50, 'hd 6670': 45, 'hd 6570': 38, 'hd 6450': 28,
  'hd 4850': 55, 'hd 5450': 22,
  'arc a770': 310, 'arc a750': 280, 'arc a580': 200, 'arc a380': 130,
  'uhd 770': 45, 'uhd 750': 40, 'uhd 730': 38, 'uhd 630': 33, 'uhd 620': 25, 'uhd 617': 24, 'uhd 615': 22,
  'hd 630': 32, 'hd 620': 24, 'hd 615': 20, 'hd 530': 24, 'hd 520': 22, 'hd 4600': 20, 'hd 4400': 18,
  'hd 4000': 16, 'hd 3000': 12, 'hd 2500': 10, 'iris xe': 28, 'iris plus': 30, 'iris pro': 32
};
const CPU_TABLE = {
  'i9 14900k': 200, 'i9 13900k': 195, 'i9 12900k': 185, 'i9 11900k': 175, 'i9 10900k': 165, 'i9 9900k': 172, 'i9 7980xe': 180,
  'i7 14700k': 188, 'i7 13700k': 180, 'i7 12700k': 172, 'i7 11700k': 162, 'i7 10700k': 155, 'i7 9700k': 145, 'i7 8700k': 135,
  'i7 7700k': 125, 'i7 6700k': 115, 'i7 4790k': 105, 'i7 3770k': 95, 'i7 2600k': 80, 'i7 11800h': 150, 'i7 10750h': 130, 'i7 9750h': 125,
  'i5 14600k': 175, 'i5 13600k': 168, 'i5 12600k': 160, 'i5 12400': 156, 'i5 12400f': 156, 'i5 11600k': 148, 'i5 11400': 145,
  'i5 10600k': 140, 'i5 10400': 135, 'i5 9600k': 128, 'i5 9400f': 122, 'i5 8400': 118, 'i5 7600k': 110, 'i5 7500': 105,
  'i5 6600k': 98, 'i5 4690k': 90, 'i5 4590': 88, 'i5 4460': 86, 'i5 3570k': 82, 'i5 2500k': 75, 'i5 2400': 72, 'i5 750': 55,
  'i3 13100': 130, 'i3 12100': 125, 'i3 10100': 115, 'i3 9100': 108, 'i3 8100': 102, 'i3 7100': 95, 'i3 4170': 85, 'i3 3220': 75, 'i3 2120': 65,
  'ultra 9 285k': 195, 'ultra 9 185h': 180, 'ultra 7 265k': 185, 'ultra 7 155h': 160, 'ultra 5 245k': 165, 'ultra 5 125h': 140,
  'ryzen 9 9950x': 200, 'ryzen 9 9900x': 190, 'ryzen 9 7950x': 195, 'ryzen 9 7900x': 188, 'ryzen 9 5950x': 180, 'ryzen 9 3950x': 165, 'threadripper 3990x': 200,
  'ryzen 7 7800x3d': 185, 'ryzen 7 5800x3d': 170, 'ryzen 7 7700x': 175, 'ryzen 7 5800x': 165, 'ryzen 7 5700x': 158, 'ryzen 7 3800x': 150, 'ryzen 7 3700x': 148,
  'ryzen 7 2700x': 135, 'ryzen 7 1800x': 125, 'ryzen 5 7600x': 160, 'ryzen 5 5600x': 148, 'ryzen 5 5600': 140, 'ryzen 5 3600x': 138, 'ryzen 5 3600': 132,
  'ryzen 5 2600': 118, 'ryzen 5 1600': 105, 'ryzen 5 1500x': 100, 'ryzen 3 3300x': 120, 'ryzen 3 3100': 115, 'ryzen 3 2200g': 90, 'ryzen 3 1300x': 88, 'ryzen 3 1200': 82,
  'fx 8350': 70, 'fx 6300': 55, 'phenom ii x4 965': 50, 'athlon': 45
};
/** 归一化型号：去品牌词、符号、括号，统一小写空格；并把「3 gb」合并成「3gb」 */
function normBrand(s) {
  return String(s || '').toLowerCase()
    .replace(/（[^）]*）/g, ' ').replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\bgeforce\b|\bradeon\b|\bnvidia\b|\bamd\b|\bintel\b|\bgraphics\b|\bvideo\b|\bseries\b|\bgtx\b|\brtx\b|\brx\b/g, ' ')
    .replace(/(\d)\s*gb/g, '$1gb')
    .replace(/\s+/g, ' ').trim();
}
/** 在表里找最长匹配（避免 rtx 3060 误匹配 rtx 3060 ti 之类，长 key 优先）。注意：键也要先归一化再比。 */
function findModel(norm, table) {
  let best = null, bestLen = 0;
  for (const k of Object.keys(table)) {
    const kn = normBrand(k);
    if (kn && norm.includes(kn) && kn.length > bestLen) { best = k; bestLen = kn.length; }
  }
  return best;
}
function extractVram(s) {
  const m = String(s || '').match(/(\d+(?:\.\d+)?)\s*gb/i);
  return m ? parseFloat(m[1]) : 0;
}
/** 显卡自动对比：返回 {status, note, ratio} */
function compareGpu(myName, myVram, reqText, recText) {
  const myNorm = normBrand(myName);
  const reqNorm = normBrand((reqText || '') + ' ' + (recText || ''));
  const myKey = findModel(myNorm, GPU_TABLE);
  const reqKey = findModel(reqNorm, GPU_TABLE);
  const myScore = myKey ? GPU_TABLE[myKey] : 0;
  const reqScore = reqKey ? GPU_TABLE[reqKey] : 0;
  const reqVram = extractVram(reqText) || extractVram(recText || '');
  // 需求没列具体型号，只按显存兜底
  if (!reqKey) {
    if (reqVram && myVram && myVram > 0 && myVram < reqVram)
      return { status: 'min', note: `需求显存 ${reqVram}GB，你的约 ${myVram}GB，偏低需留意`, ratio: 0 };
    if (reqVram && myVram && myVram >= reqVram)
      return { status: 'pass', note: `显存达标（${myVram}GB ≥ ${reqVram}GB），且需求未列具体型号，现代显卡通常可运行`, ratio: 0 };
    return { status: 'unknown', note: '需求未列具体显卡型号，通常现代独显可运行', ratio: 0 };
  }
  if (!myScore) return { status: 'unknown', note: '未能识别你的显卡型号，需手动确认', ratio: 0 };
  const ratio = reqScore ? myScore / reqScore : 1;
  const pct = Math.round(ratio * 100);
  let status, tail;
  if (ratio >= 0.95) { status = 'pass'; tail = '可运行'; }
  else if (ratio >= 0.55) { status = 'min'; tail = '偏弱，建议低画质'; }
  else { status = 'fail'; tail = '明显不足，带不动'; }
  let vramNote = '';
  if (reqVram && myVram && myVram > 0 && myVram < reqVram) vramNote = `；显存也偏低（${myVram}GB < ${reqVram}GB）`;
  return { status, ratio, note: `你的显卡性能约为需求显卡（${reqKey}）的 ${pct}%，${tail}${vramNote}` };
}
/** CPU 自动对比 */
function compareCpu(myName, reqText, recText) {
  const myNorm = normBrand(myName);
  const reqNorm = normBrand((reqText || '') + ' ' + (recText || ''));
  const myKey = findModel(myNorm, CPU_TABLE);
  const reqKey = findModel(reqNorm, CPU_TABLE);
  const myScore = myKey ? CPU_TABLE[myKey] : 0;
  const reqScore = reqKey ? CPU_TABLE[reqKey] : 0;
  if (!reqKey) {
    if (myScore) return { status: 'pass', note: '你的 CPU 性能较强，可覆盖未列型号的需求' };
    return { status: 'unknown', note: '需求未列具体 CPU 型号，需手动确认' };
  }
  if (!myScore) return { status: 'unknown', note: '未能识别你的 CPU 型号，需手动确认', ratio: 0 };
  const ratio = reqScore ? myScore / reqScore : 1;
  const pct = Math.round(ratio * 100);
  let status, tail;
  if (ratio >= 0.95) { status = 'pass'; tail = '可流畅运行'; }
  else if (ratio >= 0.7) { status = 'min', tail = '略弱，够用' ; }
  else if (ratio >= 0.5) { status = 'min'; tail = '偏弱，建议低画质' ; }
  else { status = 'fail'; tail = '明显不足' ; }
  return { status, ratio, note: `你的 CPU 性能约为需求（${reqKey}）的 ${pct}%，${tail}` };
}

/**
 * 把「我的电脑配置」和「游戏系统需求」做对比，给出每项的 ✅/❌ 与总体结论。
 * 可靠性说明：内存 / 操作系统 / 存储空间 是硬指标，判断准确；
 * CPU / 显卡 只能做代数级别的粗略估算，无法精确比对，结果标注「需手动确认」。
 */
function compareSpecs(pc, parsed) {
  const min = (parsed && parsed.minimum) || {};
  const rec = (parsed && parsed.recommended) || {};
  const rows = [];
  const push = (key, label, pcVal, reqMin, reqRec) => {
    let status = 'unknown', note = '';
    if (key === 'ram') {
      const need = parseGb(reqMin);
      if (need && pc && pc.ramGB) { status = pc.ramGB >= need ? 'pass' : 'fail'; note = need + ' GB'; }
      else if (need) { status = 'unknown'; note = need + ' GB'; }
    } else if (key === 'storage') {
      const need = parseGb(reqMin);
      if (need && pc && pc.diskFreeGB) { status = pc.diskFreeGB >= need ? 'pass' : 'fail'; note = need + ' GB 可用'; }
      else if (need) { status = 'unknown'; note = need + ' GB 可用'; }
    } else if (key === 'os') {
      const need = winMajor(reqMin);
      const have = pc && winMajor(pc.os && pc.os.name);
      if (need && have) {
        if (have >= need) { status = 'pass'; note = '需 Windows ' + need; }
        else { status = 'fail'; note = '需 Windows ' + need; }
      } else if (need) { status = 'unknown'; note = '需 Windows ' + need; }
    } else if (key === 'cpu') {
      const c = compareCpu(pc && pc.cpu && pc.cpu.name, reqMin, reqRec);
      status = c.status; note = c.note;
    } else if (key === 'gpu') {
      const g = compareGpu(pc && pc.gpu && pc.gpu.name, pc && pc.gpu && pc.gpu.vramGB, reqMin, reqRec);
      status = g.status; note = g.note;
    } else if (key === 'directx') {
      const need = reqMin && reqMin.match(/(\d+)/);
      if (need) {
        const n = parseInt(need[1], 10);
        if (n <= 12) { status = 'pass'; note = `需 DirectX ${n}，你的显卡（现代硬件）支持`; }
        else { status = 'min'; note = `需 DirectX ${n}，较新，请确认显卡驱动支持`; }
      } else { status = 'pass'; note = '无 DirectX 要求'; }
    } else {
      if (reqMin) status = 'unknown';
    }
    rows.push({ key, label, pc: pcVal || '—', reqMin: reqMin || '—', reqRec: reqRec || '—', status, note });
  };

  push('os', '操作系统', pc && pc.os ? `${pc.os.name} ${pc.os.arch}` : '—', min.os, rec.os);
  push('cpu', '处理器', pc && pc.cpu ? `${pc.cpu.name}${pc.cpu.threads ? `（${pc.cpu.threads} 线程）` : ''}` : '—', min.cpu, rec.cpu);
  push('ram', '内存', pc ? `${pc.ramGB} GB` : '—', min.ram, rec.ram);
  push('gpu', '显卡', pc && pc.gpu ? `${pc.gpu.name}${pc.gpu.vramGB ? `（${pc.gpu.vramGB} GB）` : ''}` : '—', min.gpu, rec.gpu);
  push('storage', '存储空间', pc ? `C 盘剩余 ${pc.diskFreeGB} GB` : '—', min.storage, rec.storage);
  push('directx', 'DirectX', '—', min.directx, rec.directx);

  const hardFail = rows.some(r => (r.key === 'ram' || r.key === 'os' || r.key === 'storage' || r.key === 'cpu' || r.key === 'gpu') && r.status === 'fail');
  const softOk = rows.every(r => r.status === 'pass' || r.status === 'min');
  const softUnknown = rows.some(r => r.status === 'unknown');

  let verdict, verdictText;
  if (hardFail) {
    verdict = 'fail';
    verdictText = '❌ 达不到最低配置（CPU / 显卡 / 内存 / 系统 / 存储空间有硬伤）';
  } else if (softOk && !softUnknown) {
    verdict = 'ok';
    verdictText = '✅ 满足推荐配置，可流畅运行';
  } else {
    verdict = 'warn';
    verdictText = softUnknown
      ? '⚠️ 内存/系统达标，但部分硬件型号无法识别，需你手动确认'
      : '⚠️ 可达最低配置，但显卡 / 处理器偏弱，建议降低画质';
  }
  return { verdict, verdictText, rows };
}

/* ---------------------- 轻量系统需求（仅抓 pc_requirements，不走玩法/成就搜索） ---------------------- */
async function getRequirements(appid, name) {
  appid = String(appid || '').trim();
  if (!/^\d{1,12}$/.test(appid)) return { appid, error: 'AppID 无效' };
  const raw = await fetchRequirements(appid);
  const parsed = parseRequirements(raw);
  return { appid, name: name || '', raw, parsed };
}

/* ---------------------- 永久缓存 ---------------------- */
function readCache(appid) {
  const j = safeJson(cacheFile(appid), null);
  if (!j || typeof j !== 'object') return null;
  // 只有含有效内容才算命中；历史遗留的空缓存一律作废
  if (!j.gameplay && !(Array.isArray(j.achievements) && j.achievements.length)) return null;
  return j;
}
function writeCache(appid, obj) {
  ensureDir();
  try { fs.writeFileSync(cacheFile(appid), JSON.stringify(obj, null, 2)); } catch { /* */ }
}
/** 手动预置玩法（由联网搜索脚本调用）；一旦写入就是永久值 */
function setGameplay(appid, text, source) {
  appid = String(appid || '').trim();
  const t = to100(text);
  if (!/^\d{1,12}$/.test(appid) || !t) return null;
  const old = safeJson(cacheFile(appid), {}) || {};
  const obj = {
    ...old, appid, gameplay: t,
    gameplaySource: source || '网上搜索（已永久保存）',
    permanent: true, savedAt: Date.now()
  };
  writeCache(appid, obj);
  return obj;
}
function allCached() {
  ensureDir();
  const out = {};
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (!/^\d+\.json$/.test(f)) continue;
      const j = safeJson(path.join(CACHE_DIR, f), null);
      if (j && (j.gameplay || (j.achievements || []).length)) {
        const id = f.replace(/\.json$/, '');
        // 离线快照里也带上系统需求（即使这款没有玩法/成就，只要在线时抓过需求就合并）
        const req = safeJson(reqFile(id), null);
        if (req && (req.minimum || req.recommended)) {
          j.requirements = { raw: { minimum: req.minimum || '', recommended: req.recommended || '' }, parsed: parseRequirements(req) };
        }
        out[id] = j;
      }
    }
  } catch { /* */ }
  return out;
}

/* ---------------------- 主入口 ---------------------- */
async function getDetail(appid, opts = {}) {
  appid = String(appid || '').trim();
  if (!/^\d{1,12}$/.test(appid)) return { appid, error: 'AppID 无效' };

  const cached = readCache(appid);
  const local = readLocalAchievements(appid);
  /* 本机没成就文件时（浏览器扫描到的愿望单 / 未下载游戏），
     按需从 Steam 商店公开资料补一次成就，点开就能看到「有什么成就」。 */
  let storeAch = gameMeta.achievementsOf(appid);
  if (!local.available && !storeAch.checked) {
    try { storeAch = await gameMeta.ensureAchievements(appid); } catch { /* 取不到就维持本机结果 */ }
  }
  /* 商店只给 AppID 时：用元数据缓存里的中文名补上；旧的占位名 "AppID xxx" 一律不采信 */
  const placeholder = v => !v || /^AppID\s*\d+$/i.test(String(v).trim());
  const metaName = gameMeta.nameOf(appid);
  if (!metaName) gameMeta.queue(appid);
  const name = (!placeholder(opts.name) ? opts.name : '')
    || metaName
    || (!placeholder(cached?.name) ? cached.name : '')
    || localGameName(appid)
    || `AppID ${appid}`;
  const cover = localCover(appid);

  /* 系统需求：从 Steam 商店官方 appdetails 抓 pc_requirements（最低 / 推荐），
     解析成结构化字段；失败不影响玩法 / 成就展示。 */
  let requirements = { raw: { minimum: '', recommended: '' }, parsed: { minimum: {}, recommended: {} } };
  if (!opts.noNetwork) {
    try {
      const reqRaw = await fetchRequirements(appid);
      requirements = { raw: reqRaw, parsed: parseRequirements(reqRaw) };
    } catch { /* 商店不通就留空 */ }
  }

  // 玩法：永久缓存 > Steam 本地文件 > 商店官方简介 > 联网搜索。
  // 旧版本曾把 Steam 首页通用文案当成玩法写进永久缓存，这里识别后丢弃重取。
  const PLATFORM_NOISE = /蒸汽平台是畅玩|Steam\s*是全球PC游戏平台|畅玩游戏、讨论游戏|数万款作品|立省\s*\d+%|原价[为:：]\s*[\d.]+|折后[为:：]\s*[\d.]+/i;
  let gameplay = cached?.gameplay || '';
  let gameplaySource = cached?.gameplaySource || '';
  if (PLATFORM_NOISE.test(gameplay)) { gameplay = ''; gameplaySource = ''; }
  if (!gameplay) {
    const fromSteam = to100(localDescriptionScan(appid));
    if (fromSteam && !PLATFORM_NOISE.test(fromSteam)) { gameplay = fromSteam; gameplaySource = 'Steam 本地缓存文件（已永久保存）'; }
  }
  if (!gameplay) {
    const desc = gameMeta.descOf(appid);
    if (desc) { gameplay = to100(desc); gameplaySource = 'Steam 商店官方简介（已永久保存）'; }
  }
  if (!gameplay && !opts.noNetwork) {
    const web = await searchWebGameplay(name === `AppID ${appid}` ? '' : name, appid);
    if (web && web.text) { gameplay = web.text; gameplaySource = web.source; }
  }

  const achList = local.available ? local.list : storeAch.list;
  const achTotal = local.available
    ? local.list.length
    : Math.max(storeAch.total, storeAch.list.length);
  const achFromStore = !local.available && achList.length > 0;
  const achSource = local.available
    ? `Steam 本地成就文件 ${local.fileName}${local.unlockFileName ? ' + 我的解锁记录' : ''}`
    : (achFromStore
      ? `Steam 商店公开成就（本机未安装 / 未解锁，共 ${achTotal} 项，这里列出 ${achList.length} 项）`
      : '本机未找到该游戏的成就文件，Steam 商店也没有公开成就');

  const result = {
    appid, name,
    headerImage: cover ? `/api/game/cover?appid=${appid}` : (gameMeta.coverOf(appid) || cached?.headerImage || ''),
    gameplay,
    gameplaySource,
    gameplayPermanent: !!gameplay,
    requirements,
    achievements: achList,
    achievementTotal: achTotal,
    achievementUnlocked: local.unlockedCount,
    achievementFromStore: achFromStore,
    achievementSource: achSource,
    source: [
      gameplaySource ? `玩法：${gameplaySource}` : '',
      local.available ? `成就：Steam 本地文件（${local.unlockedCount}/${local.list.length} 已解锁）`
        : (achFromStore ? `成就：Steam 商店公开成就（0/${achTotal} 已解锁）` : '成就：暂无公开成就')
    ].filter(Boolean).join(' · '),
    fetchedAt: Date.now(),
    cached: !!cached
  };
  // 名字统一用上面算好的结果（元数据中文名优先），不再被旧缓存里的占位名覆盖

  // 空结果绝不写缓存（这是以前「永远不显示」的根因）
  if (gameplay || local.list.length) writeCache(appid, result);
  return result;
}

module.exports = {
  getDetail, setGameplay, allCached, localCover,
  readLocalAchievements, cleanText, to100,
  fetchRequirements, parseRequirements, compareSpecs, getRequirements
};
