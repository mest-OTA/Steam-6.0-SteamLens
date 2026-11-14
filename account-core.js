/**
 * SteamLens · Steam 账号连接与「真实游戏库」（零第三方依赖）
 *
 * 安全边界（重要）：
 *   Steam 没有开放给第三方本地应用的 OAuth 登录，网页登录还带有 Steam Guard
 *   邮箱验证码与 reCAPTCHA。因此本模块【绝不接收、绝不保存 Steam 账号密码】。
 *   「连接」= 用户自己在 Steam 官网登录并领取只读 Web API Key，
 *   我们只保存 SteamID64 + Key（或用户粘贴的 API 返回 JSON）。
 *   GetOwnedGames 天然只包含【当前真正拥有】的游戏：
 *     · 已退款的游戏会从该列表消失
 *     · 愿望单里的游戏不会出现
 *   再与本机 localconfig.vdf 的历史记录交叉比对，即可标出「疑似已退款 / 已移除」。
 *
 * 数据流：Steam 官网登录 → 领 Key → 本模块读取（只读）→ 全部落盘到本机 data/。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const TRUTH_FILE = path.join(DATA_DIR, 'library-truth.json');

const ACCOUNT_BASE = 76561197960265728n;
const API = 'https://api.steampowered.com';
const STORE = 'https://store.steampowered.com';
const API_KEY_PAGE = 'https://steamcommunity.com/dev/apikey';

/* ------------------------------ 基础 IO ------------------------------ */

function readJson(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
}
function writeJson(f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(obj, null, 2), 'utf8');
}
function getConfig() { return readJson(CONFIG_FILE, {}); }
function exists(f) { try { return fs.statSync(f).isFile(); } catch { return false; } }

const EMPTY = {
  connected: false, steamId64: '', profile: null, lastSync: 0, lastSyncIso: '',
  source: '', owned: [], wishlist: [], refunded: [], reinstated: [],
  warnings: []
};
function getTruth() { return Object.assign({}, EMPTY, readJson(TRUTH_FILE, {})); }
function saveTruth(patch) {
  const next = Object.assign(getTruth(), patch, { updatedAt: Date.now() });
  writeJson(TRUTH_FILE, next);
  return next;
}

/**
 * 写入 Steam 商店 /dynamicstore/userdata/ 的权威清单。
 * rgOwnedApps = 当前真正买过且未退款的游戏（比本机 appmanifest / 时长记录更准）。
 * 只在确实拿到非空 owned 列表时覆盖，避免未登录时把库清空。
 * 手动标记的退款 / 恢复记录始终保留。
 */
function applyStoreTruth({ owned = [], wishlist = [], cart = [], steamId64 = '', source = '' } = {}) {
  const t = getTruth();
  const ids = [...new Set((owned || []).map(String))].filter(x => /^\d{1,12}$/.test(x));
  if (!ids.length) return { ok: false, reason: '商店未返回已购买清单（可能未登录）', truth: t };

  const oldByName = new Map((t.owned || []).map(g => [String(g.appid), g.name || '']));
  const oldByAppid = new Map((t.owned || []).map(g => [String(g.appid), g]));
  const ownedList = ids.map(id => {
    const prev = oldByAppid.get(id) || {};
    return {
      appid: id,
      name: prev.name || oldByName.get(id) || '',
      playtime: Number(prev.playtime || 0),
      playtime2wks: Number(prev.playtime2wks || 0),
      icon: prev.icon || '',
      source: 'steam-store-userdata'
    };
  });
  const wishIds = [...new Set((wishlist || []).map(String))].filter(x => /^\d{1,12}$/.test(x));
  const wishList = wishIds.map(id => ({ appid: id, name: ((t.wishlist || []).find(w => String(w.appid) === id) || {}).name || '' }));
  const cartIds = [...new Set((cart || []).map(String))].filter(x => /^\d{1,12}$/.test(x));

  const next = saveTruth({
    connected: true,
    steamId64: steamId64 || t.steamId64 || '',
    source: source || 'Steam 商店 /dynamicstore/userdata/',
    lastSync: Date.now(),
    lastSyncIso: new Date().toISOString(),
    owned: ownedList,
    wishlist: wishList,
    storeCart: cartIds,
    refunded: (t.refunded || []).filter(id => !ids.includes(String(id))),  // 商店说还拥有 → 撤销误标的退款
    warnings: []
  });
  return { ok: true, owned: ownedList.length, wishlist: wishList.length, cart: cartIds.length, truth: next };
}

/* ------------------------------ ID 解析 ------------------------------ */

