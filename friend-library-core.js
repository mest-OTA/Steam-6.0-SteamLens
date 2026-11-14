/**
 * SteamLens · 好友「库中的游戏」直读内核（零第三方依赖）
 *
 * 用户诉求：好友档案里能看他库中的游戏，并且每秒更新一次（不再只是登录时更新一次）。
 *
 * 数据源（全部在本机 Steam 客户端内部，只读）：
 *   - friendStore.allFriends                    → 好友 accountID / 昵称 / 头像 / 正在玩的 appid
 *   - friendStore.GetOwnedGames(accountID)      → 该好友已拥有的 appid 集合
 *   - friendStore.RefreshOwnedGames(accountID)  → 让 Steam 客户端自己去刷新缓存（节流触发）
 *   - g_FriendsUIApp.m_AppInfoStore.m_mapAppInfo→ appid 对应的游戏名 / 图标 hash
 *
 * Steam 客户端把这些数据显示在它自己的界面里，本模块通过本机 CDP Runtime.evaluate
 * 只读取上述字段，不读聊天记录、不碰 Cookie / 密码 / 登录凭证、不模拟协议登录。
 *
 * 每秒 tick 一次：CDP 求值很轻（几十毫秒），结果放内存，数据变化或每 5 秒落盘一次到
 * data/friend-libraries.json；好友库为空时按 30 秒节流触发一次 Steam 自带的刷新。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const core = require('./steam-core');
const steamClient = require('./steam-client-core');

const DATA_DIR = path.join(__dirname, 'data');
const OUT_FILE = path.join(DATA_DIR, 'friend-libraries.json');
const NAMES_FILE = path.join(DATA_DIR, 'friend-library-names.json');
const POLL_MS = 1000;
const WRITE_EVERY_MS = 5000;
const EMPTY_REFRESH_GAP_MS = 30 * 1000;
const ENSURE_GAP_MS = 3000;
const ENRICH_GAP_MS = 60 * 1000;
const NAME_TTL = 7 * 24 * 3600 * 1000;
const ID_BASE = 76561197960265728n;

let cachedPort = 0;
let lastDiscoverAt = 0;
let lastWriteAt = 0;
let lastReadAt = 0;
let polls = 0;
let lastError = '';
let lastSignature = '';
let memory = null;                 // 最近一次完整结果
const refreshAt = new Map();       // accountID → 上次触发 Steam 刷新的时间
let ticking = false;
let enriching = false;
let lastEnrichAt = Date.now();   // 先给 Steam 客户端本机加载名称的机会，60 秒后才走商店兜底
let lastEnsureAt = 0;
let nameCache = (() => { try { return JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8')) || {}; } catch { return {}; } })();
let localNamesCache = null;
let localNamesAt = 0;
let enrichedCount = 0;

function atomicWrite(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  try { fs.renameSync(tmp, file); }
  catch { fs.copyFileSync(tmp, file); try { fs.unlinkSync(tmp); } catch {} }
}

function httpJson(url, timeout = 1200) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, r => {
      let d = '';
      r.on('data', c => { d += c; if (d.length > 3_000_000) req.destroy(); });
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** 找 Steam 客户端的 SharedJSContext 页面（复用好友状态内核的端口发现） */
async function sharedTarget(force = false) {
  if (!force && cachedPort && Date.now() - lastDiscoverAt < 30000) {
    try {
      const list = await httpJson(`http://127.0.0.1:${cachedPort}/json/list`);
      const t = (Array.isArray(list) ? list : []).find(x => /SharedJSContext/i.test(x.title || '') && x.webSocketDebuggerUrl);
      if (t) return { port: cachedPort, ws: t.webSocketDebuggerUrl };
    } catch {}
  }
  let port = 0;
  try { port = Number((steamClient.discover(force) || {}).port) || Number(steamClient.status().port) || 0; } catch {}
  const ports = [...new Set([port, cachedPort, 8080, 9222, 9223, 9229, 28573, 28574, 27036])].filter(Boolean);
  for (const p of ports) {
    try {
      const list = await httpJson(`http://127.0.0.1:${p}/json/list`);
      const t = (Array.isArray(list) ? list : []).find(x => /SharedJSContext/i.test(x.title || '') && x.webSocketDebuggerUrl);
      if (t) {
        cachedPort = p; lastDiscoverAt = Date.now(); lastError = '';
        return { port: p, ws: t.webSocketDebuggerUrl };
      }
    } catch {}
  }
  lastDiscoverAt = Date.now();
  lastError = '未连上 Steam 客户端：请保持 Steam 与「好友与聊天」窗口开着';
  return null;
}

