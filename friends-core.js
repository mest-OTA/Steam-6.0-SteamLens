/**
 * SteamLens · 好友上线系统（零第三方依赖）
 *
 * 三层数据：
 *  1. 本地名册：userdata/<id>/config/localconfig.vdf 的 friends 段（昵称、头像哈希），无需联网。
 *  2. 实时状态：Steam Web API GetFriendList + GetPlayerSummaries（需要 API Key）。
 *     无 Key 时可粘贴 GetPlayerSummaries 的 JSON 手动导入。
 *  3. 事件记录：后台轮询对比状态变化，写入 data/friend-events.json，
 *     形成「谁刚上线 / 谁下线 / 开始玩什么」时间线与在线时长统计。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const core = require('./steam-core');
const notify = require('./notify-core');

const DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DIR, 'friend-state.json');
const EVENT_FILE = path.join(DIR, 'friend-events.json');
const STATS_FILE = path.join(DIR, 'friend-stats.json');
const META_FILE = path.join(DIR, 'friends-meta.json');
const AVATAR_DIR = path.join(DIR, 'friend-avatars');
/* 浏览器已登录 Steam 会话采集到的好友在线状态（无需 Web API Key） */
const BROWSER_FRIEND_FILE = path.join(DIR, 'browser-friends.json');
const BROWSER_FRIEND_TTL = 10 * 60 * 1000;   // 10 分钟内视为有效状态源
/* Steam 客户端「好友与聊天」窗口直读的实时状态（主数据源，全自动、无需 Key） */
const STEAM_CLIENT_FILE = path.join(DIR, 'steam-client-friends.json');
const STEAM_CLIENT_TTL = 5 * 60 * 1000;
/* 「只删软件上的好友」：被移除的 SteamID64 永久记在这里，重新扫描 / 重启服务都不会复活；
   绝不调用任何 Steam 接口去删除 / 取消好友关系。 */
const REMOVED_FILE = path.join(DIR, 'friend-removals.json');
/* 最近一次从 Steam 客户端 / 网页端确认过的真实好友名单（TTL 过期后仍可作为依据） */
const ROSTER_FILE = path.join(DIR, 'steam-friend-roster.json');
/* 关闭软件时保存的好友列表快照：下次打开先显示它，再去 Steam 更新 */
const LIST_CACHE_FILE = path.join(DIR, 'friend-list-cache.json');

const ACCOUNT_BASE = 76561197960265728n;
const STATE_LABEL = { 0: '离线', 1: '在线', 2: '忙碌', 3: '离开', 4: '打盹', 5: '想交易', 6: '想玩游戏' };
const STATE_TONE = { 0: 'off', 1: 'on', 2: 'busy', 3: 'away', 4: 'away', 5: 'on', 6: 'on' };

