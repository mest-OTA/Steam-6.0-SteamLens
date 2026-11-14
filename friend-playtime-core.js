'use strict';
/**
 * SteamLens · 朋友的朋友「游玩时长 / 什么时候玩了什么游戏」
 *
 * 用户诉求：在「好友关系链」里不只看到人，还要算出每位（尤其是朋友的朋友）
 *          每款游戏玩了多久、近两周玩了多久、最后一次是什么时候玩的，
 *          并串成一条「游玩时间线」——什么时候、玩的哪一款、玩了多久。
 *
 * 数据来源（全部只读公开数据，不登录、不取 Cookie、不碰聊天记录）：
 *  1. IPlayerService/GetOwnedGames/v1        → 每款游戏 playtime_forever / playtime_2weeks / rtime_last_played
 *  2. IPlayerService/GetRecentlyPlayedGames/v1 → 近两周玩过的游戏与最后游玩时间（补强）
 *  3. 社区 /profiles/<id>/games/?xml=1       → 没有 Web API Key 时的兜底（hoursOnRecord / hoursLast2Weeks）
 *  4. friends-core 的本机上线动态            → 对直接好友补充「什么时候在玩哪款游戏」的真实记录
 *
 * 结果永久写在本机 data/friend-playtime.json，界面打开即可读，不需要每次联网。
 * 对方把「游戏详情」设为私密时 Steam 不返回数据，会明确标注而不猜数字。
 */
const fs = require('node:fs');
const path = require('node:path');

const net = require('./steam-net');
const core = require('./steam-core');
const friends = require('./friends-core');
const achievement = require('./friend-achievement-core');

const ROOT = __dirname;
const FILE = path.join(ROOT, 'data', 'friend-playtime.json');
const API = 'https://api.steampowered.com';
const COMMUNITY = 'https://steamcommunity.com';

const isId = s => /^\d{17}$/.test(String(s || ''));
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round1 = n => Math.round(num(n) * 10) / 10;

function readAll() {
  try {
    const j = JSON.parse(String(fs.readFileSync(FILE, 'utf8')).replace(/^\uFEFF/, ''));
    return j && typeof j === 'object' ? j : { profiles: {}, generatedAt: 0, generatedAtIso: '' };
  } catch { return { profiles: {}, generatedAt: 0, generatedAtIso: '' }; }
}
function writeAll(obj) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    try { fs.renameSync(tmp, FILE); }
    catch { fs.copyFileSync(tmp, FILE); try { fs.unlinkSync(tmp); } catch {} }
    return true;
  } catch { return false; }
}
/**
 * Steam Web API Key 是 32 位十六进制。配置里常被误填成 Server酱 SendKey（SCT 开头），
 * 那种 key 调 Steam 只会 403，所以这里先校验格式，并给出可直接照做的提示。
 */
function keyInfo() {
  const raw = String(core.getConfig().apiKey || '').trim();
  const valid = /^[0-9A-Fa-f]{32}$/.test(raw);
  return {
    key: valid ? raw : '', hasKey: valid,
    hint: !valid && raw
      ? '当前填的 apiKey 不是 Steam Web API Key（应为 32 位十六进制，例如 1A2B…）；请到 steamcommunity.com/dev/apikey 免费申请后填进「连接与配对」，否则抓不到好友时长。'
      : (raw ? '' : '未配置 Steam Web API Key，只能读 Steam 公开社区页面（不含最后游玩时间）。')
  };
}
const apiKey = () => keyInfo().key;

const OWNED_URL = (id, k) => `${API}/IPlayerService/GetOwnedGames/v0001/?key=${encodeURIComponent(k)}`
  + `&steamid=${encodeURIComponent(id)}&include_appinfo=1&include_played_free_games=1&format=json`;
const RECENT_URL = (id, k) => `${API}/IPlayerService/GetRecentlyPlayedGames/v0001/?key=${encodeURIComponent(k)}`
  + `&steamid=${encodeURIComponent(id)}&format=json`;
const XML_URL = id => `${COMMUNITY}/profiles/${id}/games/?xml=1&l=schinese`;

/**
 * 双通道竞速：Node fetch / WinHTTP 系统代理 与 steam-net 的 CONNECT 代理同时试，
 * 谁先成功用谁。本机 Steam 域名常被代理软件劫持，单通道容易 15 秒超时。
 */