function cdpEvaluate(wsUrl, expression, timeout = 3200) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { return reject(e); }
    let done = false;
    const finish = (err, val) => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('CDP 读取超时')), timeout);
    ws.onopen = () => ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate',
      params: { expression, returnByValue: true }
    }));
    ws.onmessage = e => {
      try {
        const m = JSON.parse(String(e.data || ''));
        if (m.id !== 1) return;
        const v = m.result?.result?.value;
        if (typeof v !== 'string') return finish(new Error('CDP 未返回数据'));
        finish(null, JSON.parse(v));
      } catch (err) { finish(err); }
    };
    ws.onerror = () => finish(new Error('CDP 连接失败'));
  });
}

/* 严格只遍历 Steam 客户端自己的好友 / 游戏信息对象，不读页面全文、不读聊天、不碰凭证 */
const READ_EXPR = `(function(){
  var out={ts:Date.now(),friends:[],names:{},err:''};
  try{
    var fs=window.friendStore;
    if(!fs) { out.err='friendStore 尚未就绪（Steam 好友界面还在加载）'; return JSON.stringify(out); }
    var af=fs.allFriends||[];
    for(var i=0;i<af.length&&i<200;i++){
      var f=af[i];
      var acc=String(f.m_unAccountID||'');
      if(!/^\\d+$/.test(acc)) continue;
      var cd=f.m_miniProfileDataLoader&&f.m_miniProfileDataLoader.m_communityData;
      var name=(cd&&cd.persona_name)||String(f.m_strPlayerNameNormalized||'');
      var avatar=(cd&&cd.avatar_url)||'';
      var apps=[];
      try{ var s=fs.GetOwnedGames(acc); if(s&&s.forEach) s.forEach(function(a){var n=Number(a); if(n>0) apps.push(n);}); }catch(e){}
      var id64='';
      try{ id64=String(76561197960265728n+BigInt(acc)); }catch(e){}
      out.friends.push({accountID:acc,steamId64:id64,name:name,avatar:avatar,
        playingAppId:Number(f.m_nAppIDLastSeenPlaying||0)||0,
        lastSeenPlaying:String(f.m_dtLastSeenPlaying||''),apps:apps});
    }
    try{
      var m=g_FriendsUIApp.m_AppInfoStore.m_mapAppInfo;
      if(m&&m.forEach) m.forEach(function(v,k){
        var id=String(k);
        if(/^\\d+$/.test(id)&&v&&v.m_strName) out.names[id]={name:String(v.m_strName),icon:String(v.m_strIconURL||'')};
      });
    }catch(e){}
  }catch(e){ out.err=String(e); }
  return JSON.stringify(out);
})()`;

function refreshExpr(accountIds) {
  return `(function(){
    var fs=window.friendStore; if(!fs) return 'no-store';
    var ids=${JSON.stringify(accountIds)};
    for(var i=0;i<ids.length;i++){ try{ fs.RefreshOwnedGames(String(ids[i])); }catch(e){} }
    return 'ok';
  })()`;
}

/** 请 Steam 客户端自己把缺失的 appid 名称加载进 m_AppInfoStore（纯本机、无外网） */
function ensureExpr(appids) {
  return `(function(){
    try{
      var a=g_FriendsUIApp.m_AppInfoStore;
      if(!a||!a.EnsureAppInfoForAppIDs) return 'no-appinfo';
      a.EnsureAppInfoForAppIDs(${JSON.stringify(appids.map(Number))});
      return 'ok';
    }catch(e){ return String(e); }
  })()`;
}

function id64FromAccount(acc) {
  try { return String(ID_BASE + BigInt(String(acc))); } catch { return ''; }
}

/** 本机 appid → 名称（Steam 安装清单），60 秒缓存，避免每秒扫盘 */
function localNames() {
  if (localNamesCache && Date.now() - localNamesAt < 60000) return localNamesCache;
  try { localNamesCache = core.registryAppNames() || {}; } catch { localNamesCache = {}; }
  localNamesAt = Date.now();
  return localNamesCache;
}