function readJson(f, fallback) { return core.safeRead(f) ? (() => { try { return JSON.parse(core.safeRead(f)); } catch { return fallback; } })() : fallback; }
function writeJson(f, obj) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj, null, 2), 'utf8'); }
function listDir(p) { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD

function accountTo64(id) {
  try { return (ACCOUNT_BASE + BigInt(String(id))).toString(); } catch { return ''; }
}
function steam64ToAccount(id) {
  try { return (BigInt(String(id)) - ACCOUNT_BASE).toString(); } catch { return ''; }
}

/* ------------------------------ 本地名册 ------------------------------ */

function mySteamId() {
  const cfg = core.getConfig();
  if (cfg.steamId64) return String(cfg.steamId64);
  for (const r of core.detectSteamRoots()) {
    const users = core.vdfFile(path.join(r.path, 'config', 'loginusers.vdf')).users || {};
    const entries = Object.entries(users).filter(([, u]) => u && typeof u === 'object');
    entries.sort((a, b) => num(b[1].timestamp) - num(a[1].timestamp));
    if (entries.length) return entries[0][0];
  }
  return '';
}

function scanLocalFriends() {
  const byId = new Map();
  const push = (k, f, selfId, source) => {
    if (!/^\d+$/.test(String(k)) || !f || typeof f !== 'object') return;
    if (String(k) === String(selfId)) return;               // 跳过自己
    const name = String(f.name || (f.NameHistory && (f.NameHistory['0'] || f.NameHistory['1'])) || '').trim();
    if (!name) return;
    const id64 = accountTo64(k);
    /* Steam 个人账号的 SteamID64 恒为 7656119 开头的 17 位数字。
       localconfig.vdf 的 friends 段偶尔会混进游戏 / 组 ID，换算后变成 19 位数字，
       以前就被当成好友显示出来（BONELAB、GTA V 这类游戏名就是这么混进来的）。 */
    if (!/^7656119\d{10}$/.test(id64) || byId.has(id64)) return;
    byId.set(id64, {
      steamId64: id64, accountId: String(k), name,
      avatarHash: String(f.avatar || ''), source
    });
  };

  for (const r of core.detectSteamRoots()) {
    const base = path.join(r.path, 'userdata');
    for (const d of listDir(base)) {
      if (!d.isDirectory() || !/^\d+$/.test(d.name)) continue;
      const selfId = d.name;
      const cfgDir = path.join(base, selfId, 'config');

      // 主来源：localconfig.vdf 的 friends 段
      const candidates = [
        [path.join(cfgDir, 'localconfig.vdf'), 'UserLocalConfigStore'],
        [path.join(cfgDir, 'sharedconfig.vdf'), null],
        [path.join(cfgDir, 'config.vdf'), null],
        [path.join(base, selfId, '7', 'remote', 'sharedconfig.vdf'), null],
        [path.join(r.path, 'config', 'config.vdf'), null]
      ];
      for (const [file, rootKey] of candidates) {
        let v;
        try { v = core.vdfFile(file); } catch { continue; }
        if (!v || typeof v !== 'object') continue;
        // 可能挂在 UserLocalConfigStore / Software.Valve.Steam / 顶层
        const scopes = rootKey
          ? [v[rootKey], v]
          : [v, v.UserLocalConfigStore, v.Software?.Valve?.Steam, v.config];
        for (const scope of scopes) {
          if (!scope || typeof scope !== 'object') continue;
          for (const key of ['friends', 'Friends', 'friendlist']) {
            const block = scope[key];
            if (!block || typeof block !== 'object') continue;
            for (const [k, f] of Object.entries(block)) push(k, f, selfId, '本机缓存名册');
          }
        }
      }
    }
  }
  return [...byId.values()];
}

/** 优先用本地 avatarcache；找不到时返回 null（是否走 CDN 由前端开关决定） */
function localAvatarFile(steamId64, hash) {
  for (const r of core.detectSteamRoots()) {
    const dir = path.join(r.path, 'config', 'avatarcache');
    const names = [steamId64 + '.png', steamId64 + '.jpg', steamId64 + '.jpeg'];
    if (hash) names.push(hash + '_full.jpg', hash + '_medium.jpg', hash + '.jpg', hash + '.png');
    for (const n of names) {
      const f = path.join(dir, n);
      if (core.exists(f)) return f;
    }
  }
  // 之前由本系统缓存下来的头像
  for (const n of [steamId64 + '.jpg', steamId64 + '.png']) {
    const f = path.join(AVATAR_DIR, n);
    if (core.exists(f)) return f;
  }
  return null;
}

/* ------------------------------ 配置 / 元数据 ------------------------------ */

function getMeta() {
  return Object.assign({ starred: [], manual: [], notifySound: false }, readJson(META_FILE, {}));
}
function saveMeta(patch) {
  const m = Object.assign(getMeta(), patch || {});
  writeJson(META_FILE, m);
  return m;
}
function friendConfig() {
  const c = core.getConfig();
  return {
    friendPollSec: Math.min(3600, Math.max(15, num(c.friendPollSec) || 60)),
    friendNotify: c.friendNotify !== false,
    friendLoadRemoteAvatars: !!c.friendLoadRemoteAvatars,
    friendPastedSummaries: c.friendPastedSummaries || '',
    hasApiKey: !!c.apiKey,
    autoPruneNonFriends: c.autoPruneNonFriends !== false,
    mySteamId: mySteamId()
  };
}

/* ------------------------------ Web API ------------------------------ */

function fetchJson(url, timeout = 22000) {
  // 复用数据内核的双通道请求：Steam Web API 首次握手较慢，且某些环境需要 WinHTTP 回退
  return core.fetchJson(url, timeout);
}

/* Steam Web API Key 固定是 32 位十六进制。config.json 里的 apiKey 若填的是
   Server酱 SendKey（SCT... 开头）之类，拿去请求 api.steampowered.com 必定失败，
   还会白等两次 22 秒超时，让「打开软件」卡住。这里先做格式校验直接跳过。 */
function isSteamWebApiKey(key) { return /^[0-9A-Fa-f]{32}$/.test(String(key || '').trim()); }

async function fetchFriendList(key, myId) {
  const u = `https://api.steampowered.com/ISteamUser/GetFriendList/v0001/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(myId)}&relationship=friend&format=json`;
  const j = await fetchJson(u);
  return (j?.friendslist?.friends || []).map(f => String(f.steamid)).filter(Boolean);
}

async function fetchSummaries(key, ids) {
  const players = [];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const u = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${encodeURIComponent(key)}&steamids=${batch.join(',')}`;
    const j = await fetchJson(u);
    players.push(...(j?.response?.players || []));
    if (i + 100 < ids.length) await new Promise(r => setTimeout(r, 220));
  }
  return players;
}

function parsePasted(text) {
  if (!text || !String(text).trim()) return [];
  const j = JSON.parse(String(text));
  const arr = j?.response?.players || j?.players || (Array.isArray(j) ? j : null);
  if (!Array.isArray(arr)) throw new Error('JSON 里找不到 response.players');
  return arr;
}

/* ------------------------------ 刷新与事件 ------------------------------ */

function loadState() { return readJson(STATE_FILE, { ts: 0, friends: {} }); }
function loadEvents() { const e = readJson(EVENT_FILE, []); return Array.isArray(e) ? e : []; }
function loadStats() { return readJson(STATS_FILE, {}); }

/** 浏览器会话状态：由 browser-core 的采集器写入，本模块只读，避免循环依赖 */
function loadBrowserFriends() {
  try {
    const j = JSON.parse(fs.readFileSync(BROWSER_FRIEND_FILE, 'utf8'));
    if (!j || !Array.isArray(j.friends) || !j.friends.length) return null;
    const age = Date.now() - num(j.ts);
    if (age > BROWSER_FRIEND_TTL || age < -60000) return null;
    return j;
  } catch { return null; }
}
function hasBrowserStates() { return !!loadBrowserFriends(); }

/** Steam 客户端 CEF 直读：本机文件由 steam-client-core 写入，这里只读 */
function loadSteamClientFriends() {
  try {
    const j = JSON.parse(fs.readFileSync(STEAM_CLIENT_FILE, 'utf8'));
    if (!j || !Array.isArray(j.friends) || !j.friends.length) return null;
    const age = Date.now() - num(j.ts);
    if (age > STEAM_CLIENT_TTL || age < -60000) return null;
    return j;
  } catch { return null; }
}
function hasSteamClientStates() { return !!loadSteamClientFriends(); }
function steamClientSummary() {
  const j = loadSteamClientFriends();
  if (!j) return { active: false, count: 0, online: 0, secondsAgo: null, port: 0, error: '' };
  return {
    active: true, count: j.friends.length,
    online: j.friends.filter(f => num(f.personastate) > 0).length,
    secondsAgo: Math.max(0, Math.round((Date.now() - num(j.ts)) / 1000)),
    at: num(j.ts), port: num(j.port), nodes: num(j.nodes),
    unmapped: num(j.unmapped), pageTitle: String(j.pageTitle || '')
  };
}

function browserFriendSummary() {
  const j = loadBrowserFriends();
  if (!j) return { active: false, count: 0, online: 0, secondsAgo: null, page: '' };
  return {
    active: true, count: j.friends.length,
    online: j.friends.filter(f => num(f.personastate) > 0).length,
    secondsAgo: Math.max(0, Math.round((Date.now() - num(j.ts)) / 1000)),
    page: String(j.page || ''), at: num(j.ts)
  };
}

async function refresh(opts = {}) {
  const cfg = core.getConfig();
  const fc = friendConfig();
  const meta = getMeta();
  const warnings = [];
  const now = Date.now();
  /* 只有真正的 Steam Web API Key 才联网；Server酱 SendKey 等无效值直接跳过，
     否则每次刷新都要白等两次网络超时，软件打开时好友区会一直转圈。 */
  const apiKey = isSteamWebApiKey(cfg.apiKey) ? String(cfg.apiKey).trim() : '';
  if (cfg.apiKey && !apiKey) {
    warnings.push('配置里的 apiKey 不是 Steam Web API Key（应为 32 位十六进制，当前像是 Server酱 SendKey），已跳过 Web API 请求；好友状态改由本机 Steam 客户端 / 采集器读取。');
  }

  // 1) 名册：本地缓存 + 手动添加 + Web API 好友列表
  const map = new Map();
  for (const f of scanLocalFriends()) map.set(f.steamId64, { ...f });
  for (const m of meta.manual) {
    if (m && m.steamId64 && !map.has(String(m.steamId64))) {
      map.set(String(m.steamId64), { steamId64: String(m.steamId64), name: m.name || '', avatarHash: '', source: '手动添加' });
    }
  }

  let apiIds = [];
  if (apiKey && fc.mySteamId) {
    try {
      apiIds = await fetchFriendList(apiKey, fc.mySteamId);
      if (!apiIds.length) warnings.push('GetFriendList 返回空：好友列表可能设为私密，或账号暂无好友。');
    } catch (e) {
      warnings.push(`GetFriendList 失败：${e.message}（继续使用本机缓存名册）`);
    }
  }
  for (const id of apiIds) if (!map.has(id)) map.set(id, { steamId64: id, name: '', avatarHash: '', source: 'GetFriendList' });

  /* ★ 无 API Key 路径：浏览器已登录的 Steam 社区会话（同源只读）采集到的实时状态。
     这是唯一能在不填 Key、不碰账号密码的前提下持续监控上线的数据源。 */
  const browserSession = loadBrowserFriends();
  const browserPlayers = (browserSession?.friends || []).map(f => ({
    steamid: String(f.steamid || f.steamId64 || ''),
    personaname: String(f.personaname || f.name || ''),
    personastate: num(f.personastate),
    gameextrainfo: String(f.gameextrainfo || f.game || ''),
    gameid: f.gameid || '',
    avatarfull: f.avatarfull || '',
    profileurl: f.profileurl || ''
  })).filter(p => /^\d{17}$/.test(p.steamid));
  for (const p of browserPlayers) {
    if (!map.has(p.steamid)) {
      map.set(p.steamid, { steamId64: p.steamid, name: p.personaname || '', avatarHash: '', source: '浏览器会话' });
    }
  }

  /* ★ 主数据源：Steam 客户端「好友与聊天」窗口里显示的状态，本机直读、全自动。
     好友一上线，Steam 自己的 DOM 立刻变，这里无需 Key / 浏览器脚本就能跟上。 */
  const steamClientPlayers = (loadSteamClientFriends()?.friends || []).map(f => ({
    steamid: String(f.steamid || ''),
    personaname: String(f.personaname || ''),
    personastate: num(f.personastate),
    gameextrainfo: String(f.gameextrainfo || ''),
    avatarfull: f.avatarfull || ''
  })).filter(p => /^\d{17}$/.test(p.steamid));
  for (const p of steamClientPlayers) {
    if (!map.has(p.steamid)) {
      map.set(p.steamid, { steamId64: p.steamid, name: p.personaname || '', avatarHash: '', source: 'Steam 客户端' });
    }
  }

  /* 记住这次确认过的 Steam 真实好友名单（供「只删软件好友」识别用） */
  try { steamFriendRoster(); } catch {}
  /* ★ 已从软件删除的好友：在所有来源合并之后统一过滤。
     重新扫描 localconfig.vdf、浏览器采集器回传、服务重启，都不会让他们复活。 */
  const hidden = removedIds();
  for (const id of hidden) map.delete(id);
  /* 任何来源混进来的非个人 SteamID64（游戏 / 组 ID 换算出的 19 位数字）一律不进好友列表 */
  for (const id of [...map.keys()]) if (!/^7656119\d{10}$/.test(String(id))) map.delete(id);

  const ids = [...map.keys()].slice(0, 400);
  let players = [];
  let dataMode = 'roster';
  let sourceNote = '';
  if (apiKey && ids.length) {
    try { players = await fetchSummaries(apiKey, ids); dataMode = 'live'; }
    catch (e) { warnings.push(`GetPlayerSummaries 失败：${e.message}`); }
  }
  // 浏览器会话是实时的，优先于一次性粘贴的静态 JSON
  if (!players.length && browserPlayers.length) {
    players = browserPlayers;
    dataMode = 'browser';
    sourceNote = `浏览器已登录会话 · ${browserPlayers.length} 位好友 · ${browserFriendSummary().secondsAgo} 秒前同步`;
  }
  if (!players.length && cfg.friendPastedSummaries) {
    try { players = parsePasted(cfg.friendPastedSummaries); dataMode = 'pasted'; }
    catch (e) { warnings.push(`粘贴的 JSON 解析失败：${e.message}`); }
  }

  /* Steam 客户端状态是本地实时的：覆盖 Web API / 浏览器会话的同名好友状态，
     并补上名册里还没有的好友。这样「好友一上线 → Steam 界面变化 → 面板立刻显示」。 */
  if (steamClientPlayers.length) {
    const merged = new Map(players.map(p => [String(p.steamid), p]));
    for (const sp of steamClientPlayers) {
      const cur = merged.get(sp.steamid) || {};
      merged.set(sp.steamid, {
        ...cur,
        steamid: sp.steamid,
        personaname: sp.personaname || cur.personaname || '',
        personastate: sp.personastate,
        gameextrainfo: sp.gameextrainfo || '',
        avatarfull: sp.avatarfull || cur.avatarfull || ''
      });
    }
    players = [...merged.values()];
    if (dataMode !== 'live') dataMode = 'steam-client';
    const sc = steamClientSummary();
    sourceNote = `Steam 客户端实时状态 · ${sc.count} 位好友（${sc.online} 位在线）· ${sc.secondsAgo} 秒前同步`;
  }

  if (dataMode === 'roster') {
    warnings.push('在线状态未知：没有读取到 Steam 客户端好友列表，也没有 Web API Key / 浏览器会话。请在 Steam 客户端打开「好友与聊天」窗口（可以最小化）。');
  } else if (dataMode === 'steam-client') {
    warnings.push('正在直接读取 Steam 客户端好友列表：好友上线 / 开始玩游戏会自动出现在面板，并触发你设置的通知。保持 Steam 客户端和「好友与聊天」窗口开着即可。');
  } else if (dataMode === 'browser') {
    warnings.push('正在使用浏览器已登录会话读取好友状态：保持那个 Steam 社区页面和采集器开着，即可持续记录上线。');
  }

  const pById = new Map(players.map(p => [String(p.steamid), p]));
  const prev = loadState();
  const events = loadEvents();
  const stats = loadStats();
  const day = today();
  stats[day] = stats[day] || {};
  const newEvents = [];
  const newStarredOnline = [];
  const eventsForNotify = [];   // 上线 + 退出 Steam 都要推送给用户自己
  const elapsedMin = prev.ts ? Math.min(120, (now - prev.ts) / 60000) : 0;

  const friends = [];
  for (const f of map.values()) {
    const p = pById.get(f.steamId64);
    const starred = meta.starred.includes(f.steamId64);
    const item = {
      ...f, starred,
      personastate: null, stateLabel: '状态未知', tone: 'unknown',
      game: '', gameId: '', lastLogoff: 0, profileUrl: '', visibility: null,
      live: false, localAvatar: !!localAvatarFile(f.steamId64, f.avatarHash),
      avatar: null
    };
    if (p) {
      const st = num(p.personastate);
      item.name = p.personaname || item.name || `Steam ${f.steamId64.slice(-6)}`;
      item.personastate = st;
      item.stateLabel = STATE_LABEL[st] || '未知';
      item.tone = STATE_TONE[st] || 'unknown';
      item.game = p.gameextrainfo || '';
      item.gameId = p.gameid || '';
      item.lastLogoff = num(p.lastlogoff);
      item.profileUrl = p.profileurl || '';
      item.visibility = num(p.communityvisibilitystate);
      item.avatarFull = p.avatarfull || p.avatarmedium || '';
      item.live = true;
    }
    if (!item.name) item.name = `Steam ${f.steamId64.slice(-6)}`;
    item.avatar = localAvatarFile(f.steamId64, f.avatarHash)
      ? `/api/friend-avatar/${f.steamId64}`
      : (fc.friendLoadRemoteAvatars ? (item.avatarFull || (f.avatarHash ? `https://avatars.akamai.steamstatic.com/${f.avatarHash}_full.jpg` : '')) : '');
    item.ownerAccount = fc.mySteamId;
    friends.push(item);

    // 状态变化检测
    const before = prev.friends?.[f.steamId64];
    if (before && item.live && elapsedMin > 0) {
      if (before.personastate > 0) {
        const rec = stats[day][f.steamId64] || (stats[day][f.steamId64] = { onlineMinutes: 0, logins: 0, name: item.name });
        rec.onlineMinutes = Math.round((rec.onlineMinutes + elapsedMin) * 10) / 10;
        rec.name = item.name;
      }
      // 从「离线 / 状态未知」变为在线都算上线。首次接上 Steam 客户端时基线可能是 null，
      // 如果只认 0 就会漏掉用户最关心的那一次「朋友上线了」。
      const wasAway = before.personastate === 0 || before.personastate === null
        || before.personastate === undefined || !Number.isFinite(Number(before.personastate));
      if (wasAway && item.personastate > 0) {
        const ev = {
          ts: now, iso: new Date(now).toISOString(), steamId64: f.steamId64,
          name: item.name, type: 'online', game: item.game || '',
          text: `${item.name} 上线了`
        };
        newEvents.push(ev);
        eventsForNotify.push({ ev, starred });
        const rec = stats[day][f.steamId64] || (stats[day][f.steamId64] = { onlineMinutes: 0, logins: 0, name: item.name });
        rec.logins++;
        rec.name = item.name;
        if (starred) newStarredOnline.push(item);
      } else if (before.personastate > 0 && item.personastate === 0) {
        const ev = {
          ts: now, iso: new Date(now).toISOString(), steamId64: f.steamId64,
          name: item.name, type: 'offline', text: `${item.name} 退出 Steam 了（已离线）`
        };
        newEvents.push(ev);
        eventsForNotify.push({ ev, starred });
      } else if (before.game !== item.game && item.game) {
        newEvents.push({ ts: now, iso: new Date(now).toISOString(), steamId64: f.steamId64, name: item.name, type: 'game', text: `${item.name} 开始玩 ${item.game}`, game: item.game });
      }
    }
  }

  if (newEvents.length) {
    events.push(...newEvents);
    if (events.length > 800) events.splice(0, events.length - 800);
    writeJson(EVENT_FILE, events);
  }
  // ★ 系统级通知：好友上线 / 退出 Steam 都会触发
  //   Windows 原生弹窗 / Webhook / QQ 邮箱 / 微信 / QQ / 钉钉。
  //   由服务端触发，因此面板关着、浏览器没开也照样送达。
  for (const o of eventsForNotify) {
    notify.notifyFriendEvent(o.ev, { starred: o.starred })
      .catch(e => console.error('[SteamLens 通知]', e.message));
  }
  writeJson(STATS_FILE, stats);
  /* 没有任何状态源时不要覆盖基线：否则会把上一次真实的在线/离线状态冲成 null，
     等浏览器采集器恢复上报时就再也比对不出「谁刚上线」。 */
  if (dataMode !== 'roster') {
    writeJson(STATE_FILE, {
      ts: now, iso: new Date(now).toISOString(), dataMode,
      friends: Object.fromEntries(friends.filter(f => f.live)
        .map(f => [f.steamId64, { personastate: f.personastate, game: f.game, name: f.name }]))
    });
  }

  const online = friends.filter(f => f.personastate > 0);
  const ingame = friends.filter(f => !!f.game);
  const dayStats = stats[day] || {};
  const hourBuckets = Array.from({ length: 24 }, () => 0);
  const chartFrom = rangeStart('1d', Date.now());
  const chartPresence = computeHourPresence(events, online.length, new Date().getHours(), chartFrom);
  for (const e of events) {
    if (!e || typeof e.ts !== 'number' || e.ts < chartFrom) continue;   // ★ 每天 00:00 自动清零，昨天的数据不再留到今天
    if (['online', 'game', 'offline'].includes(e.type)) hourBuckets[new Date(e.ts).getHours()]++;
  }
  const topFriends = Object.entries(dayStats)
    .map(([id, v]) => ({ steamId64: id, name: v.name || id, onlineMinutes: v.onlineMinutes || 0, logins: v.logins || 0 }))
    .sort((a, b) => b.onlineMinutes - a.onlineMinutes).slice(0, 8);

  return {
    generatedAt: new Date(now).toISOString(),
    dataMode,
    dataModeLabel: {
      live: '实时 · Steam Web API（客户端状态同步）',
      'steam-client': '实时 · Steam 客户端直读',
      browser: '实时 · 浏览器已登录会话',
      pasted: '手动导入 JSON',
      roster: '仅本机名册（状态未知）'
    }[dataMode],
    mySteamId: fc.mySteamId,
    warnings,
    config: fc,
    sourceNote,
    steamClient: steamClientSummary(),
    browserSession: browserFriendSummary(),
    hasBaseline: !!prev.ts,
    totals: {
      friends: friends.length,
      online: online.length,
      ingame: ingame.length,
      busy: friends.filter(f => f.personastate === 2).length,
      away: friends.filter(f => [3, 4].includes(f.personastate)).length,
      offline: friends.filter(f => f.personastate === 0).length,
      unknown: friends.filter(f => f.personastate === null).length,
      starred: friends.filter(f => f.starred).length,
      localCached: friends.filter(f => f.source === '本机缓存名册').length
    },
    friends: friends.sort((a, b) => {
      if (a.starred !== b.starred) return a.starred ? -1 : 1;
      return (b.personastate ?? -1) - (a.personastate ?? -1) || a.name.localeCompare(b.name);
    }),
    events: events.slice(-100).reverse(),
    stats: {
      todayLogins: events.filter(e => e.type === 'online' && today() === new Date(e.ts).toLocaleDateString('sv-SE')).length,
      todayOnlineMinutes: Math.round(Object.values(dayStats).reduce((s, v) => s + (v.onlineMinutes || 0), 0) * 10) / 10,
      topFriends, hourBuckets,
      hourPresence: chartPresence,
      hourRange: '1d', hourRangeFrom: chartFrom,
      mode: 'hour', buckets: hourBuckets, presence: chartPresence,
      labels: Array.from({ length: 24 }, (_, i) => String(i)),
      hourSeconds: computeHourSeconds(events, Date.now()),
      totalEvents: events.length
    },
    newStarredOnline: newStarredOnline.map(f => ({ name: f.name, game: f.game, steamId64: f.steamId64 })),
    privacy: {
      statement: '好友名册来自本机 Steam 缓存；实时状态来自 Steam Web API Key 或你在 steamcommunity.com 已登录会话里运行的只读采集器（无需 Key）。所有记录只写入本机 data/ 目录，不上传第三方。',
      caveat: '上线事件由轮询对比得出，精度取决于轮询间隔；Steam 私密资料可能返回有限信息。'
    }
  };
}

