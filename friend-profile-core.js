/**
 * SteamLens · 好友档案（游戏时长 / 账号价值 / 上线记录）
 *
 * 用户诉求：在「好友上线」里给每个好友建一份档案，打开 Steam 官方接口找到这个好友，
 *          把他的游戏库、各游戏时长、总时长、账号库价值一起算出来并保存。
 *
 * 数据来源（只读、合规）：
 *  1. IPlayerService/GetOwnedGames/v1  → 好友公开的已拥有游戏 + playtime_forever（分钟）
 *  2. ISteamUser/GetPlayerSummaries/v2 → 昵称 / 头像 / 当前状态
 *  3. 本机 data/prices.json 商店标价缓存 → 估算该好友的库价值
 *  4. friends-core 的上线动态 / 在线统计 → 合并成「上线记录」
 *
 * 边界：好友把游戏库设为私密时 Steam 官方接口会拒绝，界面给出明确提示；
 *       没有 API Key 时支持粘贴 GetOwnedGames 的 JSON 手动导入一次。
 *       所有档案只写入本机 data/friend-profiles.json，不上传。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const core = require('./steam-core');
const friends = require('./friends-core');
const friendLibrary = require('./friend-library-core');
const steamClient = require('./steam-client-core');

const DIR = path.join(__dirname, 'data');
const FILE = path.join(DIR, 'friend-profiles.json');
const CACHE_TTL = 6 * 3600 * 1000;

function atomicWrite(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  try { fs.renameSync(tmp, file); }
  catch { fs.copyFileSync(tmp, file); try { fs.unlinkSync(tmp); } catch {} }
}
function readAll() {
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return j && typeof j === 'object' ? j : {}; }
  catch { return {}; }
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

const OWNED_URL = (key, id) => `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${encodeURIComponent(key)}`
  + `&steamid=${encodeURIComponent(id)}&include_appinfo=1&include_played_free_games=1&format=json`;
const SUMMARY_URL = (key, id) => `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${encodeURIComponent(key)}`
  + `&steamids=${encodeURIComponent(id)}`;

function parsePasted(text) {
  const j = JSON.parse(String(text));
  const games = j?.response?.games || j?.games || (Array.isArray(j) ? j : null);
  if (!Array.isArray(games)) throw new Error('JSON 里找不到 response.games（这是 GetOwnedGames 的返回）');
  return games;
}

/** 把 GetOwnedGames 的原始条目整理成档案游戏列表，并叠加本机价格缓存 */
function buildGames(raw) {
  const prices = core.getPriceCache();
  const games = [];
  for (const g of raw) {
    const id = String(g.appid ?? g.app_id ?? g.id ?? '');
    if (!/^\d+$/.test(id)) continue;
    const min = num(g.playtime_forever ?? g.playtimeForever);
    const p = prices[id];
    const cents = p && !p.unavailable && !p.isFree ? num(p.finalCents || p.initialCents) : null;
    games.push({
      appid: id,
      name: String(g.name || g.appname || p?.name || `App ${id}`).slice(0, 160),
      playtimeMin: min,
      playtimeHours: Math.round(min / 60 * 10) / 10,
      playtime2wksMin: num(g.playtime_2weeks),
      imgIconUrl: String(g.img_icon_url || ''),
      priceCents: cents,
      priceKnown: !!(p && !p.networkError),
      priceName: p?.name || ''
    });
  }
  games.sort((a, b) => b.playtimeMin - a.playtimeMin);
  return games;
}