/** 本机价格缓存 + 名称缓存 → 每款游戏的展示信息 */
function decorate(apps, names) {
  const prices = core.getPriceCache();
  const locals = localNames();
  return apps.map(appid => {
    const k = String(appid);
    const info = names[k] || {};
    const extra = nameCache[k] || {};
    const p = prices[k];
    const cents = p && !p.unavailable && !p.isFree ? Number(p.finalCents || p.initialCents || 0)
      : (extra.priceCents ? Number(extra.priceCents) : null);
    const label = info.name || extra.name || p?.name || locals[k] || '';
    return {
      appid: k,
      name: String(label || `App ${k}`).slice(0, 160),
      nameKnown: !!label,
      icon: String(info.icon || ''),
      playtimeMin: null,           // 由 friend-profile-core 用官方档案合并
      playtimeHours: null,
      priceCents: cents,
      priceKnown: !!(p && !p.networkError) || !!extra.priceCents,
      iconUrl: info.icon ? `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${k}/${info.icon}.jpg` : ''
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

/**
 * 后台异步补全 Steam 客户端没加载过名称的游戏：只查 Steam 商店公开 appdetails。
 * 不阻塞每秒 tick，失败 20 秒后自动重试，结果只写本机。
 */
async function enrichNames(ids) {
  if (enriching || Date.now() - lastEnrichAt < ENRICH_GAP_MS) return;
  const todo = [...new Set(ids.map(String))]
    .filter(id => /^\d+$/.test(id))
    .filter(id => !nameCache[id] || Date.now() - (nameCache[id].checkedAt || 0) > (nameCache[id].failed ? ENRICH_GAP_MS : NAME_TTL))
    .slice(0, 6);
  if (!todo.length) return;
  enriching = true; lastEnrichAt = Date.now();
  try {
    for (const id of todo) {
      try {
        const j = await core.fetchJson(`https://store.steampowered.com/api/appdetails?appids=${id}&cc=cn&l=schinese`, 6500);
        const d = j?.[id];
        if (d?.success && d?.data) {
          const price = d.data.price_overview;
          nameCache[id] = {
            name: String(d.data.name || ''),
            priceCents: price && !d.data.is_free ? Number(price.final || 0) : 0,
            checkedAt: Date.now()
          };
          enrichedCount++;
        } else {
          nameCache[id] = { name: '', checkedAt: Date.now(), failed: true };
        }
      } catch {
        nameCache[id] = { name: '', checkedAt: Date.now(), failed: true };
      }
    }
    atomicWrite(NAMES_FILE, nameCache);
  } finally { enriching = false; }
}

function buildResult(raw, port) {
  const names = raw.names || {};
  const friends = {};
  let totalApps = 0;
  for (const f of raw.friends || []) {
    const id = f.steamId64 || id64FromAccount(f.accountID);
    if (!/^\d{15,20}$/.test(id)) continue;
    const apps = decorate([...new Set(f.apps || [])], names);
    totalApps += apps.length;
    friends[id] = {
      steamId64: id,
      accountID: String(f.accountID),
      name: String(f.name || `Steam ${id.slice(-6)}`),
      avatar: String(f.avatar || ''),
      playingAppId: Number(f.playingAppId) || 0,
      lastSeenPlaying: String(f.lastSeenPlaying || ''),
      appids: apps.map(a => a.appid),
      games: apps
    };
  }
  return {
    ok: true,
    ts: raw.ts || Date.now(),
    iso: new Date(raw.ts || Date.now()).toISOString(),
    source: 'Steam 客户端好友游戏库（本机直读）',
    port,
    pollIntervalSec: 1,
    friendCount: Object.keys(friends).length,
    totalApps,
    namesCount: Object.keys(names).length,
    friends,
    error: raw.err || ''
  };
}

/**
 * 每秒调用一次：读 Steam 客户端，必要时让它自己刷新空的好友库。
 * 不联网、不写凭证、失败不影响服务。
 */
async function tick(opts = {}) {
  if (ticking && !opts.force) return memory;
  ticking = true;
  polls++;
  try {
    const t = await sharedTarget(!!opts.forceDiscover);
    if (!t) return memory;
    const raw = await cdpEvaluate(t.ws, READ_EXPR);
    const result = buildResult(raw, t.port);
    memory = result;
    lastReadAt = Date.now();
    lastError = result.error || '';

    // Steam 客户端没加载过名称的游戏：先让它自己本机加载，60 秒仍缺才查商店公开资料兜底
    const unknown = Object.values(result.friends)
      .flatMap(f => f.games.filter(g => !g.nameKnown).map(g => g.appid));
    if (unknown.length) {
      if (Date.now() - lastEnsureAt > ENSURE_GAP_MS) {
        lastEnsureAt = Date.now();
        cdpEvaluate(t.ws, ensureExpr(unknown.slice(0, 20)), 1800).catch(() => {});
      }
      enrichNames(unknown).catch(() => {});
    }

    // 空库好友：按 30 秒节流，请 Steam 客户端自己刷新一次缓存
    const empty = Object.values(result.friends)
      .filter(f => !f.appids.length)
      .filter(f => Date.now() - (refreshAt.get(f.accountID) || 0) > EMPTY_REFRESH_GAP_MS)
      .slice(0, 2);
    if (empty.length) {
      const ids = empty.map(f => f.accountID);
      for (const id of ids) refreshAt.set(id, Date.now());
      cdpEvaluate(t.ws, refreshExpr(ids), 1800).catch(() => {});
    } else if (opts.force) {
      const ids = Object.values(result.friends).slice(0, 5).map(f => f.accountID);
      for (const id of ids) refreshAt.set(id, Date.now());
      await cdpEvaluate(t.ws, refreshExpr(ids), 1800).catch(() => {});
    }

    const sig = JSON.stringify(Object.values(result.friends).map(f => [f.steamId64, f.appids.join(','), f.playingAppId]));
    if (sig !== lastSignature || Date.now() - lastWriteAt > WRITE_EVERY_MS) {
      lastSignature = sig;
      lastWriteAt = Date.now();
      atomicWrite(OUT_FILE, result);
    }
    return result;
  } catch (e) {
    lastError = e.message;
    return memory;
  } finally { ticking = false; }
}

/** 立即强制刷新指定好友（或全部）的库 */
async function refresh(steamId64 = '') {
  const t = await sharedTarget(false);
  if (!t) throw new Error(lastError || 'Steam 客户端未连接');
  const ids = [];
  const cur = memory || readFile();
  if (steamId64) {
    const f = cur?.friends?.[String(steamId64)];
    if (!f) throw new Error('本机还没有这位好友的库记录');
    ids.push(f.accountID);
  } else {
    for (const f of Object.values(cur?.friends || {})) ids.push(f.accountID);
  }
  if (!ids.length) throw new Error('好友名册为空');
  await cdpEvaluate(t.ws, refreshExpr(ids), 2500).catch(() => {});
  for (const id of ids) refreshAt.set(id, Date.now());
  await new Promise(r => setTimeout(r, 1800));
  return await tick({ force: false });
}

function readFile() {
  try { const j = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); return j && j.friends ? j : null; }
  catch { return null; }
}

/** 内存优先，服务刚启动还没 tick 时回退到本机文件 */
function snapshot() { return memory || readFile(); }

function library(steamId64) {
  const s = snapshot();
  const f = s?.friends?.[String(steamId64 || '')] || null;
  if (!f) return null;
  return { ...f, fetchedAt: s.ts, fetchedAtIso: s.iso, source: s.source };
}

function list() {
  const s = snapshot();
  if (!s) return { ok: false, count: 0, totalApps: 0, profiles: [], connected: false, error: lastError };
  return {
    ok: true,
    count: s.friendCount ?? Object.keys(s.friends || {}).length,
    totalApps: s.totalApps || 0,
    connected: Date.now() - lastReadAt < 10000,
    fetchedAt: s.ts, fetchedAtIso: s.iso,
    source: s.source, pollIntervalSec: 1,
    profiles: Object.values(s.friends || {}).map(f => ({
      steamId64: f.steamId64, name: f.name, avatar: f.avatar,
      games: (f.appids || []).length, playingAppId: f.playingAppId
    }))
  };
}

function status() {
  const s = snapshot();
  return {
    ok: !!s,
    connected: Date.now() - lastReadAt < 10000,
    port: cachedPort,
    polls,
    lastAt: lastReadAt || s?.ts || 0,
    secondsAgo: lastReadAt ? Math.max(0, Math.round((Date.now() - lastReadAt) / 1000)) : null,
    friendCount: s?.friendCount ?? 0,
    totalApps: s?.totalApps ?? 0,
    namesCount: s?.namesCount ?? 0,
    namesCached: Object.keys(nameCache).length,
    enrichedCount,
    pollIntervalSec: 1,
    error: lastError || s?.error || '',
    source: s?.source || '',
    note: '每秒从 Steam 客户端自己的好友游戏库缓存读取；不读聊天记录、不碰密码 / Cookie。'
  };
}

module.exports = { tick, refresh, library, list, status, snapshot, OUT_FILE };