/* ------------------------------------------------------------------ */
/* 每秒视图：上线时段分布（不联网、不写盘，前端可每秒调用）              */
/* ------------------------------------------------------------------ */
let hourlyTick = { at: 0, hour: -1, seconds: 0, friendSeconds: 0 };

/** 时间范围起点：1d = 今天 00:00（跨天自动清零）、14d / 30d = 最近 N 天 */
const HOUR_RANGES = { '1d': 1, '14d': 14, '30d': 30 };
function rangeStart(range = '1d', now = Date.now()) {
  if (range === '14d') return now - 14 * 86400000;
  if (range === '30d' || range === 'month') return now - 30 * 86400000;
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}
function rangeLabel(range) {
  return range === '14d' ? '近 14 天' : (range === '30d' || range === 'month') ? '近 30 天（月）' : '今天';
}

/** 按「天」统计：days 根柱子，从最早一天到今天。
 *  当天只要出现过上线 / 游戏中 / 下线记录就点亮（跨天在线也算），
 *  counts 记的是当天的上线次数，用于柱高与 tooltip。 */
function dayBuckets(events, days, now = Date.now()) {
  const base = new Date(now);
  base.setHours(0, 0, 0, 0);
  const labels = [], counts = [], presence = [];
  const evs = (events || []).filter(e => e && typeof e.ts === 'number');
  for (let i = days - 1; i >= 0; i--) {
    const start = base.getTime() - i * 86400000;
    const end = start + 86400000;
    const d = new Date(start);
    labels.push(`${d.getMonth() + 1}/${d.getDate()}`);
    let logins = 0, any = false;
    for (const e of evs) {
      if (e.ts < start || e.ts >= end) continue;
      if (['online', 'game', 'offline'].includes(e.type)) {
        any = true;
        if (e.type === 'online' || e.type === 'game') logins++;
      }
    }
    counts.push(logins);
    presence.push(any);
  }
  return { labels, counts, presence };
}

