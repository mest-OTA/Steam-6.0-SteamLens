'use strict';
/**
 * SteamLens · 好友成就 & 好友关系链
 *
 * 数据来源：Steam 社区公开页面（不登录、不取 Cookie、不模拟协议）
 *   - /profiles/<id>/achievements/<appid>  成就定义（中文名/说明/图标）+ 该玩家解锁状态与解锁时间
 *   - /profiles/<id>/friends/              好友列表（可递归一层得到「朋友的朋友」）
 *
 * 本机 Steam 的 UserGameStats_* 只保存自己账号的解锁记录，好友的成就必须走社区页。
 * 抓取结果按 <steamId64>/<appid> 永久缓存到 data/friend-achievements/，可手动刷新。
 */
const fs = require('node:fs');
const path = require('node:path');
const net = require('./steam-net');

const ROOT = __dirname;
const CACHE_DIR = path.join(ROOT, 'data', 'friend-achievements');
const DISCOVER_FILE = path.join(ROOT, 'data', 'discovered-friends.json');
const BASE = 'https://steamcommunity.com';

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, obj) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); } catch {}
}
const isId = s => /^\d{17}$/.test(String(s || ''));
const isApp = s => /^\d+$/.test(String(s || ''));

/* ------------------------- SSR 递归解析 ------------------------- */
/** Steam 新版页面把 React Query 数据以「字符串里的 JSON」层层嵌套，需要递归解包 */
function deepWalk(o, visit, depth = 0) {
  if (depth > 14 || o == null) return;
  if (typeof o === 'string') {
    if (o.length > 30 && (o[0] === '{' || o[0] === '[')) {
      try { deepWalk(JSON.parse(o), visit, depth + 1); } catch {}
    }
    return;
  }
  if (typeof o !== 'object') return;
  visit(o);
  for (const k of Object.keys(o)) deepWalk(o[k], visit, depth + 1);
}

function parseAchievementHtml(html, appid) {
  const m = html.match(/<script[^>]*id="valve-ssr-data"[^>]*>([\s\S]*?)<\/script>/);
  const result = { ok: false, achievements: [], appName: '', ownerName: '', cdn: 'media.st.dl.eccdnx.com' };
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
  const parts = title.split('::').map(s => s.trim());
  if (parts.length >= 4) { result.appName = parts[1]; result.ownerName = parts[2]; }

  if (!m) {
    // 旧版成就页兜底：achieveTxtHolder / achieveTxt
    const rows = [...html.matchAll(/<div[^>]*class="[^"]*achieveTxtHolder[^"]*"[\s\S]{0,1200}?<\/div>\s*<\/div>/g)];
    if (rows.length) {
      result.achievements = rows.map(r => {
        const t = r[0];
        return {
          name: (t.match(/<h3>([^<]+)<\/h3>/) || [])[1] || '',
          desc: (t.match(/<h5>([^<]+)<\/h5>/) || [])[1] || '',
          unlocked: /achieveUnlockTime|已解锁/.test(t),
          unlockedIso: null
        };
      });
      result.ok = true;
    } else {
      result.reason = /private|私密|This profile is private|登录/i.test(html)
        ? '该玩家的 Steam 档案/游戏详情设为私密，Steam 不公开他的成就。'
        : 'Steam 没有返回成就数据（可能该游戏没有成就，或档案不可见）。';
    }
    return result;
  }

  let root;
  try { root = JSON.parse(m[1]); } catch { result.reason = 'Steam 页面数据解析失败。'; return result; }
  if (root.cdn) result.cdn = root.cdn;

  const schema = new Map();   // internal_key -> 定义
  const states = new Map();   // internal_key -> 解锁状态
  deepWalk(root, o => {
    // 成就定义：数组元素含 api_name + name
    if (Array.isArray(o)) {
      for (const a of o) {
        if (a && typeof a === 'object' && (a.api_name || a.internal_key != null) && (a.name || a.displayName)) {
          const k = String(a.internal_key ?? a.api_name);
          if (!schema.has(k)) schema.set(k, {
            key: k, apiName: a.api_name || '', name: a.name || a.displayName || '',
            desc: a.description || '', hidden: !!a.hidden,
            icon: a.icon_achieved || a.icon || '', iconLocked: a.icon_unachieved || ''
          });
        }
      }
    }
    // 解锁状态：对象以 internal_key 为键
    if (o.achievements && !Array.isArray(o.achievements) && typeof o.achievements === 'object') {
      for (const [k, v] of Object.entries(o.achievements)) {
        if (v && typeof v === 'object' && ('unlocked' in v || 'unlock_time' in v)) {
          states.set(String(k), { unlocked: !!v.unlocked, ts: Number(v.unlock_time || 0) });
        }
      }
    }
    if (o.targetName && !result.ownerName) result.ownerName = o.targetName;
    if (o.appName && !result.appName) result.appName = o.appName;
  });

  if (!schema.size) {
    result.reason = result.ownerName
      ? 'Steam 显示该游戏没有成就，或页面未公开成就列表。'
      : 'Steam 未返回成就（档案可能设为私密）。';
    return result;
  }
  const keys = new Set([...schema.keys(), ...states.keys()]);
  result.achievements = [...keys].map(k => {
    const s = schema.get(k) || { key: k, name: k, desc: '', hidden: false, icon: '', iconLocked: '' };
    const st = states.get(k) || { unlocked: false, ts: 0 };
    const iconFile = st.unlocked ? s.icon : (s.iconLocked || s.icon);
    return {
      key: k, name: s.name || s.apiName || k, desc: s.desc || (s.hidden ? '（隐藏成就）' : '—'),
      hidden: !!s.hidden,
      icon: iconFile ? `https://${result.cdn}/steamcommunity/public/images/apps/${appid}/${iconFile}` : '',
      unlocked: !!st.unlocked,
      unlockedIso: st.unlocked && st.ts > 0 ? new Date(st.ts * 1000).toISOString() : null
    };
  }).sort((a, b) => (a.unlocked === b.unlocked ? 0 : a.unlocked ? -1 : 1));
  result.ok = true;
  return result;
}