function summarize(raw, meta = {}) {
  const games = buildGames(raw);
  const totalMin = games.reduce((s, g) => s + g.playtimeMin, 0);
  const valued = games.filter(g => g.priceCents > 0);
  const valueCents = valued.reduce((s, g) => s + g.priceCents, 0);
  const pricedCount = games.filter(g => g.priceKnown).length;
  return {
    ok: true,
    steamId64: meta.steamId64 || '',
    name: meta.name || '',
    avatar: meta.avatar || '',
    profileUrl: meta.profileUrl || `https://steamcommunity.com/profiles/${meta.steamId64 || ''}`,
    stateLabel: meta.stateLabel || '',
    fetchedAt: Date.now(),
    fetchedAtIso: new Date().toISOString(),
    source: meta.source || 'Steam Web API · GetOwnedGames',
    totals: {
      games: games.length,
      totalMinutes: totalMin,
      totalHours: Math.round(totalMin / 60 * 10) / 10,
      playedGames: games.filter(g => g.playtimeMin > 0).length,
      valueCents,
      valueYuan: Math.round(valueCents / 100 * 100) / 100,
      pricedCount,
      unpricedCount: games.length - pricedCount,
      freeGames: games.filter(g => g.priceKnown && g.priceCents === null).length,
      avgHoursPerGame: games.length ? Math.round(totalMin / 60 / games.length * 10) / 10 : 0
    },
    games: games.slice(0, 400),
    topGames: games.slice(0, 10),
    valueNote: pricedCount < games.length
      ? `已按商店标价估算 ${pricedCount}/${games.length} 款；其余缺少价格缓存，可在「库价值」页刷新价格后再回来看。`
      : '已按 Steam 商店标价（本机缓存）估算全部游戏。',
    privacyNote: '好友若把游戏库设为「私密」，Steam 官方接口不会返回数据，这是正常限制。'
  };
}

/** 合并本机已记录的上线动态与在线统计 */
function withHistory(profile) {
  const id = String(profile.steamId64);
  const events = friends.loadEvents().filter(e => String(e.steamId64) === id).slice(-20).reverse();
  const stats = friends.loadStats();
  let onlineMinutes = 0, logins = 0, days = 0;
  for (const [, dayMap] of Object.entries(stats || {})) {
    const r = dayMap && dayMap[id];
    if (r) { onlineMinutes += num(r.onlineMinutes); logins += num(r.logins); days++; }
  }
  profile.history = {
    events: events.map(e => ({ iso: e.iso, text: e.text, type: e.type, game: e.game || '' })),
    onlineMinutes: Math.round(onlineMinutes * 10) / 10,
    logins, trackedDays: days,
    eventCount: events.length
  };
  return profile;
}

/* ------------------------------------------------------------------ */
/* 每秒视图：Steam 客户端库中游戏 + 已存官方档案 + 实时上线状态          */
/* ------------------------------------------------------------------ */

const STATE_TEXT = { 0: '离线', 1: '在线', 2: '忙碌', 3: '离开', 4: '打盹', 5: '想交易', 6: '想玩游戏' };

/** 合并「Steam 客户端直读的库中游戏」与「官方接口已存档案」 */
function mergeGames(lib, cached) {
  const byId = new Map();
  const hasApi = !!(cached && (cached.games || []).length);
  for (const g of (cached?.games || [])) {
    if (!g || !g.appid) continue;
    const id = String(g.appid);
    byId.set(id, {
      appid: id,
      name: String(g.name || `App ${id}`),
      icon: g.imgIconUrl ? `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${id}/${g.imgIconUrl}.jpg` : '',
      playtimeMin: num(g.playtimeMin),
      playtime2wksMin: num(g.playtime2wksMin),
      priceCents: Number.isFinite(Number(g.priceCents)) ? Number(g.priceCents) : null,
      priceKnown: !!g.priceKnown,
      playtimeKnown: true,
      fromClient: false
    });
  }
  for (const g of (lib?.games || [])) {
    if (!g || !g.appid) continue;
    const id = String(g.appid);
    const old = byId.get(id) || {};
    byId.set(id, {
      appid: id,
      name: (g.nameKnown ? g.name : '') || old.name || `App ${id}`,
      icon: g.iconUrl || old.icon || '',
      playtimeMin: old.playtimeMin || 0,
      playtime2wksMin: old.playtime2wksMin || 0,
      priceCents: g.priceCents ?? old.priceCents ?? null,
      priceKnown: !!(g.priceKnown || old.priceKnown),
      playtimeKnown: !!old.playtimeKnown || false,
      fromClient: true
    });
  }
  const games = [...byId.values()].map(g => ({
    ...g,
    playtimeHours: Math.round((g.playtimeMin || 0) / 60 * 10) / 10
  })).sort((a, b) => (b.playtimeMin || 0) - (a.playtimeMin || 0) || a.name.localeCompare(b.name, 'zh-CN'));
  return { games, hasApi };
}