/** 还原「每个小时是否在线过」：只统计 fromTs 之后的事件（跨天自动清零），
 *  并把当前实时在线并入当前小时。返回长度 24 的布尔数组。 */
function computeHourPresence(events, liveNow, currentHour, fromTs = 0) {
  const present = new Array(24).fill(false);
  const all = (events || []).filter(e => e && typeof e.ts === 'number').sort((a, b) => a.ts - b.ts);
  const markSpan = (from, toTs) => {
    let h = new Date(Math.max(from, fromTs)).getHours();
    const endH = new Date(toTs).getHours();
    for (let k = 0; k <= 24; k++) {
      present[h] = true;
      if (h === endH) break;
      h = (h + 1) % 24;
    }
  };
  // 范围之前「已上线且还没下线」的会话，跨天继续算在线（起点截到本范围）
  let carried = null;
  for (const e of all) {
    if (e.ts >= fromTs) break;
    if (e.type === 'online' || e.type === 'game') { if (carried == null) carried = e.ts; }
    else if (e.type === 'offline') carried = null;
  }
  let start = carried != null ? Math.max(carried, fromTs) : null;
  for (const e of all) {
    if (e.ts < fromTs) continue;
    const hh = new Date(e.ts).getHours();
    if (e.type === 'online' || e.type === 'game') {
      if (start == null) start = e.ts;
      present[hh] = true;
    } else if (e.type === 'offline') {
      if (start != null) { markSpan(start, e.ts); start = null; }
      present[hh] = true;            // 退出前的这一小时一定在线过
    }
  }
  if (start != null) markSpan(start, Date.now());           // 仍在线（尚未收到 offline）
  if (liveNow > 0 && currentHour >= 0) present[currentHour] = true;  // 实时在线立即点亮当前小时
  return present;
}