/* ------------------------- 好友页解析 ------------------------- */
function parseFriendsHtml(html, ownerId) {
  const people = [];
  const blocks = html.match(/<div[^>]*friend_block_v2[^>]*>/gi) || [];
  for (const tag of blocks) {
    const id = (tag.match(/data-steamid="(\d{17})"/) || [])[1];
    if (!id || id === ownerId) continue;
    const search = (tag.match(/data-search="([^"]*)"/) || [])[1] || '';
    const name = search.split(';').map(s => s.trim()).filter(Boolean)[0] || '';
    const cls = (tag.match(/class="([^"]*)"/) || [])[1] || '';
    let state = '离线';
    if (/in-game/.test(cls)) state = '游戏中';
    else if (/online/.test(cls)) state = '在线';
    people.push({ steamId64: id, name: name || ('Steam ' + id.slice(-6)), state, profileUrl: BASE + '/profiles/' + id });
  }
  // 兼容新版 SSR 好友页
  if (!people.length) {
    const ids = [...new Set([...html.matchAll(/steamcommunity\.com\/profiles\/(\d{17})/g)].map(m => m[1]))];
    for (const id of ids) if (id !== ownerId) people.push({ steamId64: id, name: '', state: '', profileUrl: BASE + '/profiles/' + id });
  }
  const counts = (html.match(/var g_rgCounts\s*=\s*(\{[^}]*\})/) || [])[1];
  let declaredTotal = null;
  try { declaredTotal = JSON.parse(counts).cFriends ?? null; } catch {}
  const profile = (html.match(/var g_rgProfileData\s*=\s*(\{[^}]*\})/) || [])[1];
  let ownerName = '';
  try { ownerName = JSON.parse(profile).personaname || ''; } catch {}
  return { people, declaredTotal, ownerName };
}

/* ------------------------- 抓取：好友成就 ------------------------- */
function cachePath(steamId64, appid) { return path.join(CACHE_DIR, String(steamId64), String(appid) + '.json'); }

/** 兼容游戏详情弹窗的输出结构 */
function emptyDetail(steamId64, appid, name, reason) {
  return {
    ok: false, appid: String(appid), steamId64: String(steamId64), name: name || '',
    achievements: [], achievementTotal: 0, achievementUnlocked: 0,
    achievementSource: reason || '暂无数据', ownerName: '', cached: false
  };
}

async function fetchFriendAchievements(steamId64, appid, name) {
  const url = `${BASE}/profiles/${steamId64}/achievements/${appid}/?l=schinese`;
  const r = await net.get(url);
  if (!r.ok || !r.text) {
    return { ...emptyDetail(steamId64, appid, name, `Steam 页面请求失败（${r.error || 'HTTP ' + r.status}）`), network: r };
  }
  const parsed = parseAchievementHtml(r.text, appid);
  if (!parsed.ok) return { ...emptyDetail(steamId64, appid, name, parsed.reason), ownerName: parsed.ownerName };
  const list = parsed.achievements;
  const d = {
    ok: true, appid: String(appid), steamId64: String(steamId64),
    name: name || parsed.appName || '', appName: parsed.appName || name || '',
    ownerName: parsed.ownerName || '',
    achievements: list,
    achievementTotal: list.length,
    achievementUnlocked: list.filter(a => a.unlocked).length,
    achievementSource: `Steam 社区成就页 · ${parsed.ownerName || steamId64} 的解锁记录（${r.via}）`,
    source: 'Steam 社区（公开页面）',
    fetchedAt: Date.now(), fetchedAtIso: new Date().toISOString(),
    cached: false, permanent: true
  };
  writeJson(cachePath(steamId64, appid), d);
  return d;
}