/**
 * 轻量「每秒」档案：完全读本机，不联网、不写盘，前端可以每秒调用。
 * 游戏库来自 Steam 客户端直读（每秒刷新），时长来自官方档案，状态来自好友实时轮询。
 */
function live(steamId64) {
  const id = String(steamId64 || '').replace(/[^\d]/g, '');
  if (!/^\d{15,20}$/.test(id)) return { ok: false, reason: '需要有效的好友 SteamID64（17 位数字）' };
  const all = readAll();
  const cached = all[id];
  const lib = friendLibrary.library(id);
  const sc = steamClient.readStates();
  const sf = (sc?.friends || []).find(f => String(f.steamid) === id);
  const roster = friends.scanLocalFriends().find(f => f.steamId64 === id);

  const personastate = sf ? Number(sf.personastate) : null;
  const stateLabel = personastate === null ? '' : (STATE_TEXT[personastate] || '');
  const { games, hasApi } = mergeGames(lib, cached);
  let currentGame = sf?.gameextrainfo || '';
  if (lib?.playingAppId) {
    const hit = games.find(g => g.appid === String(lib.playingAppId));
    if (hit) currentGame = hit.name;
  }
  const lastGame = currentGame;
  // 离线时「最近在玩」不等于「正在玩」，避免面板显示自相矛盾的状态
  if (personastate === 0) currentGame = '';
  const name = cached?.name || lib?.name || sf?.personaname || roster?.name || `Steam ${id.slice(-6)}`;
  const avatar = cached?.avatar || lib?.avatar || sf?.avatarfull || '';

  const totalMin = games.reduce((s, g) => s + (g.playtimeMin || 0), 0);
  const valued = games.filter(g => g.priceCents > 0);
  const valueCents = valued.reduce((s, g) => s + g.priceCents, 0);
  const pricedCount = games.filter(g => g.priceKnown).length;
  const libSyncAt = lib?.fetchedAt || 0;

  if (!games.length) {
    return {
      ok: false, live: true, steamId64: id, name, avatar, stateLabel, personastate,
      servedAt: Date.now(), servedAtIso: new Date().toISOString(), pollIntervalSec: 1,
      totals: { games: 0, totalMinutes: 0, totalHours: 0, playedGames: 0, valueCents: 0, valueYuan: 0, pricedCount: 0, unpricedCount: 0, freeGames: 0, avgHoursPerGame: 0 },
      games: [], topGames: [], history: withHistory({ steamId64: id }).history,
      reason: '还没读到这位好友的库中游戏。请保持 Steam 客户端与「好友与聊天」窗口开着；若他的游戏库设为私密，可粘贴他自己的 GetOwnedGames JSON。',
      source: '', libraryCount: 0
    };
  }

  const warning = !hasApi
    ? '库中游戏与标价来自 Steam 客户端本机直读（每秒更新）；各游戏时长需要 Steam Web API Key 或粘贴 GetOwnedGames JSON 才能显示，当前以「—」表示。'
    : (lib ? '' : 'Steam 客户端当前没读到库中游戏，显示上次保存的官方档案。');

  return {
    ok: true, live: true,
    steamId64: id, name, avatar,
    profileUrl: cached?.profileUrl || `https://steamcommunity.com/profiles/${id}`,
    stateLabel, personastate, currentGame, lastGame,
    servedAt: Date.now(), servedAtIso: new Date().toISOString(), pollIntervalSec: 1,
    secondsSinceSync: libSyncAt ? Math.max(0, Math.round((Date.now() - libSyncAt) / 1000)) : null,
    fetchedAt: libSyncAt || cached?.fetchedAt || 0,
    fetchedAtIso: lib?.fetchedAtIso || cached?.fetchedAtIso || '',
    source: lib ? lib.source : (cached?.source || '本机已存档案'),
    librarySource: 'Steam 客户端好友列表 / 游戏库缓存',
    libraryCount: lib ? (lib.appids || []).length : 0,
    hasApiProfile: hasApi,
    fromCache: !lib,
    totals: {
      games: games.length,
      totalMinutes: totalMin,
      totalHours: Math.round(totalMin / 60 * 10) / 10,
      playedGames: games.filter(g => g.playtimeMin > 0).length,
      valueCents,
      valueYuan: Math.round(valueCents / 100 * 100) / 100,
      pricedCount,
      unpricedCount: games.length - pricedCount,
      freeGames: games.filter(g => g.priceKnown && g.priceCents === null).length,
      avgHoursPerGame: games.length ? Math.round(totalMin / 60 / games.length * 10) / 10 : 0,
      timedGames: games.filter(g => g.playtimeKnown).length
    },
    games,
    topGames: games.slice(0, 10),
    history: withHistory({ steamId64: id }).history,
    valueNote: pricedCount < games.length
      ? `已按商店标价估算 ${pricedCount}/${games.length} 款；其余缺少价格缓存。`
      : '已按 Steam 商店标价（本机缓存）估算全部游戏。',
    privacyNote: '好友若把游戏库设为「私密」，Steam 官方接口不会返回数据，这是正常限制。',
    warning,
    note: '页面每秒自动刷新一次；库中游戏由 Steam 客户端本机直读，不联网、不需要 API Key。'
  };
}

