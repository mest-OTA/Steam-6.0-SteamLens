/**
 * SteamLens · 浏览器会话扫描 / 好友码 / 真实购买清单
 *
 * 设计边界：
 *  - 不解密、不接管浏览器 Cookie；只读「文件里是否存在 steam 登录标记」用于提示。
 *  - 权威数据来自 Steam 商店自己的 /dynamicstore/userdata/ 接口，
 *    由浏览器里已登录的会话同源读取（rgOwnedApps = 真正买过的游戏、
 *    rgWishlist = 愿望单、rgAppsInCart = 购物车），不需要 API Key。
 *  - 采集脚本每秒检查一次页面变化，只把「appid + 名称」POST 回 127.0.0.1，
 *    凭证一个字节都不出浏览器。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execSync } = require('node:child_process');
const core = require('./steam-core');
const account = require('./account-core');
const gameMeta = require('./game-meta-core');   // 扫描到的 AppID 补全中文名 + 封面

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'browser-snapshot.json');
/* 调试端口要持久化：服务重启后「已识别」不该丢失 */
const DEBUG_EP_FILE = path.join(DATA_DIR, 'browser-debug.json');
/* 浏览器会话读到的好友在线状态，供 friends-core 生成上线事件（无需 Steam Web API Key） */
const FRIEND_FILE = path.join(DATA_DIR, 'browser-friends.json');
const PORT_DEFAULT = 8787;

/* ------------------------------ 好友码 ------------------------------ */
const ID_BASE = 76561197960265728n;

function toFriendCode(id64) {
  const n = BigInt(String(id64 || '').trim());
  if (n <= ID_BASE) throw new Error('不是有效的 SteamID64');
  return String(n - ID_BASE);
}
function accountTo64(code) {
  const n = BigInt(String(code || '').trim());
  if (n <= 0n || n > 4294967295n) throw new Error('好友码应为 1~10 位数字');
  return String(ID_BASE + n);
}

/* ------------------------------ 快照 ------------------------------ */
const EMPTY = () => ({
  version: 2,
  browser: '', loggedIn: false, loggedInSource: '', personaName: '',
  steamId64: '', friendCode: '', lastUrl: '', lastPage: '',
  owned: [], wishlist: [], cart: [],
  /* 购物车诊断：来源 / 最近一次有效时间 / 是否确认过「真的是空的」 / 过滤掉的推荐位数量 */
  cartSource: '', cartAt: 0, cartConfirmedEmpty: false, cartFilteredCount: 0,
  hiddenApps: [], storeHiddenApps: [],
  storeOwnedApps: [], storeWishlist: [], storeCart: [],
  verified: false, verifiedAt: 0, verifiedSource: '',
  collectedAt: 0, updatedAt: 0, polls: 0, history: []
});

function atomicWrite(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  try { fs.renameSync(tmp, file); }
  catch { fs.copyFileSync(tmp, file); try { fs.unlinkSync(tmp); } catch {} }
}

/* ---------------- 好友 Steam 徽章（从已登录的 Steam 网页端采集，不需要 API Key） ---------------- */
const BADGES_FILE = path.join(DATA_DIR, 'friend-badges.json');
function readBadgeStore() {
  try { return JSON.parse(fs.readFileSync(BADGES_FILE, 'utf8')) || {}; } catch { return {}; }
}
function getBadges(steamId64) {
  const id = String(steamId64 || '');
  const row = readBadgeStore()[id] || null;
  return {
    ok: true, steamId64: id,
    badges: row?.badges || [], count: (row?.badges || []).length,
    level: row?.level ?? null, name: row?.name || '',
    at: row?.at || 0, source: row?.source || ''
  };
}
function saveBadges(p = {}) {
  const id = String(p.steamId64 || '');
  if (!/^\d{17}$/.test(id)) return { ok: false, reason: '缺少有效的 SteamID64' };
  const badges = (Array.isArray(p.badges) ? p.badges : []).slice(0, 80).map(b => ({
    name: String(b?.name || '').trim().slice(0, 80),
    level: Number(b?.level || 0) || 0,
    xp: Number(b?.xp || 0) || 0,
    appid: String(b?.appid || ''),
    scarcity: Number(b?.scarcity || 0) || 0
  })).filter(b => b.name);
  const all = readBadgeStore();
  all[id] = {
    badges, level: p.level ?? null, name: String(p.name || '').slice(0, 60),
    source: String(p.source || 'Steam 网页端').slice(0, 60), at: Date.now()
  };
  atomicWrite(BADGES_FILE, all);
  return { ok: true, count: badges.length };
}

/* ---------------- 朋友的朋友（浏览器已登录的 Steam 好友列表页） ----------------
   采集到的名单按 via 增量合并进 discovered-friends.json，和「朋友的朋友」页、
   点击好友的面板共用同一份数据；带 sourceTag，避免被服务端联网扫描整份覆盖。 */
const FOF_FILE = path.join(DATA_DIR, 'discovered-friends.json');
let fofLastAt = 0, fofLastCount = 0;
/* 报告「本机已经采到多少关系链」，而不是「上一次单页采到几个」：
   某位好友把好友列表设为私密时，不能让整份档案都显示 0 人。 */
function fofStatus() {
  let d = {};
  try { d = JSON.parse(fs.readFileSync(FOF_FILE, 'utf8')) || {}; } catch {}
  const ext = Array.isArray(d.extended) ? d.extended : [];
  const collected = ext.filter(x => String(x?.sourceTag || '') === 'collector-fof');
  const byVia = {};
  for (const x of collected) {
    const k = String(x?.via || '');
    if (k) byVia[k] = (byVia[k] || 0) + 1;
  }
  return {
    at: Number(d.generatedAt || fofLastAt || 0),
    count: collected.length, byVia,
    lastCount: fofLastCount, total: ext.length
  };
}
function saveFof(p = {}) {
  const via = String(p.steamId64 || '');
  if (!/^\d{17}$/.test(via)) return { ok: false, reason: '缺少页面对应的好友 SteamID64' };
  const ownerName = String(p.ownerName || '').slice(0, 80);
  const people = (Array.isArray(p.people) ? p.people : []).slice(0, 200).map(x => ({
    steamId64: String(x?.steamId64 || ''),
    name: String(x?.name || '').trim().slice(0, 80),
    avatar: String(x?.avatar || '').slice(0, 200),
    profileUrl: String(x?.profileUrl || ''),
    via, viaName: ownerName, level: 2, sourceTag: 'collector-fof'
  })).filter(x => /^\d{17}$/.test(x.steamId64) && x.steamId64 !== via && x.name);
  let d = {};
  try { d = JSON.parse(fs.readFileSync(FOF_FILE, 'utf8')) || {}; } catch { d = {}; }
  if (!Array.isArray(d.direct)) d.direct = [];
  if (!Array.isArray(d.extended)) d.extended = [];
  // 关系链还没扫过时，用 Steam 客户端真实好友补一份直接好友，结果才完整
  if (!d.direct.length) {
    try {
      const sc = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'steam-client-friends.json'), 'utf8'));
      d.direct = (sc.friends || []).map(f => ({
        steamId64: String(f.steamid || ''), name: String(f.personaname || ''),
        level: 1, viaName: '我'
      })).filter(x => /^\d{17}$/.test(x.steamId64));
    } catch {}
  }
  /* 我的好友本人不是「朋友的朋友」：以前扫过自己的 /friends 页，把自己的两位好友
     连同「上次在线 X」状态文本一起写进了 extended，这里统一剔除，顺带清掉历史脏数据。 */
  let mine = new Set();
  try {
    const sc = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'steam-client-friends.json'), 'utf8'));
    for (const f of sc.friends || []) mine.add(String(f.steamid || f.steamId64 || ''));
  } catch {}
  const prevForVia = d.extended.filter(x => String(x?.via || '') === via && String(x?.sourceTag || '') === 'collector-fof');
  // 只替换这位好友本次采到的名单，其它人的采集结果保留
  d.extended = d.extended.filter(x => !(String(x?.via || '') === via && String(x?.sourceTag || '') === 'collector-fof'));
  d.extended = d.extended.filter(x => !mine.has(String(x?.steamId64 || '')));
  const cleanPeople = people.filter(x => !mine.has(String(x.steamId64)));
  /* 页面没加载完 / 好友列表私密 / 登录态失效都会返回空名单：
     绝不能用空结果把上次采到的关系链清掉（43 人被一次空扫清空就是踩了这个坑）。 */
  d.extended.push(...(cleanPeople.length ? cleanPeople : prevForVia));
  const collected = d.extended.filter(x => String(x?.sourceTag || '') === 'collector-fof');
  const byVia = {};
  for (const x of collected) {
    const k = String(x?.via || '');
    if (k) byVia[k] = (byVia[k] || 0) + 1;
  }
  d.byVia = byVia;
  d.ok = true;
  d.generatedAt = Date.now();
  d.generatedAtIso = new Date().toISOString();
  d.source = '已登录 Steam 网页端 · 好友列表页';
  /* 一个人设为私密，不该把「整份关系链都没读到」写进全局提示 */
  d.note = collected.length ? '' : '这一页没读到公开好友（可能设为私密，或页面还没加载完）';
  atomicWrite(FOF_FILE, d);
  fofLastAt = Date.now(); fofLastCount = cleanPeople.length;
  return { ok: true, via, count: cleanPeople.length, total: d.extended.length,
    kept: cleanPeople.length === 0 && prevForVia.length > 0, at: fofLastAt };
}

/* ---------------- 朋友的朋友的游戏库 ----------------
   friend-library-core.js 每秒从 Steam 客户端读取「我自己的好友」并整文件覆写
   friend-libraries.json，所以 FoF 的库必须单独存，不然刚采到就会被冲掉。 */
const FOF_LIB_FILE = path.join(DATA_DIR, 'fof-libraries.json');
function readFofLibStore() {
  try { return JSON.parse(fs.readFileSync(FOF_LIB_FILE, 'utf8')) || {}; } catch { return {}; }
}
function getFofLibrary(steamId64) {
  const id = String(steamId64 || '');
  const row = readFofLibStore()[id];
  if (!row) return null;
  /* 采到时若只有 AppID（Steam 页面常见），用本机游戏名缓存随时补全 */
  const games = (Array.isArray(row.games) ? row.games : []).map(g => {
    const nm = gameMeta.nameOf(String(g.appid || ''));
    return nm && (!g.name || /^App \d+$/.test(String(g.name)))
      ? { ...g, name: nm } : g;
  });
  return {
    steamId64: id, name: row.name || '', games, gameCount: games.length,
    hasLibrary: true, source: row.source || 'Steam 网页端 · 游戏库',
    at: row.at || 0, fetchedAt: row.at || 0
  };
}
function saveFofLibrary(p = {}) {
  const id = String(p.steamId64 || '').trim();
  if (!/^7656119\d{10}$/.test(id)) return { ok: false, reason: '缺少有效的 SteamID64' };
  const seen = new Set(), games = [];
  for (const g of (Array.isArray(p.games) ? p.games : []).slice(0, 1200)) {
    const appid = String(g?.appid || g?.appID || '').trim();
    if (!/^\d+$/.test(appid) || seen.has(appid)) continue;
    seen.add(appid);
    const raw = String(g?.name || '').trim();
    const known = gameMeta.nameOf(appid);
    const name = raw && !/^App \d+$/.test(raw) ? raw : (known || ('App ' + appid));
    /* 没名字的只排队一次，让游戏名缓存异步从 Steam 商店补，不阻塞采集 */
    if (!known && (!raw || /^App \d+$/.test(raw))) { try { gameMeta.queue(appid); } catch {} }
    games.push({ appid, name: name.slice(0, 120) });
  }
  const all = readFofLibStore();
  /* 私密库 / 页面还没加载完时会返回空清单，不要用空数组把之前采到的库冲掉 */
  if (!games.length && all[id] && Array.isArray(all[id].games) && all[id].games.length) {
    return { ok: true, count: all[id].games.length, steamId64: id, kept: true };
  }
  all[id] = {
    name: String(p.name || '').slice(0, 80), games,
    source: String(p.source || 'Steam 网页端 · 游戏库').slice(0, 60), at: Date.now()
  };
  atomicWrite(FOF_LIB_FILE, all);
  return { ok: true, count: games.length, steamId64: id };
}