/**
 * 取好友成就：默认读永久缓存，refresh=1 时重新抓 Steam。
 * 缓存为空 / 抓取失败但有旧缓存时，仍返回旧缓存并标注。
 */
async function getFriendAchievements(steamId64, appid, name, opts = {}) {
  if (!isId(steamId64) || !isApp(appid)) return emptyDetail(steamId64, appid, name, 'SteamID 或 AppID 格式不正确。');
  const p = cachePath(steamId64, appid);
  const cached = readJson(p, null);
  if (cached && !opts.refresh) return { ...cached, cached: true };
  try {
    const fresh = await fetchFriendAchievements(steamId64, appid, name || (cached && cached.name) || '');
    if (fresh.ok) return fresh;
    if (cached) return { ...cached, cached: true, staleReason: fresh.achievementSource };
    return fresh;
  } catch (e) {
    if (cached) return { ...cached, cached: true, staleReason: e.message };
    return emptyDetail(steamId64, appid, name, '读取失败：' + e.message);
  }
}

/* ------------------------- 抓取：好友 / 朋友的朋友 ------------------------- */
async function fetchFriendsPage(steamId64) {
  const r = await net.get(`${BASE}/profiles/${steamId64}/friends/?l=schinese`);
  if (!r.ok || !r.text) return { ok: false, error: r.error || 'HTTP ' + r.status, people: [] };
  const parsed = parseFriendsHtml(r.text, steamId64);
  return { ok: true, ...parsed, via: r.via };
}

/** 发现好友关系链：depth=0 只要直接好友，depth=1 额外抓「朋友的朋友」 */
async function discoverFriends(steamId64, opts = {}) {
  if (!isId(steamId64)) return { ok: false, error: 'SteamID 格式不正确', direct: [], extended: [] };
  const depth = Math.min(1, Math.max(0, Number(opts.depth ?? 1)));
  const root = await fetchFriendsPage(steamId64);
  const direct = (root.people || []).map(p => ({ ...p, via: '', viaName: root.ownerName || '我', level: 1 }));
  const extended = [];
  const seen = new Set([...direct.map(p => p.steamId64), steamId64]);
  const scanNotes = [];
  if (depth > 0) {
    const scan = direct.slice(0, 8);
    for (const f of scan) {
      const r = await fetchFriendsPage(f.steamId64);
      if (!r.ok) { scanNotes.push(`${f.name} 的好友列表读取失败（${r.error}）`); continue; }
      if (!r.people.length) { scanNotes.push(`${f.name} 的好友列表为空或设为私密，Steam 不公开他的好友`); continue; }
      let added = 0;
      for (const p of r.people) {
        if (seen.has(p.steamId64)) continue;
        seen.add(p.steamId64);
        extended.push({ ...p, via: f.steamId64, viaName: f.name, level: 2 });
        added++;
      }
      if (!added) scanNotes.push(`${f.name} 的好友与你已认识的人重合`);
    }
  }
  /* 浏览器已登录会话采到的「朋友的朋友」不能被这次联网扫描整份覆盖：
     服务端直连 Steam 社区经常读不到公开好友，浏览器采到的才是真实名单。 */
  const prev = readJson(DISCOVER_FILE, null);
  for (const x of ((prev && Array.isArray(prev.extended)) ? prev.extended : [])) {
    if (String(x?.sourceTag || '') !== 'collector-fof') continue;
    if (!extended.some(y => String(y.steamId64) === String(x.steamId64) && String(y.via) === String(x.via))) extended.push(x);
  }
  /* 这份文件同时被「浏览器自动巡航」写入。服务端直连经常抓不到公开好友，
     整份覆盖会把巡航采到的 43 人清空；这里保留巡航字段并重算分组统计。 */
  const collector = extended.filter(x => String(x?.sourceTag || '') === 'collector-fof');
  const byVia = {};
  for (const x of collector) {
    const k = String(x?.via || '');
    if (k) byVia[k] = (byVia[k] || 0) + 1;
  }
  const out = {
    ...(prev && typeof prev === 'object' ? prev : {}),
    ok: root.ok, generatedAt: Date.now(), generatedAtIso: new Date().toISOString(),
    root: { steamId64, name: root.ownerName || '' },
    declaredTotal: root.declaredTotal,
    direct, extended, scanNotes, byVia,
    source: collector.length ? '已登录 Steam 网页端 · 好友列表页'
      : `Steam 社区好友列表（${root.via || '联网'}）`,
    note: root.ok
      ? (collector.length ? '' : (depth > 0 && !extended.length && scanNotes.length ? scanNotes[0] : ''))
      : (root.error || '好友列表不可见（可能设为私密）')
  };
  if (root.ok) writeJson(DISCOVER_FILE, out);
  return out;
}