async function fetchJsonFast(url, timeoutMs = 15000) {
  const viaFetch = core.fetchJson(url, timeoutMs)
    .then(j => ({ j, via: 'fetch/WinHTTP' }))
    .catch(e => { throw new Error('fetch: ' + e.message); });
  const viaNet = (async () => {
    const r = await net.get(url);
    if (!r.ok || !r.text) throw new Error((r.via || 'net') + ': ' + (r.error || 'HTTP ' + r.status));
    try { return { j: JSON.parse(r.text), via: r.via || 'net' }; }
    catch { throw new Error((r.via || 'net') + ': 返回不是 JSON'); }
  })();
  try { return await Promise.any([viaFetch, viaNet]); }
  catch (e) {
    const msgs = (e && e.errors ? e.errors : []).map(x => x && x.message).filter(Boolean);
    throw new Error(msgs.join(' / ') || 'Steam 接口两条通道都不可用');
  }
}

/* ------------------------- 时间线工具 ------------------------- */
function timeLabel(ts) {
  if (!(ts > 0)) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay = a => a.getFullYear() === now.getFullYear() && a.getMonth() === now.getMonth() && a.getDate() === now.getDate();
  const yst = new Date(now.getTime() - 86400000);
  const hhmm = d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
  if (sameDay(d)) return `今天 ${hhmm}`;
  if (sameDay(yst) && d.getFullYear() === yst.getFullYear() && d.getMonth() === yst.getMonth() && d.getDate() === yst.getDate()) return `昨天 ${hhmm}`;
  const days = Math.floor((Date.now() - ts * 1000) / 86400000);
  if (days < 30) return `${days} 天前 ${hhmm}`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hhmm}`;
}
function isoOf(ts) { return ts > 0 ? new Date(ts * 1000).toISOString() : ''; }

/* ------------------------- 原始数据归一化 ------------------------- */
function normalizeGames(owned, recent) {
  const map = new Map();
  for (const g of (Array.isArray(owned) ? owned : [])) {
    const id = String(g.appid ?? g.app_id ?? g.id ?? '');
    if (!/^\d+$/.test(id)) continue;
    map.set(id, {
      appid: id,
      name: String(g.name || g.appname || `App ${id}`).slice(0, 160),
      playtimeMin: num(g.playtime_forever ?? g.playtimeForever),
      playtime2wksMin: num(g.playtime_2weeks),
      lastPlayedTs: num(g.rtime_last_played),
      imgIconUrl: String(g.img_icon_url || '')
    });
  }
  // 近两周接口能补出 GetOwnedGames 没给的最后游玩时间 / 两周时长
  for (const g of (Array.isArray(recent) ? recent : [])) {
    const id = String(g.appid ?? g.app_id ?? g.id ?? '');
    if (!/^\d+$/.test(id)) continue;
    const cur = map.get(id) || { appid: id, name: '', playtimeMin: 0, playtime2wksMin: 0, lastPlayedTs: 0, imgIconUrl: '' };
    cur.name = cur.name || String(g.name || `App ${id}`);
    cur.playtime2wksMin = Math.max(cur.playtime2wksMin, num(g.playtime_2weeks));
    cur.lastPlayedTs = Math.max(cur.lastPlayedTs, num(g.rtime_last_played));
    cur.playtimeMin = Math.max(cur.playtimeMin, num(g.playtime_forever));
    cur.imgIconUrl = cur.imgIconUrl || String(g.img_icon_url || '');
    map.set(id, cur);
  }
  return [...map.values()];
}

function parseGamesXml(text) {
  const games = [];
  const blocks = String(text || '').match(/<game>[\s\S]*?<\/game>/gi) || [];
  for (const b of blocks) {
    const id = (b.match(/<appID>\s*(\d+)\s*<\/appID>/i) || b.match(/<appid>\s*(\d+)\s*<\/appid>/i) || [])[1];
    if (!id) continue;
    const tag = (re) => (b.match(re) || [])[1] || '';
    const name = tag(/<name>([\s\S]*?)<\/name>/i).replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const hours = num(tag(/<hoursOnRecord>([\d.,]+)<\/hoursOnRecord>/i).replace(',', '.'));
    const hours2w = num(tag(/<hoursLast2Weeks>([\d.,]+)<\/hoursLast2Weeks>/i).replace(',', '.'));
    games.push({
      appid: String(id), name: name || `App ${id}`,
      playtimeMin: Math.round(hours * 60), playtime2wksMin: Math.round(hours2w * 60),
      lastPlayedTs: 0, imgIconUrl: ''
    });
  }
  return games;
}

/** 本机上线动态里带游戏名的记录（直接好友才有），作为「什么时候在玩」的实证补充 */
function localSessions(id) {
  try {
    return friends.loadEvents()
      .filter(e => String(e.steamId64) === String(id) && e.game)
      .map(e => ({
        atTs: Math.floor(new Date(e.iso || e.ts || Date.now()).getTime() / 1000) || 0,
        atIso: e.iso || new Date(e.ts || Date.now()).toISOString(),
        name: String(e.game || ''), appid: '',
        text: String(e.text || ''), type: String(e.type || ''),
        source: '本机上线记录'
      })).filter(x => x.atTs > 0);
  } catch { return []; }
}

function buildProfile(id, meta, rawGames, source, cacheNote) {
  const games = rawGames.map(g => ({
    ...g,
    playtimeHours: round1(g.playtimeMin / 60),
    playtime2wksHours: round1(g.playtime2wksMin / 60),
    lastPlayedIso: isoOf(g.lastPlayedTs),
    lastPlayedLabel: timeLabel(g.lastPlayedTs),
    icon: g.imgIconUrl
      ? `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${g.appid}/${g.imgIconUrl}.jpg`
      : ''
  })).sort((a, b) => b.playtimeMin - a.playtimeMin || String(a.name).localeCompare(String(b.name), 'zh-CN'));

  const totalMin = games.reduce((s, g) => s + g.playtimeMin, 0);
  const recent2wMin = games.reduce((s, g) => s + g.playtime2wksMin, 0);
  const lastTs = games.reduce((m, g) => Math.max(m, g.lastPlayedTs || 0), 0);

  // 游玩时间线：Steam 记录的「最后一次玩这款游戏」+ 本机抓到的真实上线游玩记录
  const fromSteam = games.filter(g => g.lastPlayedTs > 0).map(g => ({
    atTs: g.lastPlayedTs, atIso: g.lastPlayedIso, atLabel: timeLabel(g.lastPlayedTs),
    appid: g.appid, name: g.name, playtimeHours: g.playtimeHours,
    playtime2wksHours: g.playtime2wksHours, icon: g.icon,
    source: 'Steam 记录的最后游玩时间', kind: 'game'
  }));
  const local = localSessions(id);
  const timeline = [...fromSteam, ...local].sort((a, b) => b.atTs - a.atTs).slice(0, 120);

  return {
    ok: true, steamId64: String(id),
    name: meta.name || `Steam ${String(id).slice(-6)}`,
    level: meta.level === 2 ? 2 : 1,
    levelLabel: meta.level === 2 ? '朋友的朋友' : '直接好友',
    viaName: meta.viaName || '',
    profileUrl: `${COMMUNITY}/profiles/${id}`,
    private: false,
    fetchedAt: Date.now(), fetchedAtIso: new Date().toISOString(),
    source, cacheNote: cacheNote || '',
    totals: {
      games: games.length,
      playedGames: games.filter(g => g.playtimeMin > 0).length,
      totalMinutes: totalMin, totalHours: round1(totalMin / 60),
      recent2wMinutes: recent2wMin, recent2wHours: round1(recent2wMin / 60),
      lastPlayedTs: lastTs, lastPlayedIso: isoOf(lastTs), lastPlayedLabel: timeLabel(lastTs),
      timelineCount: timeline.length
    },
    games: games.slice(0, 400),
    topGames: games.filter(g => g.playtimeMin > 0).slice(0, 10),
    timeline,
    note: '时长为 Steam 公开的累计值；「最后游玩」来自 Steam 的 rtime_last_played，精确到分钟。对方设为私密时 Steam 不返回数据。'
  };
}

function privateProfile(id, meta, reason) {
  return {
    ok: false, private: true, steamId64: String(id),
    name: meta.name || `Steam ${String(id).slice(-6)}`,
    level: meta.level === 2 ? 2 : 1,
    levelLabel: meta.level === 2 ? '朋友的朋友' : '直接好友',
    viaName: meta.viaName || '',
    profileUrl: `${COMMUNITY}/profiles/${id}`,
    fetchedAt: Date.now(), fetchedAtIso: new Date().toISOString(),
    reason: reason || 'Steam 没有返回这个人的游戏库：多半是他把「游戏详情」设成了私密/仅好友可见。',
    totals: { games: 0, playedGames: 0, totalMinutes: 0, totalHours: 0, recent2wMinutes: 0, recent2wHours: 0, lastPlayedIso: '', timelineCount: 0 },
    games: [], topGames: [], timeline: localSessions(id)
  };
}

/** 抓一个人的游玩数据：优先官方 Web API，失败自动退到 Steam 社区公开 XML */
async function fetchOne(id, meta = {}) {
  const k = apiKey();
  let owned = null, recent = null, source = '', apiNote = '';
  if (k) {
    try {
      const a = await fetchJsonFast(OWNED_URL(id, k));
      owned = a.j?.response?.games || null;
      if (owned) source = `Steam Web API · GetOwnedGames（${a.via}）`;
      else apiNote = 'Web API 没返回游戏库（Key 可能无效或资料私密）。';
    } catch (e) { apiNote = 'Web API 不可用（' + e.message + '）。'; }
    // 近两周接口能补「最后游玩时间」，即使 OwnedGames 私密也值得一试
    try { recent = (await fetchJsonFast(RECENT_URL(id, k))).j?.response?.games || null; }
    catch {}
    if (!owned && recent) source = 'Steam Web API · GetRecentlyPlayedGames（近两周）';
  }
  if (!owned && !recent) {
    const r = await net.get(XML_URL(id));
    if (!r.ok || !r.text) throw new Error(r.error || ('HTTP ' + r.status));
    if (/<privacyMessage|This profile is private|profile is private/i.test(r.text)) {
      return privateProfile(id, meta, '这个人的游戏库在 Steam 上设为私密，公开页面不显示时长。');
    }
    const xmlGames = parseGamesXml(r.text);
    if (!xmlGames.length) return privateProfile(id, meta, 'Steam 社区没有返回他的游戏列表（可能设了私密或没有公开游戏）。');
    source = 'Steam 社区公开游戏页（games?xml=1）';
    return buildProfile(id, meta, xmlGames, source,
      apiNote + ' 社区页面不含「最后游玩时间」，只提供累计时长与近两周时长。');
  }
  const games = normalizeGames(owned, recent);
  if (!games.length) return privateProfile(id, meta, 'Steam 没有返回任何游戏：多半是「游戏详情」设为私密/仅好友可见。');
  return buildProfile(id, meta, games, source, apiNote);
}

/* ------------------------- 关系链名单 ------------------------- */
/**
 * 本机兜底：联网到 Steam 社区/API 失败时，用之前保存的好友档案
 * （data/friend-profiles.json，来自 Steam 客户端直读 / 官方接口）继续算时长。
 * 时间线会叠上本机上线动态里「什么时候在玩哪款游戏」的真实记录。
 */
function localFallback(id, meta = {}) {
  let games = [];
  try {
    const all = JSON.parse(String(fs.readFileSync(path.join(ROOT, 'data', 'friend-profiles.json'), 'utf8')).replace(/^\uFEFF/, ''));
    const p = all[String(id)];
    if (p && Array.isArray(p.games)) {
      games = p.games.map(g => ({
        appid: String(g.appid ?? ''), name: String(g.name || ''),
        playtimeMin: num(g.playtimeMin), playtime2wksMin: num(g.playtime2wksMin),
        lastPlayedTs: num(g.rtime_last_played), imgIconUrl: String(g.imgIconUrl || '')
      })).filter(g => /^\d+$/.test(g.appid));
    }
  } catch {}
  if (!games.length) return null;
  return buildProfile(id, meta, games,
    '本机已存好友档案（Steam 客户端 / 上次读取，离线兜底）',
    '这次没连上 Steam，显示的是本机上次保存的游玩时长；联网恢复后点「全量重扫」刷新。');
}

function roster() {
  const d = achievement.discovered() || {};
  let direct = Array.isArray(d.direct) ? d.direct : [];
  const extended = Array.isArray(d.extended) ? d.extended : [];
  // 本机 Steam 客户端好友名单始终并入（按 SteamID64 去重）：
  // Steam 社区被网络重置时也能列出当前账号的真实好友，社区关系链只是额外补充。
  try {
    const have = new Set(direct.map(p => String(p.steamId64)));
    for (const f of friends.scanLocalFriends()) {
      const id = String(f.steamId64 || '');
      if (!isId(id) || have.has(id)) continue;
      have.add(id);
      direct.push({ steamId64: id, name: String(f.name || ''), level: 1, viaName: '', state: '' });
    }
  } catch {}
  const seen = new Set();
  const out = [];
  for (const p of [...direct, ...extended]) {
    const id = String(p.steamId64 || '');
    if (!isId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      steamId64: id, name: String(p.name || ''),
      level: Number(p.level) === 2 ? 2 : 1,
      viaName: String(p.viaName || ''),
      state: String(p.state || '')
    });
  }
  return { people: out, directCount: direct.length, extendedCount: extended.length, generatedAtIso: d.generatedAtIso || '' };
}

/**
 * 关系链可能停留在旧账号 / 很久以前（比如换过 Steam 账号），
 * 这时先自动用「当前账号」重新发现一层，避免用户点扫描却只看到空列表。
 */
async function ensureRoster(opts = {}) {
  let r = roster();
  // 只在「一个都没有」或明确要求时才联网重发现；否则用已有关系链/本机名单，
  // 避免 Steam 社区不通时每次扫描都白等一轮网络超时。
  if ((opts.forceDiscover || r.people.length === 0) && !opts.noDiscover) {
    const id = String(core.getConfig().steamId64 || '').trim();
    if (isId(id)) {
      try { await achievement.discoverFriends(id, { depth: 1 }); } catch {}
      r = roster();
    }
  }
  return r;
}

/**
 * 批量扫描（默认只补没抓过的人，refresh=1 时全部重抓）。
 * 限量 + 并发，避免一次扫几百人把 Steam 打爆。
 */
async function scan(opts = {}) {
  const r = await ensureRoster(opts);
  if (!r.people.length) {
    return { ok: false, reason: '还没有好友关系链。请先在上方点「从 Steam 重新发现」，或确认当前 Steam 账号的好友列表是公开的。', scanned: 0, failed: 0, total: 0 };
  }
  const all = readAll();
  const profiles = all.profiles || {};
  const refresh = !!opts.refresh;
  const onlyExtended = !!opts.onlyExtended;
  const limit = Math.min(150, Math.max(1, Number(opts.limit) || 40));
  let queue = r.people.filter(p => refresh || !profiles[p.steamId64]);
  if (onlyExtended) queue = queue.filter(p => p.level === 2);
  queue = queue.slice(0, limit);

  let scanned = 0, failed = 0, priv = 0, localCount = 0;
  const errors = [];
  let cursor = 0;
  // 只要有一人因网络失败，就判定本轮 Steam 联网不可用，剩下的人直接走本机兜底，
  // 避免几十个人逐个等 15 秒超时（网络恢复后点「全量重扫」会重新尝试联网）。
  let networkDead = false;
  const worker = async () => {
    while (cursor < queue.length) {
      const p = queue[cursor++];
      if (!networkDead) {
        try {
          const built = await fetchOne(p.steamId64, p);
          profiles[p.steamId64] = built;
          scanned++;
          if (built.private) priv++;
          continue;
        } catch (e) { networkDead = true; }
      }
      const fb = localFallback(p.steamId64, p);
      if (fb) {
        profiles[p.steamId64] = fb;
        scanned++; localCount++;
      } else {
        failed++;
        profiles[p.steamId64] = privateProfile(p.steamId64, p,
          'Steam 联网暂不可用，本机也没有这个人的时长存档；填好 Steam Web API Key 或等网络恢复后点「全量重扫」即可。');
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  const out = {
    profiles, generatedAt: Date.now(), generatedAtIso: new Date().toISOString(),
    rosterAtIso: r.generatedAtIso, hasKey: keyInfo().hasKey, keyHint: keyInfo().hint
  };
  writeAll(out);
  return {
    ok: true, scanned, failed, private: priv, localCount, total: r.people.length,
    queued: queue.length, cachedCount: Object.keys(profiles).length,
    generatedAtIso: out.generatedAtIso, hasKey: out.hasKey, keyHint: keyInfo().hint,
    errors, note: !out.hasKey ? '未配置 Web API Key，已走 Steam 社区公开页面（社区页不提供最后游玩时间）。' : ''
  };
}

/** 汇总列表：所有人按总时长排序，供界面直接渲染 */
function summary() {
  const all = readAll();
  const r = roster();
  const meta = new Map(r.people.map(p => [p.steamId64, p]));
  const list = Object.values(all.profiles || {}).map(p => {
    const m = meta.get(String(p.steamId64)) || {};
    return {
      steamId64: String(p.steamId64), name: p.name || m.name || '',
      level: p.level || m.level || 1,
      levelLabel: (p.level || m.level) === 2 ? '朋友的朋友' : '直接好友',
      viaName: p.viaName || m.viaName || '',
      private: !!p.private, ok: !!p.ok,
      totalHours: num(p.totals?.totalHours),
      recent2wHours: num(p.totals?.recent2wHours),
      playedGames: num(p.totals?.playedGames),
      games: num(p.totals?.games),
      lastPlayedLabel: String(p.totals?.lastPlayedLabel || ''),
      lastPlayedIso: String(p.totals?.lastPlayedIso || ''),
      timelineCount: num(p.totals?.timelineCount),
      fetchedAtIso: p.fetchedAtIso || '',
      reason: p.reason || ''
    };
  }).sort((a, b) => b.totalHours - a.totalHours || b.recent2wHours - a.recent2wHours);

  // 关系链里还没抓过的人也列出来（标为「未读取」），让用户知道还有谁
  const known = new Set(list.map(x => x.steamId64));
  for (const p of r.people) {
    if (known.has(p.steamId64)) continue;
    list.push({
      steamId64: p.steamId64, name: p.name, level: p.level,
      levelLabel: p.level === 2 ? '朋友的朋友' : '直接好友', viaName: p.viaName,
      private: false, ok: false, notScanned: true, totalHours: 0, recent2wHours: 0,
      playedGames: 0, games: 0, lastPlayedLabel: '', lastPlayedIso: '', timelineCount: 0,
      fetchedAtIso: '', reason: '还没读取过他的游玩时长'
    });
  }
  const extended = list.filter(x => x.level === 2);
  return {
    ok: true, generatedAt: all.generatedAt || 0, generatedAtIso: all.generatedAtIso || '',
    rosterAtIso: r.generatedAtIso, hasKey: keyInfo().hasKey, keyHint: keyInfo().hint,
    count: list.length, scannedCount: list.filter(x => !x.notScanned).length,
    directCount: r.directCount, extendedCount: r.extendedCount,
    people: list,
    stats: {
      totalHours: round1(list.reduce((s, x) => s + x.totalHours, 0)),
      recent2wHours: round1(list.reduce((s, x) => s + x.recent2wHours, 0)),
      extendedHours: round1(extended.reduce((s, x) => s + x.totalHours, 0)),
      extendedCount: extended.length
    }
  };
}

/** 单人明细：默认读缓存，refresh=1 时现抓并写回 */
async function detail(id, opts = {}) {
  const sid = String(id || '').replace(/[^\d]/g, '');
  if (!isId(sid)) return { ok: false, reason: 'SteamID64 格式不正确（需要 17 位数字）' };
  const all = readAll();
  if (!opts.refresh && all.profiles && all.profiles[sid]) {
    return { ...all.profiles[sid], fromCache: true };
  }
  const m = roster().people.find(p => p.steamId64 === sid) || { steamId64: sid, level: 1 };
  let built;
  try { built = await fetchOne(sid, m); }
  catch (e) { built = localFallback(sid, m) || privateProfile(sid, m, '读取失败：' + e.message); }
  all.profiles = all.profiles || {};
  all.profiles[sid] = built;
  all.generatedAt = Date.now(); all.generatedAtIso = new Date().toISOString();
  writeAll(all);
  return { ...built, fromCache: false };
}

function status() {
  const all = readAll();
  const n = Object.keys(all.profiles || {}).length;
  return {
    ok: true, file: FILE, count: n,
    generatedAtIso: all.generatedAtIso || '', hasKey: keyInfo().hasKey, keyHint: keyInfo().hint,
    roster: (() => { const r = roster(); return { direct: r.directCount, extended: r.extendedCount, atIso: r.generatedAtIso }; })()
  };
}

function clear() { writeAll({ profiles: {}, generatedAt: 0, generatedAtIso: '' }); return status(); }

module.exports = { scan, summary, detail, status, clear, roster, fetchOne, FILE };