let mem = null;
function snapshot() {
  if (mem) return mem;
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')); } catch { raw = null; }
  const d = EMPTY();
  if (raw && typeof raw === 'object' && Number(raw.version) >= 2) {
    for (const k of Object.keys(d)) if (raw[k] !== undefined) d[k] = raw[k];
  }
  mem = d;
  return mem;
}

function cleanItems(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const id = String((x && (x.appid ?? x.id)) ?? '').trim();
    if (!/^\d{1,12}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ appid: id, name: String((x && x.name) || '').slice(0, 120) });
  }
  return out.slice(0, 1200);
}
function cleanIds(arr) {
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map(x => String(x?.appid ?? x ?? '').trim()).filter(x => /^\d{1,12}$/.test(x)))].slice(0, 2000);
}

/* ------------------------------ 浏览器登录标记（只读） ------------------------------ */
// Cookie 库可能有几十 MB，每秒 status() 都重读会拖慢整个面板；结果缓存 30 秒
let detectCache = { at: 0, value: null };
function detectBrowsers(force = false) {
  if (!force && detectCache.value && Date.now() - detectCache.at < 30000) return detectCache.value;
  const roots = [
    ['Edge', path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data')],
    ['Chrome', path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data')],
    ['QQ浏览器', path.join(os.homedir(), 'AppData', 'Local', 'Tencent', 'QQBrowser', 'User Data')]
  ];
  const browsers = [];
  let anyLoggedIn = false;
  for (const [name, root] of roots) {
    if (!fs.existsSync(root)) { browsers.push({ name, found: false, note: '未安装此浏览器' }); continue; }
    let profiles = [];
    try {
      profiles = fs.readdirSync(root, { withFileTypes: true })
        .filter(d => d.isDirectory() && /^(Default|Profile \d+)$/.test(d.name))
        .map(d => path.join(root, d.name));
    } catch { /* ignore */ }
    let cookieFound = false, markerFound = false;
    for (const p of profiles) {
      const c = path.join(p, 'Network', 'Cookies');
      if (!fs.existsSync(c)) continue;
      cookieFound = true;
      // 只读二进制里是否出现 steam 域名字符串，不解密、不取值
      try {
        const buf = fs.readFileSync(c);
        if (buf.includes(Buffer.from('steamcommunity.com')) || buf.includes(Buffer.from('store.steampowered.com'))) markerFound = true;
      } catch { /* 被浏览器独占锁住，跳过 */ }
    }
    if (markerFound) anyLoggedIn = true;
    browsers.push({
      name, found: true, profiles: profiles.length, cookieDb: cookieFound,
      markerFound, note: markerFound ? 'Cookie 库里发现 Steam 域名（可能已登录）'
        : cookieFound ? 'Cookie 库可读，未发现 Steam 登录标记' : '未找到 Cookie 库'
    });
  }
  const result = {
    browsers, anyLoggedIn, checkedAt: Date.now(),
    note: '登录状态最终以 Steam 商店页面为准；这里只读文件是否出现 Steam 域名，不解密也不接管任何凭证。'
  };
  detectCache = { at: result.checkedAt, value: result };
  return result;
}

/* ------------------------------ 采集回传 ------------------------------ */
function ingest(p = {}) {
  const s = snapshot();
  const now = Date.now();
  const page = String(p.page || p.url || '').slice(0, 200);
  const loggedIn = p.loggedIn === true || p.loggedIn === 'true' || p.loggedIn === 1;

  // ★ 每秒心跳：即使页面没变化也回传，让面板的「实时同步」和倒计时真的在动
  if (p.source === 'heartbeat') {
    s.collectedAt = now; s.updatedAt = now;
    s.polls = Number(s.polls || 0) + 1;
    s.lastUrl = String(p.url || s.lastUrl || '').slice(0, 300);
    s.lastPage = String(p.page || s.lastPage || '').slice(0, 120);
    if (p.browser) s.browser = String(p.browser).slice(0, 40);
    if (loggedIn) s.loggedIn = true;
    atomicWrite(SNAPSHOT_FILE, s);
    return { ok: true, heartbeat: true, collectedAt: now, polls: s.polls };
  }

  /* ★ 好友在线状态（无 API Key 路径）：采集器在 steamcommunity.com 同源读取
     好友页 DOM / 个人资料 XML，把状态 POST 回来。这里只清洗落盘，
     friends-core 会读这份文件对比基线、产生「上线了」事件并触发通知。 */
  if (p.source === 'collector-friends' || Array.isArray(p.friends)) {
    const saved = saveFriendStates(p.friends || [], { url: p.url });
    if (!saved) return { ok: true, friendStates: 0, skipped: '本轮没有有效好友状态' };
    const fs2 = snapshot();
    fs2.friendStatesAt = saved.ts;
    fs2.friendStatesCount = saved.count;
    atomicWrite(SNAPSHOT_FILE, fs2);
    return { ok: true, friendStates: saved.count, online: saved.friends.filter(x => x.personastate > 0).length, at: saved.ts };
  }

  /* ★ 好友 Steam 徽章：从已登录网页端 /badges 页面采集，落盘到 friend-badges.json。
     只接受结构完整的回传；空数组也允许写入（表示该好友确实没有徽章）。 */
  if (p.source === 'collector-badges') {
    const r = saveBadges(p);
    if (!r.ok) return r;
    return { ok: true, badges: r.count, steamId64: String(p.steamId64 || ''), at: Date.now() };
  }

  /* 已登录 Steam 网页端 /profiles/<id>/friends 页回传的「朋友的朋友」 */
  if (p.source === 'collector-fof') {
    const r = saveFof(p);
    if (!r.ok) return r;
    const s2 = snapshot();
    s2.fofAt = r.at; s2.fofCount = r.count;
    atomicWrite(SNAPSHOT_FILE, s2);
    return { ok: true, fof: r.count, via: r.via, total: r.total, at: r.at };
  }

  /* 已登录 Steam 网页端 /profiles/<id>/games 页回传的游戏库（通常是朋友的朋友）。
     必须在这里提前返回：落到后面的通用分支会被当成「我拥有的游戏」写进快照。 */
  if (p.source === 'collector-fof-library') {
    const r = saveFofLibrary(p);
    if (!r.ok) return r;
    return { ok: true, fofLibrary: r.count, steamId64: r.steamId64, at: Date.now() };
  }

  let id64 = String(p.steamId64 || '').trim();
  if (!id64 && p.friendCode) { try { id64 = accountTo64(p.friendCode); } catch {} }
  let friendCode = String(p.friendCode || '').trim();
  if (!friendCode && id64) { try { friendCode = toFriendCode(id64); } catch {} }

  const owned = cleanItems(p.owned);
  const wishlist = cleanItems(p.wishlist);
  const cart = cleanItems(p.cart);
  const games = cleanItems(p.games);

  let o = owned, w = wishlist, c = cart;
  if (!o.length && !w.length && !c.length && games.length) {
    /* ★ 购物车页的通用 games 一律不进购物车：那一栏混着「为您推荐 / 猜你喜欢」的
       商店推荐位，以前整页 a[href*="/app/"] 一把抓，购物车就被推荐内容灌满了。 */
    if (/wishlist/i.test(page)) w = games;
    else if (/cart|checkout|shoppingcart/i.test(page)) { /* 忽略：购物车只走专用通道 */ }
    else o = games;
  }

  const merge = (oldArr, newArr, replace) => {
    if (!newArr.length) return oldArr;
    if (replace) return newArr;
    const m = new Map(oldArr.map(x => [x.appid, x]));
    for (const x of newArr) m.set(x.appid, x);
    return [...m.values()].slice(-1200);
  };
  s.owned = merge(s.owned, o, false);
  s.wishlist = merge(s.wishlist, w, w.length > 0);

  /* ★ 购物车专用写入：只有「明确来自购物车」的非空结果才刷新；空结果绝不清空。
     后台标签节流 / 未登录 / dynamicstore 延迟都可能让某一轮拿到空数组，
     以前每 15 秒被它抹一次，表现就是「刚扫出来一点点，突然又全消失了」。 */
  const cartExplicit = p.cartSource === 'cart' || Array.isArray(p.cart) || p.cartItems !== undefined;
  if (c.length && cartExplicit) {
    s.cart = c;
    s.cartSource = String(p.cartSource || '购物车页面').slice(0, 60);
    s.cartAt = now;
    s.cartConfirmedEmpty = false;
    /* 每轮都刷新被排除的推荐位数（含 0），避免旧数字一直挂在界面上误导 */
    s.cartFilteredCount = Math.max(0, Number(p.cartFilteredCount) || 0);
  } else if (p.cartConfirmedEmpty === true && cartExplicit) {
    // 只有采集器在购物车页明确看到「购物车是空的」才允许清空
    s.cart = [];
    s.cartSource = '购物车为空（页面已确认）';
    s.cartAt = now;
    s.cartConfirmedEmpty = true;
  }

  // 页面上的「隐藏游戏」列表（Steam 库 / 隐藏页扫描结果）
  const hiddenOnPage = cleanItems(p.hidden);
  if (hiddenOnPage.length) {
    const ids = cleanIds(hiddenOnPage.map(x => x.appid));
    s.hiddenApps = [...new Set([...(s.hiddenApps || []), ...ids])].slice(-2000);
  }

  /* ★ Steam 商店权威清单：只有拿到 rgOwnedApps 时才覆盖购买真值 */
  const st = p.store && typeof p.store === 'object' ? p.store : null;
  let verifiedNow = false;
  if (st) {
    const so = cleanIds(st.ownedApps || st.rgOwnedApps);
    const sw = cleanIds(st.wishlist || st.rgWishlist);
    const sc = cleanIds(st.cart || st.rgAppsInCart);
    const sh = cleanIds(st.hiddenApps || st.rgHiddenApps);
    if (sh.length) s.storeHiddenApps = sh;
    if (so.length || sw.length || sc.length) {
      s.storeOwnedApps = so;
      s.storeWishlist = sw;
      s.storeCart = sc;
      s.verified = so.length > 0;
      s.verifiedAt = now;
      s.verifiedSource = 'Steam 商店 /dynamicstore/userdata/（浏览器已登录会话）';
      verifiedNow = so.length > 0;
      try {
        account.applyStoreTruth({
          owned: so, wishlist: sw, cart: sc,
          steamId64: id64, source: s.verifiedSource
        });
      } catch (e) { console.error('[SteamLens 商店真值写入失败]', e.message); }

      /* ★ 权威清单同时填进「游戏库 / 愿望单 / 购物车」三个展示列表。
       *   以前只写 storeOwnedApps 等 ID 数组，前端三个卡片读的是 owned/wishlist/cart，
       *   结果就是「已购买数字有了，卡片却一直空白」。 */
      const nameMap = new Map();
      const sources = [
        ...(s.owned || []), ...(s.wishlist || []), ...(s.cart || []),
        ...(Array.isArray(p.games) ? p.games : []), ...o, ...w, ...c
      ];
      for (const g of sources) if (g && g.appid) nameMap.set(String(g.appid), String(g.name || ''));
      let localNames = null;
      try {
        const cached = core.loadCachedState();
        if (cached && Array.isArray(cached.games)) {
          localNames = new Map(cached.games.map(g => [String(g.appid), String(g.name || '')]));
        }
      } catch { /* 本机缓存不可用就用空名称，前端会显示 AppID */ }
      const toItems = ids => ids.slice(0, 1200).map(id => ({
        appid: id,
        name: nameMap.get(id) || (localNames && localNames.get(id)) || ''
      }));
      if (so.length) {
        s.owned = toItems(so);
        // 登录态可信：空数组也是权威结果，愿望单清空时跟着清空
        s.wishlist = toItems(sw);
        /* ★ 购物车不能跟着空数组清掉：dynamicstore 的 rgAppsInCart 在后台标签被节流、
           未登录会话或请求失败时都会是 []，把它当成「购物车真的空了」就会抹掉刚扫到的结果。
           只有官方清单明确给出非空购物车时才用它覆盖（名称由上面的 nameMap 补全）。 */
        if (sc.length) {
          s.cart = toItems(sc);
          s.cartSource = 'Steam 商店购物车清单（rgAppsInCart）';
          s.cartAt = now;
          s.cartConfirmedEmpty = false;
        }
      }
    }
  }

  s.browser = String(p.browser || s.browser || '').slice(0, 40);
  s.lastUrl = String(p.url || '').slice(0, 300);
  s.lastPage = String(p.page || '').slice(0, 120);
  s.personaName = String(p.personaName || s.personaName || '').slice(0, 60);
  if (id64) s.steamId64 = id64;
  if (friendCode) s.friendCode = friendCode;
  if (loggedIn || verifiedNow) {
    s.loggedIn = true;
    s.loggedInSource = verifiedNow ? 'Steam 商店已购买清单' : (loggedIn ? '商店页面登录标记' : s.loggedInSource);
  } else if (p.loggedIn === false && !verifiedNow) {
    s.loggedIn = false;
  }
  s.collectedAt = now;
  s.updatedAt = now;
  s.polls = Number(s.polls || 0) + 1;

  if (o.length + w.length + c.length + (st ? 1 : 0)) {
    s.history.push({ iso: new Date(now).toISOString(), page: s.lastPage,
      owned: o.length, wishlist: w.length, cart: c.length,
      storeOwned: s.storeOwnedApps.length, loggedIn: s.loggedIn });
    if (s.history.length > 100) s.history.splice(0, s.history.length - 100);
  }
  atomicWrite(SNAPSHOT_FILE, s);
  return {
    ok: true, loggedIn: s.loggedIn, verified: s.verified,
    totals: { owned: s.owned.length, wishlist: s.wishlist.length, cart: s.cart.length },
    storeOwned: s.storeOwnedApps.length, collectedAt: s.collectedAt, polls: s.polls
  };
}

/* ------------------- 好友在线状态（浏览器已登录会话） ------------------- */
/**
 * 只接受 17 位 SteamID64 与 0~6 的 Steam 状态码，其余一律丢弃。
 * 同轮里「在线 / 游戏中」优先于「离线」，避免 DOM 与 XML 两份结果互相覆盖。
 */
function cleanFriendStates(arr) {
  if (!Array.isArray(arr)) return [];
  const byId = new Map();
  for (const raw of arr.slice(0, 500)) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.steamid || raw.steamId64 || '').trim();
    if (!/^\d{17}$/.test(id)) continue;
    let st = Number(raw.personastate);
    if (!Number.isFinite(st) || st < 0 || st > 6) continue;   // -1 = 状态未知，不写
    st = Math.round(st);
    const name = String(raw.personaname || raw.name || '').trim().slice(0, 80);
    const game = String(raw.gameextrainfo || raw.game || '').trim().slice(0, 120);
    const prev = byId.get(id);
    if (prev && (prev.personastate > 0 || prev.gameextrainfo) && st === 0 && !game) continue;
    byId.set(id, {
      steamid: id,
      personaname: name || prev?.personaname || '',
      personastate: st,
      gameextrainfo: game,
      avatarfull: String(raw.avatarfull || '').slice(0, 300),
      profileurl: String(raw.profileurl || '').slice(0, 300)
    });
  }
  return [...byId.values()];
}