async function profile(steamId64, opts = {}) {
  const id = String(steamId64 || '').replace(/[^\d]/g, '');
  if (!/^\d{15,20}$/.test(id)) throw new Error('需要有效的好友 SteamID64（17 位数字）或好友码');
  const all = readAll();
  const cached = all[id];
  if (!opts.refresh && cached && Date.now() - num(cached.fetchedAt) < CACHE_TTL) {
    return { ...withHistory(cached), fromCache: true, cachedAtIso: cached.fetchedAtIso };
  }

  const c = core.getConfig();
  const key = String(c.apiKey || '').trim();
  let raw = null, source = 'Steam Web API · GetOwnedGames';
  if (opts.pasted) {
    raw = parsePasted(opts.pasted);
    source = '手动粘贴 GetOwnedGames JSON';
  } else if (!key) {
    // 没有 API Key 也能生成档案：直接用 Steam 客户端本机直读到的库中游戏
    const lv = live(id);
    if (lv.ok && lv.games.length) {
      const built = {
        ok: true, steamId64: id, name: lv.name, avatar: lv.avatar,
        profileUrl: lv.profileUrl, stateLabel: lv.stateLabel,
        fetchedAt: Date.now(), fetchedAtIso: new Date().toISOString(),
        source: lv.source || 'Steam 客户端好友游戏库（本机直读）',
        totals: lv.totals, games: lv.games, topGames: lv.topGames,
        valueNote: lv.valueNote, privacyNote: lv.privacyNote,
        history: lv.history, libraryOnly: true
      };
      all[id] = built;
      atomicWrite(FILE, all);
      return { ...built, fromCache: false, warning: lv.warning };
    }
    if (cached) return { ...withHistory(cached), fromCache: true, stale: true, warning: '未配置 Steam Web API Key，显示上次保存的档案。可粘贴 GetOwnedGames JSON 手动更新。' };
    throw new Error('还没读到这位好友的库中游戏：请保持 Steam 客户端与「好友与聊天」窗口开着；也可以填入 Steam Web API Key 或粘贴该好友的 GetOwnedGames JSON。');
  } else {
    try { raw = (await core.fetchJson(OWNED_URL(key, id), 22000))?.response?.games || null; }
    catch (e) {
      if (cached) return { ...withHistory(cached), fromCache: true, stale: true, warning: `Steam 接口本次未响应（${e.message}），显示上次档案。` };
      throw new Error(`读取好友游戏库失败：${e.message}（好友资料设为私密时也会这样）`);
    }
    if (!raw) {
      return {
        ok: false, steamId64: id, private: true,
        name: '', totals: { games: 0, totalMinutes: 0, totalHours: 0, valueCents: 0, valueYuan: 0 },
        games: [], topGames: [], history: { events: [], onlineMinutes: 0, logins: 0, trackedDays: 0, eventCount: 0 },
        reason: 'Steam 没有返回这个好友的游戏库：多半是他把「游戏详情」设成了私密/仅好友可见。可以让他临时公开，或粘贴他自己的 GetOwnedGames JSON。'
      };
    }
  }

  // 补齐缺失的商店标价（限量、并发、硬超时），让「账号库价值」尽量算全
  let pricedNew = 0;
  if (!opts.pasted) {
    const prices = core.getPriceCache();
    const missing = [...new Set(raw.map(g => String(g.appid ?? g.app_id ?? g.id ?? '')))]
      .filter(x => /^\d+$/.test(x) && !core.priceFresh(prices[x])).slice(0, 24);
    if (missing.length) {
      try {
        const before = Object.keys(core.getPriceCache()).length;
        await core.estimatePrices(missing, null, { concurrency: 4, timeoutMs: 6000, maxDurationMs: 22000 });
        pricedNew = Object.keys(core.getPriceCache()).length - before;
      } catch { /* 网络不通就用已有缓存 */ }
    }
  }

  // 昵称 / 头像 / 当前状态：失败不影响档案
  let meta = { steamId64: id, source };
  try {
    if (key) {
      const j = await core.fetchJson(SUMMARY_URL(key, id), 15000);
      const p = j?.response?.players?.[0];
      if (p) meta = {
        ...meta,
        name: String(p.personaname || ''),
        avatar: String(p.avatarfull || p.avatarmedium || ''),
        profileUrl: String(p.profileurl || meta.profileUrl),
        stateLabel: { 0: '离线', 1: '在线', 2: '忙碌', 3: '离开', 4: '打盹', 5: '想交易', 6: '想玩游戏' }[num(p.personastate)] || ''
      };
    }
  } catch {}
  if (!meta.name) {
    const local = friends.scanLocalFriends().find(f => f.steamId64 === id);
    meta.name = local?.name || `Steam ${id.slice(-6)}`;
  }

  const built = withHistory(summarize(raw, meta));
  built.pricedNew = pricedNew;
  all[id] = built;
  atomicWrite(FILE, all);
  return { ...built, fromCache: false };
}