/** 计算每个小时「好友累计在线时长（秒）」：把 online→offline 区间按小时切分累加。
 *  用于上线时段分布图的悬浮提示：这一个小时玩了多少分钟、多少秒。 */
function computeHourSeconds(events, now = Date.now()) {
  const secs = new Array(24).fill(0);
  const sorted = (events || []).filter(e => e && typeof e.ts === 'number').sort((a, b) => a.ts - b.ts);
  const open = {};                 // 每个好友当前未闭合的「上线起点」
  const intervals = [];            // 已闭合的 [start,end]
  for (const e of sorted) {
    const id = String(e.steamId64 || '__all__');
    if (e.type === 'online' || e.type === 'game') { if (open[id] == null) open[id] = e.ts; }
    else if (e.type === 'offline') { if (open[id] != null) { intervals.push([open[id], e.ts]); open[id] = null; } }
  }
  for (const id in open) if (open[id] != null) intervals.push([open[id], now]);
  for (const [s, e] of intervals) {
    if (!(e > s)) continue;
    let t = s;
    while (t < e) {
      const h = new Date(t).getHours();
      const endOfHour = new Date(t); endOfHour.setMinutes(59, 59, 999);
      const end = Math.min(e, endOfHour.getTime());
      secs[h] += (end - t) / 1000;
      t = end + 1;
    }
  }
  return secs.map(s => Math.round(s));
}