/** 空结果不覆盖上一轮，避免采集器偶发失败把已在线的好友误判成离线 */
function saveFriendStates(arr, meta = {}) {
  const clean = cleanFriendStates(arr);
  if (!clean.length) return null;
  const now = Date.now();
  const payload = {
    ts: now, iso: new Date(now).toISOString(),
    source: '浏览器已登录 Steam 会话（同源只读）',
    page: String(meta.url || '').slice(0, 300),
    count: clean.length,
    friends: clean
  };
  atomicWrite(FRIEND_FILE, payload);
  return payload;
}
function friendStates() {
  try { const j = JSON.parse(fs.readFileSync(FRIEND_FILE, 'utf8')); return j && Array.isArray(j.friends) ? j : null; }
  catch { return null; }
}

function setFriendCode(code) {
  const s = snapshot();
  const id64 = accountTo64(code);
  s.friendCode = String(code).trim();
  s.steamId64 = id64;
  s.updatedAt = Date.now();
  atomicWrite(SNAPSHOT_FILE, s);
  // 同时写进配置，让手动模式/好友系统也能用
  core.saveConfig({ steamId64: id64 });
  return { ok: true, friendCode: s.friendCode, steamId64: id64 };
}

function clear() {
  const fresh = EMPTY();
  mem = fresh;
  atomicWrite(SNAPSHOT_FILE, fresh);
  return { ok: true };
}

/* 商店登录态接口偶发长时间挂起，拿不到权威清单时，
   「游戏库 / 已拥有」也要有内容：退回本机已扫描到的 Steam 游戏库。 */
let localOwnedCache = { at: 0, items: [] };
function localOwnedFallback() {
  if (Date.now() - localOwnedCache.at < 300000) return localOwnedCache.items;
  let items = [];
  try {
    const st = core.loadCachedState();
    if (st && Array.isArray(st.games)) {
      items = st.games.filter(g => g && g.appid)
        .map(g => ({ appid: String(g.appid), name: String(g.name || '') }))
        .slice(0, 300);
    }
  } catch { /* 本机缓存不可用时保持空 */ }
  localOwnedCache = { at: Date.now(), items };
  return items;
}

/* ★ 库价值自愈：浏览器扫描已经拿到 Steam 商店权威清单（rgOwnedApps），但账号真实库
   被一次失败的 Web API 同步写成「connected:true + owned:[]」时，把它补回去。
   否则所有本机游戏都会被判成「未验证 / 不计价」，库价值永远显示 0。 */
let lastTruthRepairAt = 0;
function repairTruthFromBrowser() {
  try {
    const t = account.getTruth();
    if ((t.owned || []).length) return { ok: false, reason: '真实库已有拥有清单' };
    if (Date.now() - lastTruthRepairAt < 10000) return { ok: false, reason: '刚检查过' };
    lastTruthRepairAt = Date.now();
    const s = snapshot();
    const owned = cleanIds((s.storeOwnedApps || []).length ? s.storeOwnedApps : (s.verified ? (s.owned || []) : []));
    if (!owned.length) return { ok: false, reason: '浏览器也没拿到权威拥有清单' };
    return account.applyStoreTruth({
      owned,
      wishlist: cleanIds(s.storeWishlist && s.storeWishlist.length ? s.storeWishlist : (s.wishlist || [])),
      cart: cleanIds(s.storeCart && s.storeCart.length ? s.storeCart : (s.cart || [])),
      steamId64: s.steamId64 || '',
      source: s.verifiedSource || 'Steam 商店（浏览器扫描恢复）'
    });
  } catch (e) { return { ok: false, error: e.message }; }
}

function status() {
  repairTruthFromBrowser();
  const s = snapshot();
  const det = detectBrowsers();
  const cfg = core.getConfig();
  const ownedShown = s.owned.length ? s.owned : localOwnedFallback();
  /* 商店只给 AppID 数组：这里补上中文名与封面图（元数据永久缓存，取不到就后台排队补） */
  const ownedView = gameMeta.decorate(ownedShown.slice(-300));
  const wishView = gameMeta.decorate(s.wishlist.slice(-300));
  const cartView = gameMeta.decorate(s.cart.slice(-300));
  return {
    ok: true,
    connectedBrowser: s.browser || '',
    loggedIn: s.loggedIn, loggedInSource: s.loggedInSource,
    personaName: s.personaName,
    steamId64: s.steamId64 || cfg.steamId64 || '',
    friendCode: s.friendCode || (() => { try { return toFriendCode(cfg.steamId64); } catch { return ''; } })(),
    lastUrl: s.lastUrl, lastPage: s.lastPage,
    collectedAt: s.collectedAt, updatedAt: s.updatedAt, polls: s.polls,
    verified: s.verified, verifiedAt: s.verifiedAt, verifiedSource: s.verifiedSource,
    totals: { owned: ownedShown.length, wishlist: s.wishlist.length, cart: s.cart.length },
    storeOwned: s.storeOwnedApps.length, storeWishlist: s.storeWishlist.length,
    storeCart: s.storeCart.length || s.cart.length,
    cartSource: s.cartSource || '', cartAt: s.cartAt || 0,
    cartConfirmedEmpty: !!s.cartConfirmedEmpty,
    cartFilteredCount: Number(s.cartFilteredCount || 0),
    hiddenApps: (s.hiddenApps || []).length, storeHiddenApps: (s.storeHiddenApps || []).length,
    owned: ownedView, wishlist: wishView, cart: cartView,
    gameMeta: gameMeta.status(),
    history: s.history.slice(-12).reverse(),
    browsers: det.browsers, anyBrowserLoggedIn: det.anyLoggedIn, detectionNote: det.note,
    browserCheckedAt: det.checkedAt,
    // ★ 实时标签探测（CDP）：只要 Steam 网页当前在浏览器里打开，就显示「识别到」
    detected: liveState.detected,
    detectedNow: liveState.detected || s.loggedIn,
    debuggerAttached: !!debuggerEp,
    debuggerBrowser: debuggerEp ? debuggerEp.browser : '',
    debuggerSource: debuggerEp ? debuggerEp.source : '',
    openTabs: liveState.openTabs.slice(0, 25),
    openSteamTabs: liveState.openTabs.filter(t => /steam/i.test(t.url || t.title || '')).length,
    debugNote: liveState.enabled
      ? (debuggerEp ? '已连接浏览器调试接口，正在每秒监听 Steam 标签页。' : '正在尝试发现已开启调试的浏览器…')
      : '未启用调试监听：用「调试模式打开 Steam」或手动给浏览器加 --remote-debugging-port 后即可实时识别。',
    collectorActive: s.collectedAt > 0 && Date.now() - s.collectedAt < 5000,
    secondsSinceSync: s.collectedAt ? Math.round((Date.now() - s.collectedAt) / 1000) : null,
    // CDP 链路诊断：注入成功 / 失败次数、主动采集次数、最近错误，方便一眼看出卡在哪
    cdpInjectOk: Number(liveState.injectOk || 0),
    cdpInjectFail: Number(liveState.injectFail || 0),
    cdpCollectCount: Number(liveState.collectCount || 0),
    cdpLastCollectAt: Number(liveState.lastCollectAt || 0),
    cdpLastError: String(liveState.lastCdpError || ''),
    serverNow: Date.now(), pollIntervalSec: 1,
    apiKeySet: !!cfg.apiKey,
    friendSession: (() => {
      const fs7 = friendStates();
      const at = fs7?.ts || 0;
      return {
        count: fs7?.friends?.length || 0,
        online: (fs7?.friends || []).filter(x => x.personastate > 0).length,
        at, page: fs7?.page || '',
        secondsAgo: at ? Math.round((Date.now() - at) / 1000) : null,
        fresh: !!at && Date.now() - at < 5 * 60 * 1000
      };
    })()
  };
}

/* ------------------------------ 实时标签探测（CDP） ------------------------------
 * 仅当你用 SteamLens 的「调试模式」打开浏览器，或手动给浏览器加了
 * --remote-debugging-port，这里才能读到「当前打开了哪些标签页」。
 * 一旦发现 Steam 标签页，立即注入采集脚本把数据导回来，并把状态从
 * 「未识别到」变成「识别到」。
 * 不读取任何 Cookie、不接管登录，只列出标签页 URL 与注入只读脚本。
 */
let debuggerEp = null;        // { port, host, browser, source }
let liveState = { openTabs: [], detected: false, lastPoll: 0, injected: {}, enabled: false };
let cdpTimer = null;

function findBrowserExe() {
  const cand = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
  ].filter(Boolean);
  for (const c of cand) { try { if (fs.existsSync(c)) return c; } catch { /* */ } }
  for (const name of ['chrome', 'msedge', 'brave']) {
    try {
      const p = execSync(`where ${name}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split(/\r?\n/)[0].trim();
      if (p && fs.existsSync(p)) return p;
    } catch { /* */ }
  }
  return '';
}

function detectDevToolsPort() {
  const roots = [
    ['Chrome', path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data')],
    ['Edge', path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data')]
  ];
  for (const [name, root] of roots) {
    const f = path.join(root, 'DevToolsActivePort');
    try {
      if (fs.existsSync(f)) {
        const port = parseInt(fs.readFileSync(f, 'utf8').split(/\r?\n/)[0], 10);
        if (port > 0) return { port, host: '127.0.0.1', browser: name, source: 'running' };
      }
    } catch { /* */ }
  }
  return null;
}

async function httpGetJson(url) {
  try { const r = await fetch(url); if (!r.ok) return null; return await r.json(); }
  catch { return null; }
}

/* Node 22 的全局 WebSocket 是 WHATWG 版本：只有 onopen / onmessage / onerror / onclose，
 * 没有 EventEmitter 风格的 ws.on()。旧写法每次注入都抛 TypeError 并被静默吞掉，
 * 表现就是「标签识别到了，但一条数据都收不到」。 */
function cdpCommand(targetId, method, params, timeout = 9000) {
  if (typeof WebSocket === 'undefined' || !debuggerEp) return Promise.resolve(null);
  const url = `ws://${debuggerEp.host}:${debuggerEp.port}/devtools/page/${targetId}`;
  return new Promise(resolve => {
    let ws, to, done = false;
    const finish = v => {
      if (done) return;
      done = true;
      try { clearTimeout(to); } catch {}
      try { ws.close(); } catch {}
      resolve(v);
    };
    try { ws = new WebSocket(url); } catch { return resolve(null); }
    to = setTimeout(() => finish(null), timeout);
    ws.onopen = () => {
      try { ws.send(JSON.stringify({ id: 1, method, params: params || {} })); }
      catch { finish(null); }
    };
    ws.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(String((ev && ev.data) || ev)); } catch { return; }
      if (msg && msg.id === 1) finish(msg);
    };
    ws.onerror = () => finish(null);
    ws.onclose = () => finish(null);
  });
}