function discovered() { return readJson(DISCOVER_FILE, null); }

/**
 * 汇总「某一位好友到底有什么成就」：按游戏分组，带上每条成就的中文名、
 * 说明、图标、是否已解锁与解锁时间（精确到秒）。前端直接在好友面板展示。
 */
function friendSummary(steamId64) {
  const id = String(steamId64 || '');
  const empty = {
    ok: false, steamId64: id, ownerName: '', games: [], unlocked: [],
    totalAchievements: 0, totalUnlocked: 0,
    reason: '还没有从 Steam 读取过这位好友的成就。选一款游戏后点「读取成就」即可。'
  };
  if (!isId(id)) return { ...empty, reason: 'SteamID64 格式不正确。' };
  const dir = path.join(CACHE_DIR, id);
  const games = [];
  let ownerName = '';
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/^\d+\.json$/.test(f)) continue;
      const j = readJson(path.join(dir, f), null);
      if (!j || !j.ok || !Array.isArray(j.achievements)) continue;
      if (!ownerName && j.ownerName) ownerName = j.ownerName;
      const appid = String(j.appid || f.replace('.json', ''));
      const gameName = j.appName || j.name || ('AppID ' + appid);
      const list = j.achievements.map(a => ({ ...a, appid, gameName }));
      games.push({
        appid, name: gameName, achievements: list,
        achievementTotal: list.length,
        achievementUnlocked: list.filter(a => a.unlocked).length,
        fetchedAtIso: j.fetchedAtIso || null, source: j.achievementSource || ''
      });
    }
  } catch { return empty; }
  if (!games.length) return empty;
  games.sort((a, b) => b.achievementUnlocked - a.achievementUnlocked
    || String(a.name).localeCompare(String(b.name), 'zh-CN'));
  const unlocked = games.flatMap(g => g.achievements.filter(a => a.unlocked))
    .sort((a, b) => String(b.unlockedIso || '').localeCompare(String(a.unlockedIso || '')));
  return {
    ok: true, steamId64: id, ownerName, games, unlocked,
    totalAchievements: games.reduce((s, g) => s + g.achievementTotal, 0),
    totalUnlocked: unlocked.length,
    generatedAtIso: new Date().toISOString(),
    source: 'Steam 社区公开成就页 · 本机永久缓存'
  };
}

/** 给离线快照用：把已缓存的好友成就打包 */
function snapshot() {
  const out = {};
  try {
    if (!fs.existsSync(CACHE_DIR)) return out;
    for (const dir of fs.readdirSync(CACHE_DIR)) {
      if (!isId(dir)) continue;
      for (const f of fs.readdirSync(path.join(CACHE_DIR, dir))) {
        if (!/^\d+\.json$/.test(f)) continue;
        const j = readJson(path.join(CACHE_DIR, dir, f), null);
        if (j && j.ok) out[dir + ':' + f.replace('.json', '')] = j;
      }
    }
  } catch {}
  return out;
}

/** 缓存管理用：删除某个好友 / 某款游戏的成就缓存 */
function clearCache(steamId64, appid) {
  let removed = 0;
  const del = p => { try { if (fs.existsSync(p)) { fs.unlinkSync(p); removed++; } } catch {} };
  if (isId(steamId64) && isApp(appid)) del(cachePath(steamId64, appid));
  else if (isId(steamId64)) {
    const dir = path.join(CACHE_DIR, steamId64);
    try { for (const f of fs.readdirSync(dir)) { del(path.join(dir, f)); } fs.rmdirSync(dir); } catch {}
  } else del(DISCOVER_FILE);
  return removed;
}

module.exports = {
  getFriendAchievements, fetchFriendAchievements, discoverFriends, discovered,
  parseAchievementHtml, parseFriendsHtml, snapshot, friendSummary, clearCache,
  cachePath, CACHE_DIR, DISCOVER_FILE
};