function hourly(range = '1d') {
  const now = Date.now();
  const rangeKey = range === 'month' ? '30d' : (HOUR_RANGES[range] ? range : '1d');
  const from = rangeStart(rangeKey, now);
  const events = loadEvents();
  const stats = loadStats();
  const day = today();
  const dayStats = stats[day] || {};
  const hourBuckets = Array.from({ length: 24 }, () => 0);
  let rangeEvents = 0;
  for (const e of events) {
    if (!e || typeof e.ts !== 'number' || e.ts < from) continue;
    if (['online', 'game', 'offline'].includes(e.type)) {
      hourBuckets[new Date(e.ts).getHours()]++;
      rangeEvents++;
    }
  }

  const sc = loadSteamClientFriends();
  const stateFriends = Object.values(loadState().friends || {});
  const liveNow = sc
    ? sc.friends.filter(f => num(f.personastate) > 0).length
    : stateFriends.filter(f => num(f.personastate) > 0).length;

  // 当前小时的实时在线累计（人·秒）：随真实时钟每秒增长，重启后重新计时
  const hour = new Date(now).getHours();
  if (hourlyTick.hour !== hour) hourlyTick = { at: now, hour, seconds: 0, friendSeconds: 0 };
  const delta = Math.min(5, Math.max(0, (now - (hourlyTick.at || now)) / 1000));
  hourlyTick.seconds += delta;
  hourlyTick.friendSeconds += delta * liveNow;
  hourlyTick.at = now;

  const todayLogins = events.filter(e => e.type === 'online' && day === new Date(e.ts).toLocaleDateString('sv-SE')).length;
  const topFriends = Object.entries(dayStats)
    .map(([id, v]) => ({ steamId64: id, name: v.name || id, onlineMinutes: num(v.onlineMinutes), logins: num(v.logins) }))
    .sort((a, b) => b.onlineMinutes - a.onlineMinutes).slice(0, 8);
  const baseMinutes = Object.values(dayStats).reduce((s, v) => s + num(v.onlineMinutes), 0);
  let buckets, presence, labels, mode;
  if (rangeKey === '1d') {
    // 一天上线：24 根小时柱，哪小时在线过就亮
    mode = 'hour';
    labels = Array.from({ length: 24 }, (_, i) => String(i));
    buckets = hourBuckets;
    presence = computeHourPresence(events, liveNow, hour, from);
  } else {
    // 14 天 / 月上线：每天一根柱，那天上线过一次就亮
    mode = 'day';
    const d = dayBuckets(events, rangeKey === '14d' ? 14 : 30, now);
    buckets = d.counts; presence = d.presence; labels = d.labels;
    if (liveNow > 0 && presence.length) presence[presence.length - 1] = true;
  }
  return {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    pollIntervalSec: 1,
    range: rangeKey, rangeLabel: rangeLabel(rangeKey), rangeFrom: from, rangeEvents,
    hourBuckets: buckets, hourPresence: presence, buckets, presence, labels, mode,
    hourSeconds: computeHourSeconds(events, now),
    currentHour: hour, liveNow,
    liveSeconds: Math.round(hourlyTick.seconds),
    liveMinutes: Math.round(hourlyTick.friendSeconds / 60 * 10) / 10,
    todayLogins,
    todayOnlineMinutes: Math.round((baseMinutes + hourlyTick.friendSeconds / 60) * 10) / 10,
    totalEvents: events.length,
    topFriends,
    lastEventAt: events.length ? num(events[events.length - 1].ts) : 0,
    note: `每秒刷新 · 范围 ${rangeLabel(rangeKey)} · 每天 00:00 自动清零`
  };
}

/* ------------------------------------------------------------------ */
/* 每秒视图：好友离开时长（按本机记录的下线时刻逐秒累计）                */
/* ------------------------------------------------------------------ */
function away() {
  const now = Date.now();
  const events = loadEvents();
  const state = loadState();
  const byId = new Map();
  for (const e of events) {
    const id = String(e.steamId64 || '');
    if (!id) continue;
    const rec = byId.get(id) || { name: e.name || id, awaySince: 0, lastOnlineAt: 0, eventCount: 0 };
    rec.eventCount++;
    if (e.name) rec.name = e.name;
    const ts = num(e.ts) || Date.parse(e.iso || '') || 0;
    if (e.type === 'offline') rec.awaySince = ts;
    else if (e.type === 'online') { rec.awaySince = 0; rec.lastOnlineAt = ts; }
    byId.set(id, rec);
  }
  for (const f of scanLocalFriends()) {
    if (!byId.has(f.steamId64)) byId.set(f.steamId64, { name: f.name, awaySince: 0, lastOnlineAt: 0, eventCount: 0 });
  }
  const liveMap = new Map();
  const sc = loadSteamClientFriends();
  if (sc) for (const f of sc.friends) liveMap.set(String(f.steamid), num(f.personastate));
  else for (const [id, v] of Object.entries(state.friends || {})) liveMap.set(id, num(v.personastate));

  const friends = [];
  for (const [id, rec] of byId) {
    const ps = liveMap.has(id) ? num(liveMap.get(id)) : null;
    const online = ps === null ? null : ps > 0;
    let since = rec.awaySince;
    let source = since ? '本机下线事件（精准）' : '';
    if (!since && online === false) { since = num(state.ts) || 0; source = since ? '本机状态基线（估算）' : ''; }
    if (online === true) { since = 0; source = ''; }
    friends.push({
      steamId64: id, name: rec.name, personastate: ps, online: online === true,
      awaySince: since || null,
      awaySeconds: since ? Math.max(0, Math.floor((now - since) / 1000)) : null,
      awayFrom: since ? new Date(since).toISOString() : null,
      lastOnlineAt: rec.lastOnlineAt || null,
      eventCount: rec.eventCount, source
    });
  }
  friends.sort((a, b) => (a.online ? 1 : 0) - (b.online ? 1 : 0) || (b.awaySeconds || 0) - (a.awaySeconds || 0));
  return {
    ok: true, generatedAt: new Date(now).toISOString(), pollIntervalSec: 1,
    friends,
    awayCount: friends.filter(f => !f.online).length,
    longestAway: friends.find(f => !f.online && f.awaySeconds) || null,
    note: '按本机记录的下线时刻逐秒累计；好友上线时自动清零。'
  };
}