function cdpEval(targetId, expression) {
  return cdpCommand(targetId, 'Runtime.evaluate', {
    expression, returnByValue: false, awaitPromise: false
  }).then(r => !!(r && !r.error && !r.result?.exceptionDetails));
}

async function cdpEvalValue(targetId, expression, timeout = 8000) {
  const r = await cdpCommand(targetId, 'Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: false, userGesture: true
  }, timeout);
  if (!r || r.error || r.result?.exceptionDetails) return null;
  return r.result?.result?.value ?? null;
}

/* 支持返回 Promise（例如同源 fetch Steam 官方 XML 游戏清单） */
async function cdpEvalAsync(targetId, expression, timeout = 12000) {
  const r = await cdpCommand(targetId, 'Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, userGesture: true
  }, timeout);
  if (!r || r.error || r.result?.exceptionDetails) return null;
  return r.result?.result?.value ?? null;
}

/* 调试端口持久化：服务重启后仍自动连回原来的浏览器 */
function ensureDataDir() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {} }
function saveDebugEp() {
  try { ensureDataDir(); fs.writeFileSync(DEBUG_EP_FILE, JSON.stringify(debuggerEp || null), 'utf8'); } catch {}
}
function restoreDebugEp() {
  if (debuggerEp) return;
  try {
    const j = JSON.parse(fs.readFileSync(DEBUG_EP_FILE, 'utf8'));
    if (j && Number(j.port) > 0) {
      debuggerEp = {
        port: Number(j.port), host: String(j.host || '127.0.0.1'),
        browser: String(j.browser || 'manual'), source: String(j.source || 'restored')
      };
    }
  } catch {}
}

/* 服务端主动取数：在 Steam 标签页内同源读取 dynamicstore + 当前 DOM，
 * 通过 CDP 的 returnByValue 直接把结果交给 Node 落盘。
 * 不依赖「HTTPS 页面 POST 回 http://127.0.0.1」（会被浏览器 PNA / 混合内容拦）。 */
/* ★ 购物车专用提取函数（源码字符串）。
   同时注入「CDP 主动取数」和「浏览器采集器」两条通道，两边口径必须完全一致：
     1) 只认官方 rgAppsInCart 清单 + 购物车容器内的行；
     2) 绝不用整页 a[href*="/app/"] —— 那会把「为您推荐 / 猜你喜欢 / 轮播 / 胶囊」全扫进来；
     3) 祖先里带 recommend / suggest / carousel / capsule 等字样的节点一律剔除；
     4) 只有购物车页明确显示「购物车是空的」才允许服务端清空。 */
const CART_FN_SRC = String.raw`
  function steamLensCart(host) {
    var out = [], seen = {}, filtered = 0, domCount = 0;
    var isCartPage = /cart|checkout|shoppingcart/i.test(String(host.path || ''));
    function inRecommend(n) {
      var e = n;
      while (e && e !== document.body && e !== document.documentElement) {
        var k = String(e.className || '') + ' ' + String(e.id || '');
        if (/recommend|suggest|also.?like|carousel|capsule|discovery|curator|special|footer|related/i.test(k)) return true;
        e = e.parentElement;
      }
      return false;
    }
    function add(id, n, fromDom) {
      id = String(id || '');
      if (!/^\d{1,12}$/.test(id) || seen[id]) return;
      if (fromDom && inRecommend(n)) { filtered++; return; }
      seen[id] = 1;
      if (fromDom) domCount++;
      var t = n && n.querySelector && n.querySelector('.cart_item_desc, .gameListRowItemName, .title, .name');
      out.push({ appid: id, name: (t && t.textContent || '').trim().slice(0, 120) });
    }
    // 1) 官方清单：Steam 商店自己的 rgAppsInCart，天然不含任何推荐位
    var store = (host.store || window.__steamLensStore || null);
    if (store && Array.isArray(store.cart)) {
      store.cart.forEach(function (id) { add(id, null, false); });
    }
    // 2) 购物车容器内的行：限定容器，找不到容器时只允许明确的购物车行类名
    var roots = document.querySelectorAll(
      '#cart_content, .cart_content, #shopping_cart, .shopping_cart, ' +
      '.cart_item_list, #cart_item_list, .cart_items, [class*="cart_item_list"], ' +
      '.checkout_content, form[action*="checkout"]'
    );
    var rows = [];
    roots.forEach(function (r) {
      r.querySelectorAll('.cart_item_row, .cart_item, .cart_row, [data-cart-item], [data-ds-appid], [data-appid], a[href*="/app/"]')
        .forEach(function (n) { rows.push(n); });
    });
    if (!rows.length && isCartPage) {
      document.querySelectorAll('.cart_item_row, .cart_item, .cart_row, [data-cart-item]')
        .forEach(function (n) { rows.push(n); });
    }
    rows.forEach(function (n) {
      var id = n.getAttribute && (n.getAttribute('data-ds-appid') || n.getAttribute('data-appid') || n.getAttribute('data-cart-item'));
      if (!id) { var m = (n.getAttribute('href') || '').match(/\/app\/(\d+)/); if (m) id = m[1]; }
      if (!id && n.querySelector) {
        var a = n.querySelector('a[href*="/app/"], [data-ds-appid], [data-appid]');
        if (a) {
          id = a.getAttribute('data-ds-appid') || a.getAttribute('data-appid');
          if (!id) { var m2 = (a.getAttribute('href') || '').match(/\/app\/(\d+)/); if (m2) id = m2[1]; }
        }
      }
      if (id) add(id, n, true);
    });
    // 3) 明确为空：只有购物车页、DOM 里一行都没有、且页面写着「购物车是空的」才算真清空
    var bodyTxt = String((document.body && document.body.innerText) || '').slice(0, 20000);
    var emptyText = /购物车是空的|购物车为空|Your cart is empty|cart is empty|no items in your cart/i;
    if (isCartPage && domCount === 0 && emptyText.test(bodyTxt)) {
      return { items: [], confirmedEmpty: true, filtered: filtered, isCartPage: true };
    }
    return { items: out, confirmedEmpty: false, filtered: filtered, isCartPage: isCartPage };
  }
`;

/* ---------------- Steam 徽章页解析（浏览器端同源读取，不需要 API Key） ----------------
   徽章在 steamcommunity.com/<id>/badges 的 DOM 里；IPlayerService/GetBadges 需要官方
   Web API Key，而本机 config 里的 SCT... 是 Server酱 SendKey，调不了 Web API。
   所以这里完全走「用户已登录的 Steam 网页端」：采集器 / CDP 在该页面执行本函数，
   只把公开的徽章名、等级、XP 回传本机，凭证不出浏览器。 */
const BADGES_FN_SRC = `
function steamLensBadges() {
  try {
    if (location.hostname.indexOf('steamcommunity.com') < 0) return null;
    if (!/\\/badges(\\/|$|\\?)/i.test(location.pathname)) return null;
    var id = (location.pathname.match(/\\/profiles\\/(\\d{17})/) || [])[1] || '';
    if (!/^\\d{17}$/.test(id)) {
      try { id = String((window.g_rgProfileData || {}).steamid || ''); } catch (e) {}
    }
    if (!/^\\d{17}$/.test(id)) {
      var mp = document.querySelector('[data-miniprofile], [data-steamid]');
      if (mp) {
        var raw = String(mp.getAttribute('data-miniprofile') || mp.getAttribute('data-steamid') || '');
        if (/^\\d{17}$/.test(raw)) id = raw;
      }
    }
    if (!/^\\d{17}$/.test(id)) return null;
    var name = '';
    var nm = document.querySelector('.actual_persona_name, .profile_small_header_name, .persona_name');
    if (nm) name = (nm.textContent || '').trim().slice(0, 60);
    var level = null;
    var lv = document.querySelector('.profile_xp_block_level, .player_level, .persona_level, .friendPlayerLevel');
    if (lv) { var lm = (lv.textContent || '').match(/(\\d+)/); if (lm) level = Number(lm[1]); }
    var badges = [], seen = {};
    var rows = document.querySelectorAll('.badge_row, .badge_row_inner, .badge_row_content, .badge');
    for (var i = 0; i < rows.length && badges.length < 80; i++) {
      var r = rows[i];
      var tEl = r.querySelector('.badge_title, .badge_info_title, .badge_name, .badge_row_title');
      var title = tEl ? (tEl.textContent || '').replace(/\\s+/g, ' ').trim() : '';
      if (!title) continue;
      var lvEl = r.querySelector('.badge_current_level, .badge_info_level, .badge_level');
      var lvTxt = lvEl ? (lvEl.textContent || '') : '';
      var lvM = lvTxt.match(/(\\d+)/);
      var bLevel = lvM ? Number(lvM[1]) : 0;
      var xpEl = r.querySelector('.badge_progress_info, .badge_xp, .xp');
      var xpTxt = xpEl ? (xpEl.textContent || '') : '';
      var xpM = xpTxt.match(/([\\d,\\.]+)\\s*XP/i);
      var xp = xpM ? Number(xpM[1].replace(/,/g, '')) : 0;
      var appid = '';
      var aEl = r.querySelector('a[href*="/app/"], [data-appid]');
      if (aEl) {
        var am = (aEl.getAttribute('href') || '').match(/\\/app\\/(\\d+)/);
        appid = am ? am[1] : String(aEl.getAttribute('data-appid') || '');
      }
      var scEl = r.querySelector('.badge_detail, .badge_rarity, .badge_scarcity');
      var scarcity = 0;
      if (scEl) {
        var sm = (scEl.textContent || '').match(/([\\d,\\.]+)\\s*%/);
        if (sm) scarcity = Number(sm[1].replace(/,/g, ''));
      }
      var key = title + '|' + appid;
      if (seen[key]) continue;
      seen[key] = 1;
      badges.push({ name: title.slice(0, 80), level: bLevel, xp: xp, appid: appid, scarcity: scarcity });
    }
    return { source: 'collector-badges', steamId64: id, name: name, level: level, badges: badges, url: location.href };
  } catch (e) { return null; }
}
`;

/* 「朋友的朋友」：Steam 社区好友列表页只能在「已登录的浏览器」里读到。
   之前服务端用 net.get() 直连 /profiles/<id>/friends/ 不带 Cookie，所以用户开着浏览器
   也扫不出来。这里在浏览器标签内解析 DOM，把名单回传本机，凭证不出浏览器。 */