/** 批量给好友列表补一份摘要（不联网，只读已保存档案 + 客户端库中游戏） */
function attachToList(list) {
  const all = readAll();
  const libMap = new Map((friendLibrary.list().profiles || []).map(p => [String(p.steamId64), p]));
  return (list || []).map(f => {
    const p = all[String(f.steamId64)];
    const lb = libMap.get(String(f.steamId64));
    if (!p && !lb) return f;
    return {
      ...f,
      profile: {
        games: p?.totals?.games || lb?.games || 0,
        libraryGames: lb?.games || 0,
        totalHours: p?.totals?.totalHours || 0,
        valueYuan: p?.totals?.valueYuan || 0,
        fetchedAtIso: p?.fetchedAtIso || ''
      }
    };
  });
}

function list() {
  const all = readAll();
  const libs = friendLibrary.list().profiles || [];
  const ids = [...new Set([...Object.keys(all), ...libs.map(p => String(p.steamId64))])];
  return {
    ok: true, count: ids.length, pollIntervalSec: 1,
    library: friendLibrary.status(),
    profiles: ids.map(id => {
      const p = all[id] || {};
      const lb = libs.find(x => String(x.steamId64) === id);
      return {
        steamId64: id,
        name: p.name || lb?.name || `Steam ${String(id).slice(-6)}`,
        avatar: p.avatar || lb?.avatar || '',
        games: p.totals?.games || lb?.games || 0,
        libraryGames: lb?.games || 0,
        totalHours: p.totals?.totalHours || 0,
        valueYuan: p.totals?.valueYuan || 0,
        fetchedAtIso: p.fetchedAtIso || '',
        source: p.source || 'Steam 客户端好友游戏库（本机直读）'
      };
    }).sort((a, b) => b.totalHours - a.totalHours)
  };
}

module.exports = { profile, live, list, attachToList, summarize, FILE };