/* ------------------------------ 操作 ------------------------------ */

function setStar(id, starred) {
  const m = getMeta();
  const set = new Set(m.starred || []);
  starred ? set.add(String(id)) : set.delete(String(id));
  return saveMeta({ starred: [...set] });
}
function addManual(id, name) {
  const m = getMeta();
  const manual = (m.manual || []).filter(x => String(x.steamId64) !== String(id));
  manual.push({ steamId64: String(id), name: name || '' });
  return saveMeta({ manual: manual.slice(-100) });
}
function removeManual(id) {
  const m = getMeta();
  return saveMeta({ manual: (m.manual || []).filter(x => String(x.steamId64) !== String(id)) });
}
function clearEvents() { writeJson(EVENT_FILE, []); return []; }

/* ================================================================== */
/*  只删「软件上的好友」：以 Steam 账号好友列表为准，识别并移除多余的人    */
/*  全程只读写本机文件，绝不调用任何删除 / 取消 Steam 好友关系的接口       */
/* ================================================================== */

function rawJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function removedRecords() {
  const j = readJson(REMOVED_FILE, {});
  return (j && j.ids && typeof j.ids === 'object' && !Array.isArray(j.ids)) ? j.ids : {};
}
function removedIds() {
  return new Set(Object.keys(removedRecords()).filter(id => /^\d{17}$/.test(id)));
}

/**
 * Steam 账号里的真实好友名单。
 * 只认 Steam 客户端「好友列表」窗口 / 已登录的 Steam 网页端采集结果；
 * localconfig.vdf 的 friends 段是历史缓存名册，里面留着早就不是好友的人，
 * 绝不能当权威（软件里多出来的那几十个人正是从这里来的）。
 * TTL 过期后退回「上次确认过的名单」，保证关掉 Steam 也能识别，并标注 fresh=false。
 */
function steamFriendRoster() {
  const ids = new Set(), sources = [];
  let fresh = false;
  const addAll = (arr) => {
    for (const f of (Array.isArray(arr) ? arr : [])) {
      const id = String(f?.steamid || f?.steamId64 || '');
      if (/^\d{17}$/.test(id)) ids.add(id);
    }
  };
  const sc = loadSteamClientFriends();
  if (sc) {
    addAll(sc.friends);
    sources.push({ name: 'Steam 客户端「好友列表」', count: (sc.friends || []).length, at: num(sc.ts), fresh: true });
    fresh = true;
  }
  const br = loadBrowserFriends();
  if (br) {
    addAll(br.friends);
    sources.push({ name: '已登录 Steam 网页端', count: (br.friends || []).length, at: num(br.ts), fresh: true });
    fresh = true;
  }
  const saved = readJson(ROSTER_FILE, null);
  if (!ids.size && saved && Array.isArray(saved.ids)) {
    for (const id of saved.ids) if (/^\d{17}$/.test(String(id))) ids.add(String(id));
    sources.push({ name: '上次确认的 Steam 好友名单', count: ids.size, at: num(saved.at), fresh: false });
  }
  if (ids.size && fresh) {
    const next = { at: Date.now(), ids: [...ids], sources };
    const old = readJson(ROSTER_FILE, null);
    const same = old && Array.isArray(old.ids) && old.ids.length === next.ids.length
      && next.ids.every(x => old.ids.includes(x));
    if (!same) writeJson(ROSTER_FILE, next);
  }
  return { ids: [...ids], sources, fresh, safe: ids.size > 0 };
}

/** 软件里所有「会出现在好友列表」的 ID 与昵称：从各个数据源取并集 */
function knownFriendBook() {
  const book = new Map();
  const put = (id, name, source) => {
    id = String(id || '');
    if (!/^\d{17}$/.test(id)) return;
    const nm = String(name || '').trim();
    if (!book.has(id) || (!book.get(id).name && nm)) book.set(id, { name: nm, source });
  };
  for (const f of scanLocalFriends()) put(f.steamId64, f.name, '本机缓存名册');
  for (const m of (getMeta().manual || [])) put(m.steamId64, m.name, '手动添加');
  for (const f of (rawJson(STEAM_CLIENT_FILE)?.friends || [])) put(f.steamid, f.personaname, 'Steam 客户端');
  for (const f of (rawJson(BROWSER_FRIEND_FILE)?.friends || [])) put(f.steamid || f.steamId64, f.personaname || f.name, 'Steam 网页端');
  const st = loadState();
  for (const [id, v] of Object.entries(st.friends || {})) put(id, v?.name, '状态记录');
  for (const [id, v] of Object.entries(removedRecords())) put(id, v?.name, '已从软件删除');
  return book;
}

/** 识别结果：Steam 好友名单（保留） / 软件里多出来的人（可删） / 已删的人（可恢复） */
function analyzeFriends() {
  const roster = steamFriendRoster();
  const book = knownFriendBook();
  const hidden = removedIds();
  const trueSet = new Set(roster.ids);
  const pack = id => ({
    steamId64: id,
    name: book.get(id)?.name || `Steam ${String(id).slice(-6)}`,
    source: book.get(id)?.source || ''
  });
  const keep = roster.ids.filter(id => !hidden.has(id)).map(pack);
  const orphans = [...book.keys()].filter(id => !trueSet.has(id) && !hidden.has(id)).map(pack);
  const removed = [...hidden].map(id => ({
    ...pack(id), at: num(removedRecords()[id]?.at), reason: String(removedRecords()[id]?.reason || '')
  }));
  const missing = roster.ids.filter(id => !book.has(id)).map(pack);
  return {
    ok: true, safe: roster.safe, fresh: roster.fresh,
    sources: roster.sources, rosterCount: roster.ids.length,
    keep, orphans, missing, removed, totalShown: book.size
  };
}