function parseSteamId(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  const mProfiles = s.match(/steamcommunity\.com\/profiles\/(\d{17})/i) || s.match(/^\/?profiles\/(\d{17})/i);
  if (mProfiles) return mProfiles[1];
  if (/^7656119\d{10}$/.test(s)) return s;
  const mSteam = s.match(/^STEAM_[0-5]:([01]):(\d+)$/i);
  if (mSteam) {
    try {
      const acc = BigInt(mSteam[2]) * 2n + BigInt(mSteam[1]);
      return (ACCOUNT_BASE + acc).toString();
    } catch {}
  }
  return '';
}
function isVanity(s) { return /steamcommunity\.com\/id\/|\/id\//i.test(String(s || '')); }

/* ------------------------------ 网络（Node fetch + PowerShell 回退） ---- */

async function fetchJson(url, timeoutMs = 22000) {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'SteamLens/1.0 (local, read-only)' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (primaryErr) {
    // 回退：Windows 自带 PowerShell 的 WinHTTP 栈，某些网络环境下更稳
    if (process.platform !== 'win32') throw primaryErr;
    return new Promise((resolve, reject) => {
      const ps = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; `
        + `$ErrorActionPreference='Stop'; `
        + `$r=Invoke-WebRequest -UseBasicParsing -Uri '${url.replace(/'/g, '%27')}' -TimeoutSec 25; `
        + `Write-Output $r.Content`;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { timeout: 32000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (err, so, se) => {
          if (err) return reject(new Error(`${primaryErr.message} / PowerShell 回退失败: ${err.message}`));
          try { resolve(JSON.parse(String(so).trim())); }
          catch (e) { reject(new Error(`PowerShell 返回非 JSON：${String(so).slice(0, 120)}`)); }
        });
    });
  }
}

function ownedUrl(key, id) {
  return `${API}/IPlayerService/GetOwnedGames/v0001/?key=${encodeURIComponent(key)}`
    + `&steamid=${encodeURIComponent(id)}&include_appinfo=1&include_played_free_games=1&format=json`;
}
function summariesUrl(key, id) {
  return `${API}/ISteamUser/GetPlayerSummaries/v0002/?key=${encodeURIComponent(key)}&steamids=${encodeURIComponent(id)}`;
}
function vanityUrl(key, vanity) {
  return `${API}/ISteamUser/ResolveVanityURL/v0001/?key=${encodeURIComponent(key)}&vanityurl=${encodeURIComponent(vanity)}`;
}
function wishlistUrl(id, page = 0) {
  return `${STORE}/wishlist/profiles/${id}/wishlistdata/?p=${page}&cc=cn&l=schinese`;
}

function parseOwned(text) {
  if (!text || !String(text).trim()) return [];
  const j = JSON.parse(String(text));
  const arr = j?.response?.games || j?.games || (Array.isArray(j) ? j : null);
  if (!Array.isArray(arr)) throw new Error('JSON 里找不到 response.games');
  return arr.map(g => ({
    appid: String(g.appid), name: String(g.name || ''),
    playtime: Number(g.playtime_forever || 0),
    playtime2wks: Number(g.playtime_2weeks || 0),
    icon: String(g.img_icon_url || '')
  }));
}
function parseWishlist(text) {
  if (!text || !String(text).trim()) return [];
  const j = JSON.parse(String(text));
  const out = [];
  if (Array.isArray(j)) {
    for (const x of j) out.push({ appid: String(x.appid || x.id), name: String(x.name || '') });
  } else {
    for (const [id, v] of Object.entries(j)) {
      if (!/^\d+$/.test(id)) continue;
      out.push({ appid: id, name: String((v && (v.name || v.title)) || '') });
    }
  }
  return out;
}

/* ------------------------------ 连接 / 同步 ------------------------------ */

/**
 * 连接 Steam 只读授权并同步真实游戏库。
 * 支持三种输入：API Key 直连 / 粘贴 GetOwnedGames JSON / 只填 ID 拉愿望单。
 */