const FOF_FN_SRC = `
function steamLensFof() {
  try {
    if (location.hostname.indexOf('steamcommunity.com') < 0) return null;
    if (!/\\/friends(\\/|$|\\?)/i.test(location.pathname)) return null;
    var own = (location.pathname.match(/\\/profiles\\/(\\d{17})/) || [])[1] || '';
    if (!own) { try { own = String((window.g_rgProfileData || {}).steamid || ''); } catch (e) {} }
    if (!/^\\d{17}$/.test(own)) {
      var mp = document.querySelector('[data-miniprofile], [data-steamid]');
      if (mp) {
        var raw = String(mp.getAttribute('data-miniprofile') || mp.getAttribute('data-steamid') || '');
        if (/^\\d{17}$/.test(raw)) own = raw;
      }
    }
    if (!/^\\d{17}$/.test(own)) return null;
    var ownerName = '';
    var onm = document.querySelector('.actual_persona_name, .profile_small_header_name, .persona_name, #friendListBlock h1');
    if (onm) ownerName = (onm.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
    var people = [], seen = {};
    /* 新版 Steam 好友页：.friend_block_v2.persona 里的
       .friend_block_content = "真名<br><span class=friend_small_text>正在玩的游戏</span>"。
       旧解析直接取整块 textContent，人名就变成 "LUYUE04 Mortuus Demo"。
       这里把状态 / 游戏节点剥掉，只留名字。 */
    function slName(el) {
      if (!el) return '';
      var c = el.cloneNode(true);
      var junk = c.querySelectorAll('.friend_small_text, .friend_game_link, .friend_status, .friend_last_online, .friend_game_info, .friendBlockStatus, .friendBlockGameName, .status');
      for (var j = 0; j < junk.length; j++) {
        if (junk[j].parentNode) junk[j].parentNode.removeChild(junk[j]);
      }
      return (c.textContent || '').replace(/\\s+/g, ' ').trim();
    }
    var nodes = document.querySelectorAll('.friend_block_v2, .friendBlock, .friend_block, .friendlist_row, [data-steamid], [data-miniprofile], a[href*="/profiles/"]');
    for (var i = 0; i < nodes.length && people.length < 200; i++) {
      var n = nodes[i];
      var id = String((n.getAttribute && (n.getAttribute('data-steamid') || n.getAttribute('data-miniprofile'))) || '');
      if (!/^\\d{17}$/.test(id)) {
        var h = String((n.getAttribute && n.getAttribute('href')) || '');
        var hm = h.match(/\\/profiles\\/(\\d{17})/);
        id = hm ? hm[1] : '';
      }
      if (!/^\\d{17}$/.test(id) || id === own || seen[id]) continue;
      seen[id] = 1;
      var nm = '';
      var ne = n.querySelector && (n.querySelector('.friendBlockPersonaName') ||
        n.querySelector('.friend_name') ||
        n.querySelector('.friend_block_content, .friendBlockContent') ||
        n.querySelector('.persona'));
      if (ne) nm = slName(ne);
      /* 有些版本整个块自己就带 .persona，querySelector 不包含自身 */
      if (!nm && n.classList && n.classList.contains('persona')) nm = slName(n);
      if (!nm && n.tagName === 'A') nm = slName(n);
      var pm = nm.search(/\\s(?:正在玩|In-Game|游戏中)\\s/i);
      if (pm > 0) nm = nm.slice(0, pm).trim();
      /* 兜底：Steam 给搜索用的 data-search="人名 ; 游戏名 ; "，第一段就是人名 */
      if (!nm) {
        var ds = String((n.getAttribute && n.getAttribute('data-search')) || '');
        nm = ds.split(';')[0].replace(/\\s+/g, ' ').trim();
      }
      if (!nm) continue;
      var av = '';
      var im = n.querySelector && n.querySelector('img[src*="avatars"]');
      if (im) av = String(im.getAttribute('src') || '');
      people.push({ steamId64: id, name: nm.slice(0, 80), avatar: av.slice(0, 200),
        profileUrl: 'https://steamcommunity.com/profiles/' + id + '/' });
    }
    return { source: 'collector-fof', steamId64: own, ownerName: ownerName,
      people: people, url: location.href, ts: Date.now() };
  } catch (e) { return null; }
}
`;

/* 「朋友的朋友」的游戏库：Steam 社区 /profiles/<id>/games/?tab=all 页面。
   优先读页面自带的 rgGames 全局数组，再兜底 DOM 行；全程在已登录标签内同源读取，
   不需要 Steam Web API Key。结果单独落盘，不会被好友库缓存覆写。 */
const LIB_FN_SRC = `
function steamLensFofLibrary() {
  try {
    if (location.hostname.indexOf('steamcommunity.com') < 0) return null;
    if (!/\\/games(\\/|$|\\?)/i.test(location.pathname)) return null;
    var own = (location.pathname.match(/\\/profiles\\/(\\d{17})/) || [])[1] || '';
    if (!/^\\d{17}$/.test(own)) { try { own = String((window.g_rgProfileData || {}).steamid || ''); } catch (e) {} }
    if (!/^\\d{17}$/.test(own)) return null;
    var nmEl = document.querySelector('.actual_persona_name, .profile_small_header_name, .persona_name');
    var name = nmEl ? (nmEl.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80) : '';
    var games = [], idx = {};
    function add(appid, gname) {
      var a = String(appid || '').trim();
      if (!/^\\d+$/.test(a)) return;
      var n = String(gname || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
      var i = idx[a];
      /* 新版 Steam 每款游戏有 3 个 /app/ 链接：第一个是纯图片（没文字），
         第二个才带游戏名。旧的 seen 去重会让图片链接先占坑，名字全变成 App XXX。 */
      if (i !== undefined) {
        if (n && (!games[i].name || /^App \\d+$/.test(games[i].name))) games[i].name = n;
        return;
      }
      idx[a] = games.length;
      games.push({ appid: a, name: n || ('App ' + a) });
    }
    var rg = window.rgGames || window.g_rgGames || window.g_rgAppInfo || null;
    if (rg) {
      var arr = Array.isArray(rg) ? rg : Object.keys(rg).map(function (k) { return rg[k]; });
      for (var i = 0; i < arr.length && games.length < 1200; i++) {
        var g = arr[i]; if (!g) continue;
        add(g.appid || g.appID || g.id, g.name || g.title);
      }
    }
    var rows = document.querySelectorAll('.gameListRow, [id^="game_"], .game_area_dlc_row, a[href*="/app/"]');
    for (var j = 0; j < rows.length && games.length < 1200; j++) {
      var r = rows[j];
      var aid = String((r.getAttribute && (r.getAttribute('data-appid') || r.getAttribute('data-ds-appid'))) || '');
      if (!/^\\d+$/.test(aid)) { var rm = String(r.id || '').match(/^game_(\\d+)/); if (rm) aid = rm[1]; }
      if (!/^\\d+$/.test(aid)) { var hm = String((r.getAttribute && r.getAttribute('href')) || '').match(/\\/app\\/(\\d+)/); if (hm) aid = hm[1]; }
      if (!/^\\d+$/.test(aid)) continue;
      var t = r.querySelector && r.querySelector('.gameListRowItemName, .game_name, .title, .name');
      add(aid, t ? t.textContent : (r.textContent || ''));
    }
    return { source: 'collector-fof-library', steamId64: own, name: name,
      games: games, url: location.href, ts: Date.now() };
  } catch (e) { return null; }
}
`;

/* Steam 商店权威清单（同源、带登录 Cookie）：一次拿全「已购买 / 愿望单 / 购物车 / 隐藏」 */
const STORE_EXPR = `(async function(){
  try {
    if (location.hostname.indexOf('steampowered.com') < 0) return null;
    var r = await fetch('/dynamicstore/userdata/', { credentials: 'include' });
    var j = await r.json();
    if (!j) return null;
    return {
      ownedApps: j.rgOwnedApps || [], wishlist: j.rgWishlist || [],
      cart: j.rgAppsInCart || [], hiddenApps: j.rgHiddenApps || [],
      url: location.href
    };
  } catch (e) { return null; }
})()`;

/* 徽章页专用取数：CDP_COLLECT_EXPR 只在「有徽章」时才带 out.badges，
   这里直接调同一个解析函数，连「0 枚徽章 / 只有等级」的档案也能回传落盘。 */
const BADGE_EXPR = `(function(){
  ${BADGES_FN_SRC}
  return steamLensBadges();
})()`;

const CDP_COLLECT_EXPR = `(function(){
  try {
    ${CART_FN_SRC}
    ${BADGES_FN_SRC}
    ${FOF_FN_SRC}
    ${LIB_FN_SRC}
    var out = { url: location.href, page: location.pathname, loggedIn:false, personaName:'', steamId64:'', games:[], cart:[], cartSource:'cart', cartConfirmedEmpty:false, cartFilteredCount:0, store:null, badges:null, fof:null, fofLibrary:null };
    var signIn = document.querySelector('#global_action_menu a[href*="login"], .global_action_link[href*="login"]');
    out.loggedIn = !signIn;
    var nm = document.querySelector('.persona_name, #account_pulldown');
    out.personaName = nm ? (nm.textContent||'').trim().slice(0,60) : '';
    var pm = location.href.match(/\\/profiles\\/(\\d{17})/);
    out.steamId64 = pm ? pm[1] : '';
    var seen = {}, nodes = document.querySelectorAll('[data-ds-appid], .wishlist_row, .cart_item_row, .gameListRow, a[href*="/app/"]');
    for (var i=0;i<nodes.length && out.games.length<600;i++) {
      var n = nodes[i];
      var id = n.getAttribute && (n.getAttribute('data-ds-appid') || n.getAttribute('data-appid'));
      if (!id) { var m=(n.getAttribute('href')||'').match(/\\/app\\/(\\d+)/); if(m) id=m[1]; }
      if (!id || !/^\\d+$/.test(id) || seen[id]) continue;
      seen[id]=1;
      var t = n.querySelector && n.querySelector('.gameListRowItemName, .wishlist_row .title, .cart_item_desc, .name');
      out.games.push({appid:String(id), name:(t&&t.textContent||'').trim().slice(0,120)});
    }
    /* 购物车走专用通道：只含购物车项，推荐位一概不进 */
    var cartRes = steamLensCart({ path: location.pathname, store: window.__steamLensStore });
    out.cart = cartRes.items;
    out.cartConfirmedEmpty = cartRes.confirmedEmpty;
    out.cartFilteredCount = cartRes.filtered;
    /* dynamicstore 在后台标签里可能长时间挂起（连 timer 都被节流）：
       发起后不等待，本轮先把页面 DOM 数据 + 上一轮的商店结果交回去，下一轮再取新的。 */
    out.store = window.__steamLensStore || null;
    if (location.hostname.indexOf('steampowered.com') >= 0) {
      try {
        fetch('/dynamicstore/userdata/', {credentials:'include'})
          .then(function(r){ return r.json(); })
          .then(function(j){
            window.__steamLensStore = j ? {
              ownedApps:j.rgOwnedApps||[], wishlist:j.rgWishlist||[],
              cart:j.rgAppsInCart||[], hiddenApps:j.rgHiddenApps||[]
            } : null;
          })
          .catch(function(){});
      } catch(e) {}
    }
    /* 当前标签正好停在徽章页时，顺带把这位好友的 Steam 徽章一起带回来 */
    try { var badgeRes = steamLensBadges(); if (badgeRes && badgeRes.badges && badgeRes.badges.length) out.badges = badgeRes; } catch(e) {}
    /* 停在 /profiles/<id>/friends 好友列表页时，把「他朋友的朋友」一起带回来 */
    try { var fofRes = steamLensFof(); if (fofRes && fofRes.steamId64) out.fof = fofRes; } catch(e) {}
    /* 停在 /profiles/<id>/games 页时，把这位（通常是朋友的朋友）的游戏库带回来 */
    try { var libRes = steamLensFofLibrary(); if (libRes && libRes.steamId64) out.fofLibrary = libRes; } catch(e) {}
    return out;
  } catch(e) { return { error:String(e && e.message || e), url:location.href }; }
})()`;

async function cdpCollect(tab) {
  const v = await cdpEvalValue(tab.id, CDP_COLLECT_EXPR);
  if (!v || typeof v !== 'object' || v.error) {
    liveState.lastCdpError = v && v.error ? String(v.error) : 'CDP 未返回数据';
    return false;
  }
  liveState.lastCdpError = '';
  liveState.collectCount = Number(liveState.collectCount || 0) + 1;
  const games = Array.isArray(v.games) ? v.games : [];
  const cartItems = Array.isArray(v.cart) ? v.cart : [];
  const page = String(v.page || '');
  const isWish = /wishlist/i.test(page);
  const isCart = /cart|checkout|shoppingcart/i.test(page);
  const isOwn = /\/games|\/library|\/account|\/mygames/i.test(page);
  /* 自动巡航标签打开的是「别人的」游戏库页，那里满屏 a[href*="/app/"] 是对方的游戏，
     绝不能当成「我拥有的游戏」写回本机快照。 */
  const isScanTab = /sl_scan=1/.test(String(v.url || page || '')) || !!(v.fofLibrary && v.fofLibrary.steamId64);
  // 商店首页 / 购物车页的 a[href*="/app/"] 都是推荐位，不是「已拥有」，别误算进游戏库
  const useful = !isScanTab && (isWish || isOwn);
  /* 徽章页 / 好友列表页优先独立落盘，即使这个页面的游戏清单不可用也不影响它们 */
  if (v.badges && v.badges.steamId64) {
    try { ingest(v.badges); } catch {}
  }
  if (v.fof && v.fof.steamId64) {
    try { ingest(v.fof); } catch {}
  }
  if (v.fofLibrary && v.fofLibrary.steamId64) {
    try { ingest(v.fofLibrary); } catch {}
  }
  try {
    ingest({
      source: 'collector-cdp',
      url: v.url, page, browser: debuggerEp?.browser || 'CDP',
      loggedIn: !!v.loggedIn, personaName: v.personaName || '', steamId64: v.steamId64 || '',
      games: useful ? games : [],
      owned: useful && isOwn ? games : [],
      wishlist: isWish ? games : [],
      // 购物车始终走专用通道（官方清单在任意 Steam 页面都能读到，切页面也不会丢）
      cart: cartItems,
      cartSource: 'cart',
      cartConfirmedEmpty: v.cartConfirmedEmpty === true && isCart,
      cartFilteredCount: Number(v.cartFilteredCount) || 0,
      hidden: /hidden/i.test(page) ? games : [],
      store: v.store
    });
  } catch (e) { liveState.lastCdpError = e.message; return false; }
  return true;
}