/** mode:'orphans' 一键删掉所有非 Steam 好友；否则按 ids 单独删除。软删除，可恢复。 */
function removeFriends(p = {}) {
  const a = analyzeFriends();
  let ids = [];
  if (p.mode === 'orphans') {
    if (!a.safe) return { ok: false, error: '还没识别到 Steam 好友名单：请在 Steam 客户端打开「好友列表」窗口，或用浏览器登录 Steam 社区后重试。为防误删，本次没有删除任何人。' };
    ids = a.orphans.map(x => x.steamId64);
  } else {
    ids = [...new Set((Array.isArray(p.ids) ? p.ids : []).map(String))].filter(x => /^\d{17}$/.test(x));
  }
  if (!ids.length) return { ok: true, removedCount: 0, removed: [], note: '没有需要删除的好友' };
  const book = knownFriendBook();
  const recs = removedRecords();
  const now = Date.now();
  const reason = String(p.reason || (p.mode === 'orphans' ? '不在 Steam 好友列表' : '手动从软件删除'));
  for (const id of ids) recs[id] = { name: book.get(id)?.name || '', at: now, reason };
  writeJson(REMOVED_FILE, { version: 1, at: now, ids: recs });
  // 清掉状态库与「手动添加」，避免其它路径把这些人再带回来
  const st = loadState(), nf = {};
  for (const [id, v] of Object.entries(st.friends || {})) if (!ids.includes(id)) nf[id] = v;
  writeJson(STATE_FILE, { ...st, friends: nf });
  const m = getMeta();
  saveMeta({
    manual: (m.manual || []).filter(x => !ids.includes(String(x.steamId64))),
    starred: (m.starred || []).filter(x => !ids.includes(String(x)))
  });
  return {
    ok: true, removedCount: ids.length, removed: ids,
    remainingCount: analyzeFriends().keep.length,
    note: '只删除了 SteamLens 软件里的好友记录，Steam 上的好友关系没有任何改动'
  };
}
function restoreFriends(ids) {
  const recs = removedRecords();
  const list = Array.isArray(ids) && ids.length ? ids.map(String) : Object.keys(recs);
  let n = 0;
  for (const id of list) if (recs[id]) { delete recs[id]; n++; }
  writeJson(REMOVED_FILE, { version: 1, at: Date.now(), ids: recs });
  return { ok: true, restoredCount: n };
}

/* ---------------- 开关软件时的好友缓存 ---------------- */
function saveListCache(payload = {}) {
  const hidden = removedIds();
  const friends = (Array.isArray(payload.friends) ? payload.friends : [])
    .filter(f => f && !hidden.has(String(f.steamId64 || f.steamid || '')))
    .slice(0, 400);
  const data = {
    ...payload, friends,
    totals: { ...(payload.totals || {}), friends: friends.length },
    savedAt: Date.now()
  };
  try { writeJson(LIST_CACHE_FILE, { version: 1, at: Date.now(), count: friends.length, data }); }
  catch (e) { return { ok: false, error: e.message }; }
  return { ok: true, count: friends.length };
}
function listCache() { return readJson(LIST_CACHE_FILE, null); }

/**
 * 清理「不是我好友」的人：以本机真实好友名单（localconfig 名册 / Steam 客户端实时好友 / 浏览器会话好友）
 * 为基准，把状态库（friend-state）里不在真实好友名单中的条目移除。未检测到真实来源时跳过，避免误删。
 * @param {boolean} apply  true=执行删除；false=只返回将要移除的预览。
 */
function pruneNonFriends(apply) {
  const trueSet = new Set();
  for (const f of scanLocalFriends()) trueSet.add(String(f.steamId64));
  for (const f of (loadSteamClientFriends()?.friends || [])) { const id = String(f.steamid || ''); if (id) trueSet.add(id); }
  for (const f of (loadBrowserFriends()?.friends || [])) { const id = String(f.steamid || f.steamId64 || ''); if (id) trueSet.add(id); }
  const myId = mySteamId();
  if (myId) trueSet.add(myId);
  // 安全护栏：真实好友来源为空时不清理，防止把所有人误删
  if (!trueSet.size || (trueSet.size <= 1 && !scanLocalFriends().length)) {
    return { ok: true, skipped: true, reason: '未检测到真实好友来源（Steam 客户端未运行或本机无名册），本次不清理以免误删。', remove: [], removedCount: 0 };
  }
  const state = loadState();
  const stored = Object.keys(state.friends || {}).filter(Boolean);
  const manual = (getMeta().manual || []).map(m => String(m.steamId64));
  const allStored = [...new Set([...stored, ...manual])].filter(Boolean);
  const remove = allStored.filter(id => !trueSet.has(id));
  const list = remove.map(id => {
    const s = (state.friends || {})[id];
    const m = (getMeta().manual || []).find(x => String(x.steamId64) === id);
    return { steamId64: id, name: (s && s.name) || (m && m.name) || id };
  });
  const result = { ok: true, apply: !!apply, trueCount: trueSet.size, storedCount: allStored.length, remove: list, removedCount: list.length, skipped: false };
  if (apply) {
    const ns = {};
    for (const id of stored) if (trueSet.has(id)) ns[id] = (state.friends || {})[id];
    writeJson(STATE_FILE, { ...state, friends: ns });
    const nm = (getMeta().manual || []).filter(m => trueSet.has(String(m.steamId64)));
    saveMeta({ manual: nm });
    result.applied = true;
    result.remainingCount = Object.keys(ns).length;
  }
  return result;
}

function avatarFileFor(steamId64) {
  const id = String(steamId64).replace(/[^\d]/g, '');
  const local = scanLocalFriends().find(f => f.steamId64 === id);
  return localAvatarFile(id, local?.avatarHash || '');
}

module.exports = {
  refresh, friendConfig, getMeta, saveMeta, setStar, addManual, removeManual,
  clearEvents, pruneNonFriends, loadEvents, loadStats, loadState, localAvatarFile, avatarFileFor, accountTo64, steam64ToAccount,
  mySteamId, scanLocalFriends, STATE_LABEL,
  removedIds, steamFriendRoster, analyzeFriends, removeFriends, restoreFriends,
  saveListCache, listCache,
  hasBrowserStates, browserFriendSummary, loadBrowserFriends,
  hasSteamClientStates, steamClientSummary, loadSteamClientFriends, hourly, away
};