async function connect(opts = {}) {
  const warnings = [];
  const saved = getConfig();
  const prevTruth = getTruth();
  let id = parseSteamId(opts.steamId64 || opts.profileUrl || '') || prevTruth.steamId64 || '';
  // 留空 = 沿用本机已保存的凭证（永久登录，不必每次重填）
  const key = String(opts.apiKey ?? '').trim() || String(saved.apiKey || '').trim();
  const pastedOwned = String(opts.pastedOwnedGames ?? '').trim() || String(saved.pastedOwnedGames || '').trim();

  if (!id && isVanity(opts.steamId64 || opts.profileUrl)) {
    const vanity = String(opts.steamId64 || opts.profileUrl).match(/\/id\/([^/?#]+)/i)?.[1];
    if (vanity && key) {
      try {
        const j = await fetchJson(vanityUrl(key, vanity));
        if (j?.response?.steamid) id = String(j.response.steamid);
      } catch (e) { warnings.push(`个性链接解析失败：${e.message}`); }
    }
    if (!id) warnings.push('个性链接 /id/... 需要 API Key 才能解析，或改用 /profiles/7656119... 链接。');
  }
  if (!id) throw new Error('SteamID64 无效。请填 17 位 ID、/profiles/ 链接，或 STEAM_0:x:y 格式。');

  let owned = [], source = '', profile = null;

  // 优先用只读 Key 直连（登录式自动扫描），失败时才回退到粘贴 JSON
  if (key) {
    try {
      const j = await fetchJson(ownedUrl(key, id));
      const arr = j?.response?.games || [];
      owned = arr.map(g => ({
        appid: String(g.appid), name: String(g.name || ''),
        playtime: Number(g.playtime_forever || 0),
        playtime2wks: Number(g.playtime_2weeks || 0),
        icon: String(g.img_icon_url || '')
      }));
      source = 'api';
      if (!owned.length) warnings.push('GetOwnedGames 返回空：游戏库详情可能设为「仅自己可见/私密」，可改用粘贴 JSON。');
    } catch (e) {
      warnings.push(`Steam Web API 读取失败：${e.message}。可点「生成链接」在浏览器打开后把 JSON 粘贴回来。`);
    }
  }
  if (!owned.length && pastedOwned) {
    try { owned = parseOwned(pastedOwned); source = 'pasted'; }
    catch (e) { warnings.push(`粘贴的拥有列表解析失败：${e.message}`); }
  }
  /* ★ 这次没读到拥有清单（库设为私密 / API 失败 / 未登录）时，绝不能把上次
     已确认的购买清单抹成空数组，否则所有游戏会被判成「未验证」→ 库价值直接变 0。 */
  if (!owned.length && (prevTruth.owned || []).length) {
    owned = prevTruth.owned;
    warnings.push(`Steam 这次没返回拥有清单，沿用上次已保存的 ${owned.length} 款（避免库价值被清零）。`);
  }

  if (key) {
    try {
      const j = await fetchJson(summariesUrl(key, id));
      const p = j?.response?.players?.[0];
      if (p) profile = {
        personaname: String(p.personaname || ''), avatarfull: String(p.avatarfull || p.avatarmedium || ''),
        profileurl: String(p.profileurl || ''), PersonaState: Number(p.personastate || 0)
      };
    } catch { /* 头像昵称非关键 */ }
  }
  if (!profile && !key && !pastedOwned) {
    warnings.push('未填写 API Key：仍可从本机 loginusers.vdf 读取账号名，但无法获取在线头像。');
  }

  // 愿望单：优先用户粘贴，否则尝试商店公开接口（不需要 Key）
  let wishlist = [];
  const pastedWish = String(opts.pastedWishlist ?? '').trim();
  if (pastedWish) {
    try { wishlist = parseWishlist(pastedWish); }
    catch (e) { warnings.push(`愿望单 JSON 解析失败：${e.message}`); }
  } else {
    try {
      for (let p = 0; p < 5; p++) {
        const j = await fetchJson(wishlistUrl(id, p), 12000);
        const page = Object.entries(j || {}).filter(([k]) => /^\d+$/.test(k))
          .map(([k, v]) => ({ appid: k, name: String((v && (v.name || v.title)) || '') }));
        wishlist.push(...page);
        if (page.length < 50) break;
      }
      if (wishlist.length) source = source || 'wishlist';
    } catch { warnings.push('愿望单不可读（可能设为私密或网络受限）；可在下方粘贴 wishlistdata JSON 导入。'); }
  }
  // 网络没读到时保留上次的愿望单，避免一次超时把已导入的清单清空
  if (!wishlist.length && !pastedWish) wishlist = prevTruth.wishlist || [];

  const truth = prevTruth;
  const now = Date.now();
  const next = saveTruth({
    connected: owned.length > 0 || wishlist.length > 0,
    steamId64: id,
    profile: profile || truth.profile,
    lastSync: now, lastSyncIso: new Date(now).toISOString(),
    source: source || truth.source,
    owned,
    wishlist,
    refunded: truth.refunded || [],
    reinstated: truth.reinstated || [],
    warnings
  });

  // Key / ID 同时写回主配置，供好友系统与手动模式复用
  const cfg = getConfig();
  const patch = { steamId64: id };
  if (key) patch.apiKey = key;
  if (pastedOwned) patch.pastedOwnedGames = pastedOwned;
  Object.assign(cfg, patch);
  writeJson(CONFIG_FILE, cfg);

  return { ok: true, truth: publicView(next), warnings, message: summarize(next) };
}

async function sync() {
  const t = getTruth();
  const cfg = getConfig();
  if (!t.steamId64) throw new Error('尚未连接 Steam 账号');
  return connect({
    steamId64: t.steamId64,
    apiKey: cfg.apiKey || '',
    pastedWishlist: ''
  });
}

function disconnect() {
  const t = getTruth();
  return saveTruth({
    connected: false, profile: null, owned: [], wishlist: [],
    source: '', lastSync: 0, lastSyncIso: '', warnings: [],
    refunded: t.refunded || [], reinstated: t.reinstated || []
  });
}

function markRefund(appid, on) {
  const t = getTruth();
  const id = String(appid);
  const set = new Set(t.refunded || []);
  const rein = new Set(t.reinstated || []);
  if (on) { set.add(id); rein.delete(id); } else set.delete(id);
  return saveTruth({ refunded: [...set], reinstated: [...rein] });
}
function markReinstated(appid, on) {
  const t = getTruth();
  const id = String(appid);
  const set = new Set(t.reinstated || []);
  const ref = new Set(t.refunded || []);
  if (on) { set.add(id); ref.delete(id); } else set.delete(id);
  return saveTruth({ refunded: [...ref], reinstated: [...set] });
}
function setWishlistFromJson(text) {
  const list = parseWishlist(text);
  return saveTruth({ wishlist: list });
}
function clearTruth() { return saveTruth({ ...EMPTY }); }

/* ------------------------------ 供数据内核使用的视图 ------------------------------ */

function publicView(t = getTruth()) {
  return {
    connected: !!t.connected,
    steamId64: t.steamId64 || '',
    profile: t.profile || null,
    lastSync: t.lastSync || 0,
    lastSyncIso: t.lastSyncIso || '',
    source: t.source || '',
    ownedCount: (t.owned || []).length,
    wishlistCount: (t.wishlist || []).length,
    refundedCount: (t.refunded || []).length,
    reinstatedCount: (t.reinstated || []).length,
    warnings: t.warnings || []
  };
}

/** 生成 appid → 所有权标签 的映射，供 buildGames 使用 */
function ownershipMap() {
  const t = getTruth();
  const owned = new Set((t.owned || []).map(x => String(x.appid)));
  const wish = new Set((t.wishlist || []).map(x => String(x.appid)));
  const refunded = new Set((t.refunded || []).map(String));
  const reinstated = new Set((t.reinstated || []).map(String));
  const timeline = new Map();
  for (const g of (t.owned || [])) timeline.set(String(g.appid), g);
  /* connected 只代表「连过账号」；hasOwnedList 才代表真的有一份权威购买清单。
     没有清单时不能拿它去否定本机游戏记录，否则库价值会全被判成未验证而显示 0。 */
  return { connected: !!t.connected, hasOwnedList: owned.size > 0, owned, wish, refunded, reinstated, timeline, truth: t };
}

/**
 * 单个游戏的所有权分类：
 *   owned      官方接口确认当前拥有 → 计入价值
 *   wishlist   愿望单 → 不计入价值
 *   refunded   手动确认已退款 → 不计入价值
 *   unverified 本地有记录、账号里没有 → 疑似已退款 / 家庭共享 / 免费周末 / 试玩版 → 默认不计入价值
 */
function classify(appid, map) {
  const id = String(appid);
  if (map.refunded.has(id)) return 'refunded';
  if (map.reinstated.has(id)) return 'owned';
  if (map.owned.has(id)) return 'owned';
  if (map.wish.has(id)) return 'wishlist';
  return map.connected ? 'unverified' : 'unverified';
}

const OWNERSHIP_LABEL = {
  owned: '已拥有（官方确认）',
  wishlist: '愿望单（未购买）',
  refunded: '已退款 / 已移除',
  unverified: '未验证（本地历史记录）'
};

function summarize(t = getTruth()) {
  return `拥有 ${t.owned?.length || 0} 款 · 愿望单 ${t.wishlist?.length || 0} 款 · 已标记退款 ${t.refunded?.length || 0} 款`;
}

module.exports = {
  connect, sync, disconnect, markRefund, markReinstated, setWishlistFromJson, clearTruth,
  getTruth, saveTruth, applyStoreTruth, publicView, ownershipMap, classify, summarize,
  parseSteamId, parseOwned, parseWishlist, getConfig,
  ownedUrl, wishlistUrl, API_KEY_PAGE, OWNERSHIP_LABEL
};