/* 在已附加的调试浏览器里打开一个 Steam 徽章页：pollTargets() 下一轮会给它注入采集器，
   徽章就会被自动回传。没连上调试接口时把 url 交回前端，由用户点开也照样能采。 */
async function openBadgeTab(url) {
  if (!debuggerEp) return { opened: false, reason: '浏览器调试接口尚未连接' };
  try {
    const ep = `http://${debuggerEp.host}:${debuggerEp.port}/json/new?${encodeURIComponent(url)}`;
    const r = await fetch(ep, { method: 'PUT' });
    if (!r.ok) return { opened: false, reason: `调试接口返回 ${r.status}` };
    const t = await r.json().catch(() => ({}));
    return { opened: true, targetId: String(t.id || '') };
  } catch (e) { return { opened: false, reason: String(e && e.message || e) }; }
}

/** 通用：在已附加的调试浏览器里打开任意 Steam 页面（徽章页 / 好友列表页都走这里） */
async function openSteamTab(url) { return openBadgeTab(url); }

/* ---------------- 朋友的朋友：自动巡航扫描 ----------------
   用户不用手动开网页：服务端在已附加的调试浏览器里维护一个专用标签，
   依次导航到「我的好友的 /friends 页」采关系链、「朋友的朋友的 /games 页」采游戏库，
   页面加载后主动 CDP 取数并落盘；前端每秒刷新就能看到结果。
   专用标签 URL 带 sl_scan=1，pollTargets 会跳过它，避免把对方的游戏误算成「我拥有的」。 */
const AUTO_GAP_MS = 7000;
/* 调试浏览器被用户关掉后 2 分钟自动重开，避免巡航永远卡在 fetch failed */
const AUTO_LAUNCH_GAP_MS = 2 * 60 * 1000;
const AUTO_SHOP_GAP_MS = 45000;
const AUTO_CFG_FILE = path.join(DATA_DIR, 'auto-cruise.json');
function readAutoEnabled() {
  try {
    const j = JSON.parse(fs.readFileSync(AUTO_CFG_FILE, 'utf8'));
    return typeof j?.enabled === 'boolean' ? j.enabled : true;
  } catch { return true; }
}
function writeAutoEnabled(v) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(AUTO_CFG_FILE, JSON.stringify({ enabled: !!v, at: Date.now() }, null, 2), 'utf8'); } catch {}
}
const sleepMs = ms => new Promise(r => setTimeout(r, ms));
/* 服务重启时端口配置是持久化恢复的：先探一下 CDP 是否真的活着，
   活着就直接连回，不再重复拉起一个浏览器窗口。 */
async function cdpReachable() {
  let ep = debuggerEp;
  if (!ep) {
    try {
      const j = JSON.parse(fs.readFileSync(DEBUG_EP_FILE, 'utf8'));
      if (Number(j?.port) > 0) ep = { port: Number(j.port), host: String(j.host || '127.0.0.1'), source: 'restored' };
    } catch { return null; }
  }
  if (!ep) return null;
  const v = await httpGetJson(`http://${ep.host}:${ep.port}/json/version`);
  return v ? ep : null;
}
let autoScanTimer = null, autoLastRebuild = 0;
const auto = {
  enabled: readAutoEnabled(), running: false, lastAt: 0, lastLaunch: 0,
  lastShopAt: 0, shopIdx: 0, tabId: '',
  queue: [], done: {}, cycles: 0,
  scanned: { fof: 0, library: 0, shop: 0, badges: 0 }, lastShop: null,
  note: '等待浏览器连接', lastError: ''
};
/* 商店数据也自动巡航：dynamicstore 一次给全量「已购买 / 愿望单 / 购物车」ID，
   三个页面轮换只为补 DOM 上的游戏名。 */
const SHOP_PAGES = [
  { key: 'store', url: 'https://store.steampowered.com/?sl_scan=1' },
  { key: 'wishlist', url: 'https://store.steampowered.com/wishlist/?sl_scan=1' },
  { key: 'cart', url: 'https://store.steampowered.com/cart/?sl_scan=1' }
];
const fofUrl = id => `https://steamcommunity.com/profiles/${id}/friends/?sl_scan=1`;
const libUrl = id => `https://steamcommunity.com/profiles/${id}/games/?tab=all&sl_scan=1`;
const badgeUrl = id => `https://steamcommunity.com/profiles/${id}/badges/?sl_scan=1`;

function myFriendIds() {
  const out = [];
  const push = id => { const s = String(id || ''); if (/^7656119\d{10}$/.test(s) && !out.includes(s)) out.push(s); };
  try {
    const sc = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'steam-client-friends.json'), 'utf8'));
    for (const f of sc.friends || []) push(f.steamid || f.steamId64);
  } catch {}
  try {
    const d = JSON.parse(fs.readFileSync(FOF_FILE, 'utf8'));
    for (const f of d.direct || []) push(f.steamId64);
  } catch {}
  return out.slice(0, 40);
}
function fofPersonIds() {
  try {
    const d = JSON.parse(fs.readFileSync(FOF_FILE, 'utf8'));
    return [...new Set((d.extended || []).map(x => String(x.steamId64 || '')))]
      .filter(id => /^7656119\d{10}$/.test(id)).slice(0, 80);
  } catch { return []; }
}
function rebuildAutoQueue() {
  /* 一整轮扫完休息 60 秒，避免不停跳页面打扰用户 */
  if (Date.now() - autoLastRebuild < 60000) return;
  autoLastRebuild = Date.now();
  auto.cycles++;
  const mine = myFriendIds();
  for (const id of mine) auto.queue.push({ kind: 'fof', id, url: fofUrl(id) });
  /* 徽章页也归入巡航队列：好友 Steam 等级 / 徽章不再需要手动点「打开徽章页」 */
  for (const id of mine) auto.queue.push({ kind: 'badge', id, url: badgeUrl(id) });
  for (const id of fofPersonIds()) auto.queue.push({ kind: 'library', id, url: libUrl(id) });
}
async function ensureAutoScanTab() {
  const base = `http://${debuggerEp.host}:${debuggerEp.port}`;
  if (auto.tabId) {
    const list = await httpGetJson(base + '/json/list');
    if (Array.isArray(list) && list.some(t => t.id === auto.tabId && t.type === 'page')) return auto.tabId;
    auto.tabId = '';
  }
  const r = await openSteamTab('https://steamcommunity.com/?sl_scan=1');
  if (r.opened && r.targetId) { auto.tabId = r.targetId; return auto.tabId; }
  auto.lastError = r.reason || '无法创建巡航标签';
  return '';
}
async function autoScanTick() {
  if (!auto.enabled || auto.running) return;
  /* 浏览器被关掉后持久化的调试端口还在、CDP 却已连不上：以最近一次成功轮询为准，
     超过 20 秒就判定掉线并节流自动重开，不会永远卡在 "fetch failed"。 */
  const cdpAlive = !!debuggerEp && Date.now() - Number(liveState.lastPoll || 0) < 20000;
  if (!debuggerEp || !cdpAlive) {
    if (Date.now() - auto.lastLaunch > AUTO_LAUNCH_GAP_MS) {
      auto.lastLaunch = Date.now();
      try {
        const ep = await cdpReachable();
        if (ep) {
          restoreDebugEp();
          auto.note = '调试浏览器已就绪，正在连回自动巡航';
        } else {
          const r = launchSteamDebug();
          auto.tabId = '';
          auto.note = r && r.ok === false
            ? String(r.error || '无法打开调试浏览器')
            : '调试浏览器已关闭，正在自动重新打开（首次需登录一次 Steam）';
        }
      } catch (e) { auto.lastError = String(e.message || e); }
    } else {
      auto.note = cdpAlive ? '等待浏览器调试接口'
        : '调试浏览器已关闭，等待自动重开（每 2 分钟重试一次）';
    }
    return;
  }
  if (Date.now() - auto.lastAt < AUTO_GAP_MS) return;
  auto.running = true; auto.lastAt = Date.now();
  try {
    const tabId = await ensureAutoScanTab();
    if (!tabId) { auto.note = '浏览器调试接口未连接：' + auto.lastError; return; }
    /* 游戏库 / 愿望单 / 购物车：独立于好友队列，每 45 秒自动更新一次。
       dynamicstore 一次给全量真值，三个页面轮换只为补 DOM 上的游戏名。 */
    if (Date.now() - (auto.lastShopAt || 0) > AUTO_SHOP_GAP_MS) {
      const p = SHOP_PAGES[auto.shopIdx % SHOP_PAGES.length];
      auto.shopIdx++;
      auto.lastShopAt = Date.now();
      auto.queue.unshift({ kind: 'shop', id: 'store-' + p.key, shop: p.key, url: p.url });
    }
    if (!auto.queue.length) rebuildAutoQueue();
    const job = auto.queue.shift();
    if (!job) { auto.note = `本轮已扫完（第 ${auto.cycles} 轮），60 秒后自动重扫`; return; }
    const nav = await cdpCommand(tabId, 'Page.navigate', { url: job.url });
    if (!nav || nav.error) { auto.queue.push(job); auto.note = '页面导航失败，稍后重试'; return; }
    await sleepMs(2600);   // 等 Steam 社区页把 rgGames / 好友列表渲染出来
    const v = await cdpEvalValue(tabId, CDP_COLLECT_EXPR, 10000);
    if (!v || typeof v !== 'object' || v.error) {
      auto.queue.push(job); auto.note = '页面读取失败：' + String(v?.error || '无响应'); return;
    }
    if (job.kind === 'fof') {
      if (v.fof && v.fof.steamId64) {
        ingest(v.fof); auto.scanned.fof++;
        /* 刚采到的朋友的朋友立刻排进游戏库队列，不用等下一轮 */
        for (const p of (v.fof.people || []).slice(0, 40)) {
          const id = String(p.steamId64 || '');
          if (/^7656119\d{10}$/.test(id) && !auto.queue.some(j => j.kind === 'library' && j.id === id)) {
            auto.queue.push({ kind: 'library', id, url: libUrl(id) });
          }
        }
      } else auto.lastError = job.id + ' 的好友列表未读到（可能设为私密或还没登录 Steam）';
    } else if (job.kind === 'badge') {
      /* 好友 Steam 徽章 / 等级：CDP_COLLECT_EXPR 只在有徽章时才带回来，
         这里补一次专用取数，0 枚徽章的档案也能刷新等级。 */
      let bg = (v.badges && v.badges.steamId64) ? v.badges : null;
      if (!bg) { try { bg = await cdpEvalValue(tabId, BADGE_EXPR, 10000); } catch {} }
      if (bg && bg.steamId64) {
        ingest(bg); auto.scanned.badges++; auto.lastError = '';
      } else auto.lastError = job.id + ' 的徽章页未读到（可能设为私密或还没登录 Steam）';
    } else if (job.kind === 'shop') {
      /* Steam 商店权威清单：同源 fetch /dynamicstore/userdata/，一次更新
         已购买游戏库 / 愿望单 / 购物车 / 隐藏清单，凭证不出浏览器。 */
      let st = null;
      try { st = await cdpEvalAsync(tabId, STORE_EXPR, 12000); } catch {}
      const domGames = job.shop === 'wishlist' && Array.isArray(v.games) ? v.games : [];
      const cartItems = job.shop === 'cart' && Array.isArray(v.cart) ? v.cart : [];
      const r = ingest({
        source: 'collector-cdp', url: v.url, page: String(v.page || ''),
        browser: debuggerEp?.browser || 'CDP',
        loggedIn: !!v.loggedIn, personaName: v.personaName || '', steamId64: v.steamId64 || '',
        /* 商店首页满屏是推荐位，绝不能把 DOM 的 a[href*="/app/"] 当成「我拥有的」 */
        games: domGames, owned: [],
        wishlist: job.shop === 'wishlist' ? domGames : [],
        cart: cartItems, cartSource: 'cart',
        cartConfirmedEmpty: job.shop === 'cart' && v.cartConfirmedEmpty === true,
        cartFilteredCount: Number(v.cartFilteredCount) || 0,
        hidden: [], store: st || v.store || null
      });
      auto.scanned.shop++;
      auto.lastShop = {
        at: Date.now(), page: job.shop,
        owned: Number(r?.storeOwned || 0),
        wishlist: Number(r?.totals?.wishlist || 0),
        cart: Number(r?.totals?.cart || 0)
      };
      auto.lastError = '';
    } else {
      /* 新版 Steam 的游戏库页把全部游戏都渲染成 /app/ 链接（每款 3 个），
         steamLensFofLibrary 已能一次取全并带上游戏名；旧版 ?xml=1 现在返回 HTML，已弃用。 */
      const libRes = v.fofLibrary;
      if (libRes && libRes.steamId64) {
        ingest(libRes); auto.scanned.library++; auto.lastError = '';
      } else auto.lastError = job.id + ' 的游戏库未读到（可能设为私密或还没登录 Steam）';
    }
    auto.done[job.kind + ':' + job.id] = Date.now();
    const kindName = job.kind === 'fof' ? '好友列表'
      : job.kind === 'badge' ? 'Steam 徽章'
        : job.kind === 'shop' ? 'Steam 商店' : '游戏库';
    auto.note = `已扫描 ${kindName} · ${job.id}`;
  } catch (e) {
    auto.lastError = String(e.message || e);
    auto.note = '自动扫描异常：' + auto.lastError;
  } finally { auto.running = false; }
}
function autoStatus() {
  /* 光有端口配置不算连上：以最近一次成功的 CDP 轮询为准，界面状态才不会骗人 */
  const connected = !!debuggerEp && Date.now() - Number(liveState.lastPoll || 0) < 15000;
  return {
    ok: true, enabled: auto.enabled, running: auto.running, connected,
    queued: auto.queue.length, cycles: auto.cycles, scanned: { ...auto.scanned },
    libraryCount: Object.keys(readFofLibStore()).length,
    badgeCount: Object.keys(readBadgeStore()).length,
    lastShop: auto.lastShop, lastShopAt: auto.lastShopAt,
    note: auto.note, lastError: auto.lastError, lastAt: auto.lastAt,
    hint: !auto.enabled ? '自动巡航已关闭'
      : (connected ? '自动巡航已开启：游戏库 / 愿望单 / 购物车 / 好友 / 徽章 / 朋友的朋友全部自动更新'
        : '未检测到浏览器调试接口，正在尝试自动打开（首次需登录一次 Steam）')
  };
}
function autoControl(p = {}) {
  if (typeof p.enabled === 'boolean') {
    auto.enabled = p.enabled;
    writeAutoEnabled(auto.enabled);   // 落盘，服务重启后开关不会被重置
    if (!auto.enabled) { auto.queue = []; auto.note = '自动巡航已关闭'; }
    else auto.lastAt = 0;             // 重新开启时立刻恢复巡航
  }
  if (p.rescan === true) { autoLastRebuild = 0; auto.queue = []; auto.lastAt = 0; }
  const kick = String(p.kick || '').trim();
  if (/^7656119\d{10}$/.test(kick)) {
    auto.queue = auto.queue.filter(j => !(j.kind === 'fof' && j.id === kick));
    auto.queue.unshift({ kind: 'fof', id: kick, url: fofUrl(kick) });
    auto.lastAt = 0;   // 下一秒立刻优先扫这位
  }
  const kickLib = String(p.kickLib || '').trim();
  if (/^7656119\d{10}$/.test(kickLib)) {
    auto.queue = auto.queue.filter(j => !(j.kind === 'library' && j.id === kickLib));
    auto.queue.unshift({ kind: 'library', id: kickLib, url: libUrl(kickLib) });
    auto.lastAt = 0;   // 立刻单独重扫某个人的游戏库
  }
  const kickBadge = String(p.kickBadge || '').trim();
  if (/^7656119\d{10}$/.test(kickBadge)) {
    auto.queue = auto.queue.filter(j => !(j.kind === 'badge' && j.id === kickBadge));
    auto.queue.unshift({ kind: 'badge', id: kickBadge, url: badgeUrl(kickBadge) });
    auto.lastAt = 0;   // 立刻单独重扫某个人的徽章 / 等级
  }
  return autoStatus();
}

async function injectCollectorToTab(targetId) {
  try { return await cdpEval(targetId, collectorScript()); } catch { return false; }
}

async function pollTargets() {
  restoreDebugEp();
  if (!debuggerEp) {
    const d = detectDevToolsPort();
    if (!d) { liveState.openTabs = []; liveState.detected = false; return; }
    debuggerEp = d; saveDebugEp();
  }
  const list = await httpGetJson(`http://${debuggerEp.host}:${debuggerEp.port}/json/list`);
  if (!Array.isArray(list)) { liveState.detected = false; liveState.openTabs = []; return; }
  const pages = list.filter(t => t.type === 'page');
  liveState.openTabs = pages.map(t => ({ id: t.id, url: t.url, title: (t.title || '').slice(0, 80) }));
  const allSteam = pages.filter(t => /steampowered\.com|steamcommunity\.com/i.test(t.url || ''));
  /* 自动巡航专用标签里是「别人的」好友/游戏库页：不注入采集器、不当成我的游戏库采，
     由 autoScanTick 自己主动取数落盘，避免污染快照。 */
  const steam = allSteam.filter(t => !/sl_scan=1/.test(t.url || ''));
  liveState.detected = allSteam.length > 0;
  liveState.lastPoll = Date.now();
  // 注入采集脚本（手动复制脚本之外的自动兜底；失败也照样有下面的服务端主动采集）
  for (const t of steam) {
    if (!liveState.injected[t.id]) {
      const ok = await injectCollectorToTab(t.id);
      if (ok) { liveState.injected[t.id] = Date.now(); liveState.injectOk = Number(liveState.injectOk || 0) + 1; }
      else liveState.injectFail = Number(liveState.injectFail || 0) + 1;
    }
  }
  // ★ 服务端主动采集：每 12 秒把 Steam 标签页的商店真值 + 页面清单直接取回落盘
  const now = Date.now();
  if (steam.length && !liveState.collectBusy && now - (liveState.lastCollectAt || 0) > 12000) {
    liveState.collectBusy = true;
    liveState.lastCollectAt = now;      // 先占位，失败也不至于每秒重试
    try { for (const t of steam.slice(0, 5)) await cdpCollect(t); }
    finally { liveState.collectBusy = false; }
  }
}

let cdpFirstStart = true;
function startCdpPolling() {
  restoreDebugEp();
  liveState.enabled = true;
  /* ★ 启动自愈：若上次是用「调试模式打开 Steam」启动的，服务重启后自动把浏览器再拉起来，
     浏览器扫描会继续跑，用户无需每次手动重新扫描。仅进程首次启动触发，避免重复拉起。 */
  if (cdpFirstStart && debuggerEp && debuggerEp.source === 'launched') {
    setTimeout(() => {
      httpGetJson(`http://${debuggerEp.host}:${debuggerEp.port}/json/version`)
        .then(v => { if (!v) { try { launchSteamDebug(); } catch (e) {} } })
        .catch(() => { try { launchSteamDebug(); } catch (e) {} });
    }, 1000);
  }
  cdpFirstStart = false;
  if (cdpTimer) return;
  pollTargets().catch(() => {});
  cdpTimer = setInterval(() => { pollTargets().catch(() => {}); }, 1000);
  try { cdpTimer.unref(); } catch { /* */ }
  /* 朋友的朋友自动巡航：自动打开好友列表页 / 游戏库页并回传，无需用户手动点按钮 */
  if (!autoScanTimer) {
    autoScanTimer = setInterval(() => { autoScanTick().catch(() => {}); }, 1000);
    try { autoScanTimer.unref(); } catch { /* */ }
  }
}

function launchSteamDebug() {
  const exe = findBrowserExe();
  if (!exe) return { ok: false, error: '未找到 Chrome / Edge，请先安装其一。' };
  const port = 9222;
  const profile = path.join(DATA_DIR, 'browser-debug-profile');
  try { fs.mkdirSync(profile, { recursive: true }); } catch { /* */ }
  const args = [
    `--remote-debugging-port=${port}`, '--user-data-dir=' + profile + '',
    '--no-first-run', '--no-default-browser-check',
    'https://store.steampowered.com/'
  ];
  try {
    const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
    child.unref();
    debuggerEp = { port, host: '127.0.0.1', browser: path.basename(exe), source: 'launched' };
    saveDebugEp();
    liveState.enabled = true;
    setTimeout(() => pollTargets().catch(() => {}), 1500);
    startCdpPolling();
    return { ok: true, port, browser: path.basename(exe), profile, note: '已用调试模式打开 Steam 商店，登录一次后 SteamLens 会自动识别并导入数据。' };
  } catch (e) { return { ok: false, error: e.message }; }
}

function attachDebug(port) {
  port = parseInt(port, 10) || 9222;
  debuggerEp = { port, host: '127.0.0.1', browser: 'manual', source: 'manual' };
  saveDebugEp();
  startCdpPolling();
  return { ok: true, port };
}

function detachDebug() {
  debuggerEp = null;
  saveDebugEp();
  liveState = {
    openTabs: [], detected: false, lastPoll: 0, injected: {},
    enabled: liveState.enabled, injectOk: 0, injectFail: 0, collectCount: 0,
    lastCollectAt: 0, lastCdpError: ''
  };
  return { ok: true };
}

/* ------------------------------ 采集脚本 ------------------------------ */
function collectorScript(rosterIds = []) {
  const port = Number(core.getConfig().port) || PORT_DEFAULT;
  const roster = (Array.isArray(rosterIds) ? rosterIds : [])
    .map(x => String(x)).filter(x => /^\d{17}$/.test(x)).slice(0, 200);
  return `(function(){
  if (window.__steamLensCollector) { console.log('SteamLens 采集器已在运行'); return; }
  window.__steamLensCollector = 1;
  var ENDPOINT = 'http://127.0.0.1:${port}/api/browser/ingest';
  var ROSTER_URL = 'http://127.0.0.1:${port}/api/browser/friend-ids';
  var ROSTER = ${JSON.stringify(roster)};
  var lastStoreData = null;
  var ticks = 0, lastSig = '', lastStore = 0, lastFriends = 0, lastRoster = 0, lastBadgeSig = '', lastFofSig = '', lastLibSig = '';
  ${CART_FN_SRC}
  ${BADGES_FN_SRC}
  ${FOF_FN_SRC}
  ${LIB_FN_SRC}

  function post(payload) {
    try {
      var b = new Blob([JSON.stringify(payload)], {type:'application/json'});
      if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, b)) return;
    } catch (e) {}
    try { fetch(ENDPOINT, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload), mode:'cors', keepalive:true}); } catch (e) {}
  }
  function collectGames() {
    var out = [], seen = {};
    var nodes = document.querySelectorAll('[data-ds-appid], .wishlist_row, .cart_item_row, .gameListRow, a[href*="/app/"]');
    for (var i=0;i<nodes.length && out.length<600;i++) {
      var n = nodes[i];
      var id = n.getAttribute && (n.getAttribute('data-ds-appid') || n.getAttribute('data-appid'));
      if (!id) { var m = (n.getAttribute('href')||'').match(/\\/app\\/(\\d+)/); if (m) id = m[1]; }
      if (!id || !/^\\d+$/.test(id) || seen[id]) continue;
      seen[id] = 1;
      var t = n.querySelector && (n.querySelector('.gameListRowItemName, .wishlist_row .title, .cart_item_desc, .name'));
      out.push({appid:String(id), name:(t && t.textContent || '').trim().slice(0,120)});
    }
    return out;
  }
  function readStore() {
    // Steam 商店自己的用户数据中心：登录会话同源可读，返回真正买过的 appid
    if (location.hostname.indexOf('steampowered.com') < 0) return;
    if (Date.now() - lastStore < 15000) return;
    lastStore = Date.now();
    fetch('/dynamicstore/userdata/', {credentials:'include'})
      .then(function(r){ return r.json(); })
      .then(function(j){
        if (!j) return;
        // 官方购物车清单留在页面内存里，供 steamLensCart() 每秒使用（任何 Steam 页面都能拿到）。
        // 用 Object.assign 合并而不是覆盖，避免把 CDP 通道写进来的 ownedApps / wishlist 抹掉。
        lastStoreData = Object.assign({}, window.__steamLensStore || {}, { cart: j.rgAppsInCart || [] });
        window.__steamLensStore = lastStoreData;
        post({
          ts: Date.now(), source:'collector-store', url: location.href, page:'dynamicstore',
          browser: navigator.userAgent.indexOf('Edg/')>=0 ? 'Edge' : 'Chrome',
          loggedIn: !!(j.rgOwnedApps && j.rgOwnedApps.length),
          store: {
            ownedApps: j.rgOwnedApps || [],
            wishlist: j.rgWishlist || [],
            cart: j.rgAppsInCart || [],
            hiddenApps: j.rgHiddenApps || []
          },
          steamId64: (location.pathname.match(/\\/profiles\\/(\\d{17})/)||[])[1] || ''
        });
        console.log('SteamLens: 已读取商店购买清单', (j.rgOwnedApps||[]).length, '款');
      })
      .catch(function(){});
  }

  /* ★ 好友在线状态：不需要 Steam Web API Key。
     在 steamcommunity.com 页面同源读取好友页 DOM 与个人资料 XML，
     只把「SteamID64 + 状态码 + 游戏名」发回本机，凭证不出浏览器。 */
  function stateCode(s, game) {
    s = String(s || '').toLowerCase();
    if (game || /in-game|ingame|游戏中|正在游戏/.test(s)) return 1;
    if (/busy|忙碌/.test(s)) return 2;
    if (/away|离开/.test(s)) return 3;
    if (/snooze|打盹/.test(s)) return 4;
    if (/looking to trade|想交易/.test(s)) return 5;
    if (/looking to play|想玩/.test(s)) return 6;
    if (/online|在线/.test(s)) return 1;
    if (/offline|离线|invisible|隐身/.test(s)) return 0;
    return -1;
  }
  function friendDom() {
    var out = [], seen = {};
    var nodes = document.querySelectorAll('[data-steamid], [data-miniprofile], .friendBlock, .friend_block_content, .friendlist_list_item, .friend');
    for (var i = 0; i < nodes.length && out.length < 200; i++) {
      var n = nodes[i];
      var id = n.getAttribute && (n.getAttribute('data-steamid') || n.getAttribute('data-miniprofile'));
      if (!id) {
        var a = n.querySelector && n.querySelector('a[href*="/profiles/"]');
        var m = a && (a.getAttribute('href') || '').match(/\\/profiles\\/(\\d{17})/);
        if (m) id = m[1];
      }
      if (!id || !/^\\d{17}$/.test(String(id)) || seen[id]) continue;
      var box = n.closest ? n.closest('.friendBlock, .friend_block_content, .friendlist_list_item, .friend, li, div') : n;
      var bcls = String((box && box.className) || '') + ' ' + String(n.className || '');
      var txt = String((box && box.textContent) || '').replace(/\\s+/g, ' ').slice(0, 240);
      var nmEl = (box && box.querySelector) ? box.querySelector('.persona_name, .friendBlockPersonaName, .friend_name, .name') : null;
      var nm = nmEl ? (nmEl.textContent || '').trim() : '';
      var gEl = (box && box.querySelector) ? box.querySelector('.friendBlockGameName, .friend_game_name, .game_name') : null;
      var game = gEl ? (gEl.textContent || '').trim() : '';
      var st = stateCode(bcls + ' ' + txt, game);
      // 好友页整块文本常同时出现「在线好友 / 离线」，明确的状态 class 优先
      var hasOffline = /(^|\\s)offline(\\s|$)/.test(bcls);
      var hasOnline = /(^|\\s)(online|in-game|ingame|away|busy)(\\s|$)/.test(bcls);
      if (hasOffline && !hasOnline && !game) st = 0;
      if (st < 0) continue;
      seen[id] = 1;
      out.push({ steamid: String(id), personaname: nm.slice(0, 80), personastate: st, gameextrainfo: game.slice(0, 120) });
    }
    return out;
  }
  function readRoster() {
    if (Date.now() - lastRoster < 60000) return;
    lastRoster = Date.now();
    fetch(ROSTER_URL, { mode: 'cors' })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.ids && j.ids.length) ROSTER = j.ids.slice(0, 200); })
      .catch(function () {});
  }
  function readFriends() {
    if (Date.now() - lastFriends < 20000) return;
    lastFriends = Date.now();
    var dom = friendDom();
    var ids = ROSTER.slice(0, 120);
    dom.forEach(function (f) { if (ids.indexOf(f.steamid) < 0) ids.push(f.steamid); });
    var isCommunity = location.hostname.indexOf('steamcommunity.com') >= 0;
    if (!isCommunity || !ids.length) {
      if (dom.length) post({ ts: Date.now(), source: 'collector-friends', url: location.href, friends: dom });
      return;
    }
    var results = [], idx = 0, flushed = false;
    function flush() {
      if (flushed) return;
      flushed = true;
      var merged = {};
      dom.forEach(function (f) { merged[f.steamid] = f; });
      results.forEach(function (f) { if (f) merged[f.steamid] = f; });
      var arr = Object.keys(merged).map(function (k) { return merged[k]; });
      if (arr.length) {
        post({ ts: Date.now(), source: 'collector-friends', url: location.href, friends: arr });
        console.log('SteamLens: 已同步好友在线状态', arr.length, '位');
      }
    }
    function next() {
      if (idx >= ids.length) { flush(); return; }
      var id = ids[idx++];
      fetch('/profiles/' + id + '/?xml=1', { credentials: 'include' })
        .then(function (r) { return r.text(); })
        .then(function (t) {
          try {
            var doc = new DOMParser().parseFromString(t, 'text/xml');
            function g(tag) { var e = doc.getElementsByTagName(tag)[0]; return e ? (e.textContent || '').trim() : ''; }
            var stTxt = g('onlineState');
            var msg = g('stateMessage').replace(/\\s+/g, ' ').trim();
            var name = g('steamID') || g('personaName');
            var game = '';
            var gm = msg.match(/(?:In-Game|游戏中)\\s*(.+)$/i);
            if (gm) game = gm[1].trim();
            else if (/in-game/i.test(stTxt) && msg) game = msg;
            var st = stateCode(stTxt, game);
            if (st >= 0) results.push({ steamid: id, personaname: name.slice(0, 80), personastate: st, gameextrainfo: game.slice(0, 120) });
          } catch (e) {}
        })
        .catch(function () {})
        .then(function () { setTimeout(next, 100); });
    }
    next();
    setTimeout(flush, 12000);
  }

  function tick() {
    ticks++;
    var path = location.pathname;
    var signIn = document.querySelector('#global_action_menu a[href*="login"], .global_action_link[href*="login"]');
    var nameEl = document.querySelector('.persona_name, #account_pulldown');
    var profiles = (location.href.match(/\\/profiles\\/(\\d{17})/)||[]);
    var isCartPage = /cart|checkout|shoppingcart/i.test(path);
    var games = collectGames();
    /* 购物车只走专用通道：官方清单 + 购物车容器内的行，绝不扫「为您推荐」 */
    var cartRes = steamLensCart({ path: path, store: lastStoreData });
    var payload = {
      ts: Date.now(), source:'collector', url: location.href, page: path,
      browser: navigator.userAgent.indexOf('Edg/')>=0 ? 'Edge' : (navigator.userAgent.indexOf('Chrome/')>=0 ? 'Chrome' : '浏览器'),
      loggedIn: !signIn,
      personaName: nameEl ? (nameEl.textContent||'').trim().slice(0,60) : '',
      steamId64: profiles[1] || '',
      games: games,
      owned: (/\\/games|\\/library|\\/account/i.test(path) ? games : []),
      wishlist: (/wishlist/i.test(path) ? games : []),
      cart: cartRes.items,
      cartSource: 'cart',
      cartConfirmedEmpty: !!(cartRes.confirmedEmpty && isCartPage),
      cartFilteredCount: cartRes.filtered,
      hidden: (/hidden/i.test(path) ? games : [])
    };
    var sig = JSON.stringify([path, payload.loggedIn,
      games.map(function(g){return g.appid;}).join(','),
      cartRes.items.map(function(g){return g.appid;}).join(','),
      payload.cartConfirmedEmpty, payload.steamId64]);
    // 页面变化立刻回传；即使完全没变化，每 5 秒也补一次完整数据
    if (sig !== lastSig || ticks % 5 === 1) { lastSig = sig; post(payload); }
    // ★ 每秒心跳：让面板的「实时同步」每秒都在更新，而不是等页面变化才有反应
    post({
      ts: Date.now(), source:'heartbeat', url: location.href, page: path,
      browser: payload.browser, loggedIn: payload.loggedIn, steamId64: payload.steamId64
    });
    if (ticks % 5 === 1) readStore();
    /* 停留在好友徽章页时，把这位好友的徽章回传本机；页面变化立刻回传，静止时每 5 秒补一次 */
    var badgeRes = steamLensBadges();
    if (badgeRes && badgeRes.badges) {
      var bsig = badgeRes.steamId64 + '|' + badgeRes.badges.map(function(b){ return b.name + '/' + b.level; }).join(',');
      if (bsig !== lastBadgeSig || ticks % 5 === 1) { lastBadgeSig = bsig; post(badgeRes); }
    }
    /* 停留在这位好友的 /friends 页面时，把他的好友（也就是朋友的朋友）回传本机 */
    var fofRes = steamLensFof();
    if (fofRes && fofRes.steamId64) {
      var fsig = fofRes.steamId64 + '|' + fofRes.people.length + '|' + fofRes.people.slice(0, 8).map(function(p){ return p.steamId64; }).join(',');
      if (fsig !== lastFofSig || ticks % 5 === 1) { lastFofSig = fsig; post(fofRes); }
    }
    /* 停在 /profiles/<id>/games 页时，把这位的游戏库也回传（自动巡航标签由服务端主动采集，这里是双保险） */
    var fofLibRes = steamLensFofLibrary();
    if (fofLibRes && fofLibRes.steamId64) {
      var lsig = fofLibRes.steamId64 + '|' + fofLibRes.games.length + '|' + fofLibRes.games.slice(0, 5).map(function(g){ return g.appid; }).join(',');
      if (lsig !== lastLibSig || ticks % 5 === 1) { lastLibSig = lsig; post(fofLibRes); }
    }
    readRoster();
    readFriends();
  }
  tick();
  setInterval(tick, 1000);
  console.log('SteamLens 采集器已启动：每秒心跳 + 页面变化时回传清单。购物车只认购物车项，「为您推荐」等推荐位一律排除。');
  console.log('好友在线：在 steamcommunity.com（好友页或任意社区页面）运行本脚本，无需 API Key 即可每 20 秒同步好友在线状态。');
  console.log('Steam 徽章：打开 steamcommunity.com/profiles/<好友SteamID64>/badges，本脚本会自动把徽章与等级回传本机。');
  console.log('朋友的朋友：打开 steamcommunity.com/profiles/<好友SteamID64>/friends，本脚本会自动把他的好友名单回传本机（需已登录）。');
  console.log('保持此页面打开即可，凭证不会离开浏览器。');
})();`;
}

module.exports = {
  ingest, status, clear, setFriendCode, collectorScript, snapshot,
  getBadges, saveBadges, saveFof, fofStatus,
  getFofLibrary, saveFofLibrary, autoStatus, autoControl,
  CART_FN_SRC, BADGES_FN_SRC, FOF_FN_SRC, LIB_FN_SRC, CDP_COLLECT_EXPR,
  toFriendCode, accountTo64, detectBrowsers,
  saveFriendStates, friendStates, cleanFriendStates,
  startCdpPolling, launchSteamDebug, attachDebug, detachDebug, pollTargets, openBadgeTab, openSteamTab,
  repairTruthFromBrowser
};
