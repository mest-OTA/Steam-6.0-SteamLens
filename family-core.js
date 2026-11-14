'use strict';
/**
 * SteamLens · 识别家庭（Steam Family / 共享家庭）
 *
 * 功能：
 *   · 用 Steam 家庭访问令牌（access_token）调用 IFamilyGroupsService，识别你所在的共享家庭；
 *   · 列出全部家庭成员（头像 / 昵称 / 房主或成员 / 各自库数量与估值）；
 *   · 合并整个家庭的共享游戏库（GetSharedLibraryApps 直接给出并集 + 每款归属人），给出家庭库总价值；
 *   · 每次识别与上次快照对比：谁加入 / 谁退出 / 共享库新增了哪些游戏；
 *   · 按通知设置把「成员退出 / 加入 / 新增游戏」推送给你（桌面 / 邮箱 / 微信 / QQ / 钉钉 / Webhook）。
 *
 * 关于鉴权（重要）：Steam 家庭接口属于用户私有数据，必须用「家庭访问令牌 access_token」而不是 Web API Key。
 *   access_token 获取方式：登录 store.steampowered.com 后，打开
 *   https://store.steampowered.com/pointssummary/ajaxgetasyncconfig
 *   复制返回 JSON 里的 webapi_token 值即可。本模块只读、只存本机。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const core = require('./steam-core');        // getPriceCache, estimatePrices
const account = require('./account-core');   // getConfig
const notify = require('./notify-core');     // notifyFamilyEvent

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const SNAP_FILE = path.join(DATA_DIR, 'family.json');
const CFG_FILE = path.join(DATA_DIR, 'family-config.json');

const API = 'https://api.steampowered.com';

/* ------------------------------ 基础 IO ------------------------------ */
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }
function writeJson(f, o) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2), 'utf8'); }

function getConfig() {
  return Object.assign(
    { notifyNewGame: true, notifyMemberLeft: true, notifyMemberJoined: true, autoScan: false, accessToken: '' },
    readJson(CFG_FILE, {})
  );
}
function saveConfig(patch) { const n = Object.assign(getConfig(), patch); writeJson(CFG_FILE, n); return n; }
function getSnapshot() { return readJson(SNAP_FILE, null); }

/* ------------------------------ 网络（Node fetch + PowerShell 回退） ------------------------------ */
async function fetchJson(url, timeoutMs = 22000) {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'SteamLens/1.0 (local, read-only)' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (primaryErr) {
    if (process.platform !== 'win32') throw primaryErr;
    return new Promise((resolve, reject) => {
      const ps = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; `
        + `$ErrorActionPreference='Stop'; `
        + `$r=Invoke-WebRequest -UseBasicParsing -Uri '${url.replace(/'/g, '%27')}' -TimeoutSec 25; `
        + `Write-Output $r.Content`;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { timeout: 32000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        (err, so) => {
          if (err) return reject(new Error(`${primaryErr.message} / PowerShell 回退失败: ${err.message}`));
          try { resolve(JSON.parse(String(so).trim())); }
          catch (e) { reject(new Error(`PowerShell 返回非 JSON：${String(so).slice(0, 120)}`)); }
        });
    });
  }
}

async function fetchText(url, timeoutMs = 22000) {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'SteamLens/1.0 (local, read-only)' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } catch (primaryErr) {
    if (process.platform !== 'win32') throw primaryErr;
    return new Promise((resolve, reject) => {
      const ps = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; `
        + `$ErrorActionPreference='Stop'; `
        + `$r=Invoke-WebRequest -UseBasicParsing -Uri '${url.replace(/'/g, '%27')}' -TimeoutSec 25; `
        + `Write-Output $r.Content`;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { timeout: 32000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        (err, so) => {
          if (err) return reject(new Error(`${primaryErr.message} / PowerShell 回退失败: ${err.message}`));
          resolve(String(so));
        });
    });
  }
}

/* 解析家庭访问令牌（JWT），用于提示过期 */
function decodeToken(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length < 2) return { sub: '', exp: 0, expired: false, valid: false };
    let p = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (p.length % 4) p += '=';
    const j = JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
    const exp = Number(j.exp || 0) * 1000;
    return { sub: String(j.sub || ''), exp, expired: exp > 0 && exp < Date.now(), valid: true };
  } catch { return { sub: '', exp: 0, expired: false, valid: false }; }
}

/* ------------------------------ URL ------------------------------ */
function familyForUserUrl(token, id) {
  return `${API}/IFamilyGroupsService/GetFamilyGroupForUser/v1/?access_token=${encodeURIComponent(token)}&include_family_group_response=true`;
}
function familyGroupUrl(token, gid) {
  return `${API}/IFamilyGroupsService/GetFamilyGroup/v1/?access_token=${encodeURIComponent(token)}&family_groupid=${encodeURIComponent(gid)}`;
}
function sharedAppsUrl(token, gid) {
  return `${API}/IFamilyGroupsService/GetSharedLibraryApps/v1/?access_token=${encodeURIComponent(token)}`
    + `&family_groupid=${encodeURIComponent(gid)}&include_own=true&include_excluded=false&include_non_games=false`;
}
function summariesUrl(key, ids) {
  return `${API}/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(key)}&steamids=${encodeURIComponent(ids)}`;
}

/* ------------------------------ 估价辅助 ------------------------------ */
function priceInfo(priceCache, id) {
  const p = priceCache[id] || priceCache[String(id)] || {};
  return { name: p.name || '', cents: Number(p.finalCents || p.initialCents || 0), isFree: !!p.isFree };
}

/* ------------------------------ 变化检测 ------------------------------ */
function detectChanges(prev, cur) {
  const prevMembers = new Map((prev && prev.members || []).map(m => [m.steamid, m]));
  const curMembers = new Map((cur.members || []).map(m => [m.steamid, m]));
  const joined = (cur.members || []).filter(m => !prevMembers.has(m.steamid));
  const left = (prev && prev.members || [])
    .filter(m => !curMembers.has(m.steamid))
    .map(m => ({ steamid: m.steamid, name: m.name }));
  const prevApps = new Set((prev && prev.libraryAppids) || []);
  const curApps = new Set((cur.libraryAppids) || []);
  const curLib = new Map((cur.library || []).map(g => [g.appid, g]));
  const newGameIds = [...curApps].filter(a => !prevApps.has(a));
  const newGames = newGameIds.map(a => {
    const g = curLib.get(a) || {};
    return { appid: a, name: g.name || String(a), owners: g.owners || [] };
  }).filter(g => !/^\d+$/.test(g.name));
  const removedGames = [...prevApps].filter(a => !curApps.has(a));
  return { joined, left, newGames, removedGames };
}

/* ------------------------------ 主流程：识别家庭 ------------------------------ */
async function scan() {
  const acct = account.getConfig();
  const key = String(acct.apiKey || '').trim();
  const myId = String(acct.steamId64 || '').trim();
  const token = String(getConfig().accessToken || '').trim();
  if (!token) {
    return { ok: false, reason: 'no-token',
      message: '请先在「识别家庭」页填入 Steam 家庭访问令牌（access_token）。提示：家庭接口需要登录态令牌，不是 Web API Key。' };
  }
  if (!myId) {
    return { ok: false, reason: 'no-id', message: '请先在「Steam 账号」页连接你的账号（需要你是某个 Steam 家庭的成员）。' };
  }

  // 1) 家庭组（含成员列表）
  let fgu;
  try { fgu = await fetchJson(familyForUserUrl(token, myId)); }
  catch (e) {
    const m = /HTTP (\d+)/.exec(String(e.message || ''));
    if (m && (m[1] === '401' || m[1] === '403'))
      return { ok: false, reason: 'token-expired', message: `家庭访问令牌已失效（HTTP ${m[1]}）。请重新获取 webapi_token 并保存后重试：登录 store.steampowered.com → 打开 pointssummary/ajaxgetasyncconfig → 复制 webapi_token。` };
    return { ok: false, reason: 'api-error', message: '获取家庭组失败：' + e.message };
  }
  const fgResp = (fgu && fgu.response) || {};
  if (fgResp.is_not_member_of_any_group) {
    writeJson(SNAP_FILE, { noFamily: true, scannedAt: Date.now(), scannedIso: new Date().toISOString(), groupid: null, members: [], library: [], memberCount: 0, totalGames: 0, libraryAppids: [] });
    return { ok: false, reason: 'no-family', message: '当前账号没有加入任何 Steam 家庭（先在 Steam → 设置 → 家庭 创建或加入一个家庭，再用该账号的令牌扫描）。' };
  }
  const groupid = String(fgResp.family_groupid || (fgResp.family_group && fgResp.family_group.family_groupid) || '').trim();
  if (!groupid) return { ok: false, reason: 'no-family', message: '未读到家庭组 ID（可能未加入家庭）。' };

  let membersList = Array.isArray(fgResp.family_group && fgResp.family_group.members) ? fgResp.family_group.members : [];
  if (!membersList.length) {
    try {
      const g2 = await fetchJson(familyGroupUrl(token, groupid));
      membersList = (g2 && g2.response && g2.response.members) || [];
    } catch { /* ignore */ }
  }
  if (!membersList.length) return { ok: false, reason: 'no-members', message: '家庭组里读不到成员列表。' };

  // 2) 成员资料（头像 / 昵称）——用 Web API Key（key 可用）
  const ids = membersList.map(m => String(m.steamid));
  let players = [];
  if (key) {
    try { const su = await fetchJson(summariesUrl(key, ids.join(','))); players = (su && su.response && su.response.players) || []; }
    catch { /* 资料拉不到就用家庭组 displayname */ }
  }
  const playerMap = new Map(players.map(p => [String(p.steamid), p]));

  // 2.5) 用 Steam 社区公开资料补全真实昵称（免 API Key，家庭接口本身不返回昵称）
  async function communityName(sid) {
    try {
      const xml = await fetchText(`https://steamcommunity.com/profiles/${encodeURIComponent(sid)}/?xml=1`, 15000);
      const m = /<steamID>([\s\S]*?)<\/steamID>/.exec(xml || '');
      if (m) return String(m[1]).replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    } catch { /* 社区资料拉不到就用回退名 */ }
    return '';
  }
  const commNames = {};
  await Promise.all(ids.map(async sid => { commNames[sid] = await communityName(sid); }));

  // 3) 共享库（直接给出并集 + 每款归属人）
  let apps = [];
  try { const sa = await fetchJson(sharedAppsUrl(token, groupid)); apps = (sa && sa.response && sa.response.apps) || []; }
  catch (e) { return { ok: false, reason: 'api-error', message: '获取家庭共享库失败：' + e.message }; }
  if (!apps.length) return { ok: false, reason: 'empty-library', message: '这个家庭共享库里还没有共享的游戏。' };

  const union = new Map(); // appid -> {owners:[sid]}
  for (const a of apps) {
    const appid = String(a.appid);
    const owners = (a.owner_steamids || []).map(String);
    union.set(appid, { owners });
  }

  // 4) 补全游戏名 + 估价（estimatePrices 会把 name / finalCents 写进价格缓存）
  const appids = [...union.keys()];
  let priceCache = core.getPriceCache();
  try {
    await Promise.race([
      core.estimatePrices(appids, () => {}, { silent: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('估算超时')), 150000))
    ]);
    priceCache = core.getPriceCache();
  } catch { /* 用已缓存的 */ }

  const ownerName = sid => {
    const m = membersList.find(x => String(x.steamid) === sid);
    if (m && (m.displayname || m.name)) return m.displayname || m.name;
    const p = playerMap.get(sid);
    if (p && (p.personaname || p.realname)) return p.personaname || p.realname;
    return commNames[sid] || '';
  };

  const library = [];
  for (const [appid, g] of union) {
    const pi = priceInfo(priceCache, appid);
    const owners = (g.owners || []).map(sid => ({ steamid: sid, name: ownerName(sid) }));
    library.push({
      appid,
      name: pi.name || ('App ' + appid),
      owners: owners.map(o => o.steamid),
      ownerNames: owners.map(o => o.name).filter(Boolean).join('、'),
      priceCents: pi.cents,
      isFree: pi.isFree
    });
  }

  // 5) 成员各自的库数量与估值
  const members = membersList.map(m => {
    const sid = String(m.steamid);
    const pl = playerMap.get(sid) || {};
    const owned = library.filter(g => g.owners.includes(sid));
    let v = 0; for (const g of owned) v += g.priceCents || 0;
    const role = m.role_name || m.role || '';
    return {
      steamid: sid,
      accountid: m.accountid,
      name: pl.personaname || commNames[sid] || m.displayname || ownerName(sid) || ('Steam ' + sid.slice(0, 8)),
      avatar: pl.avatarfull || pl.avatar || '',
      role,
      gameCount: owned.length,
      valueCents: v
    };
  });

  library.sort((a, b) => (b.priceCents || 0) - (a.priceCents || 0) || (b.owners.length) - (a.owners.length));
  const totalValueCents = library.reduce((s, g) => s + (g.priceCents || 0), 0);
  const pricedCount = library.filter(g => (g.priceCents || 0) > 0).length;

  const snapshot = {
    groupid,
    scannedAt: Date.now(),
    scannedIso: new Date().toISOString(),
    memberCount: members.length,
    totalGames: library.length,
    totalValueCents,
    pricedCount,
    members,
    library,
    libraryAppids: library.map(g => g.appid)
  };

  const prev = getSnapshot();
  const changes = detectChanges(prev, snapshot);

  // 滚动保存家庭动态事件
  const eventEntries = [];
  if (changes.joined.length) eventEntries.push({ ts: snapshot.scannedAt, type: 'member-joined', text: `成员加入：${changes.joined.map(x => x.name).join('、')}` });
  if (changes.left.length) eventEntries.push({ ts: snapshot.scannedAt, type: 'member-left', text: `成员退出：${changes.left.map(x => x.name).join('、')}` });
  if (changes.newGames.length) eventEntries.push({ ts: snapshot.scannedAt, type: 'new-game', text: `家庭共享库新增 ${changes.newGames.length} 款游戏：${changes.newGames.slice(0, 12).map(g => g.name).join('、')}` });
  const prevEvents = (prev && prev.events) || [];
  snapshot.events = eventEntries.concat(prevEvents).slice(0, 50);
  snapshot.lastChanges = { at: snapshot.scannedIso, joined: changes.joined, left: changes.left, newGames: changes.newGames };

  writeJson(SNAP_FILE, snapshot);

  // 6) 通知（仅在已有上一次快照时对比，避免首次扫描误报）
  const notifications = [];
  if (prev) {
    const c = getConfig();
    try {
      if (changes.left.length && c.notifyMemberLeft)
        notifications.push(await notify.notifyFamilyEvent({ type: 'member-left', names: changes.left.map(x => x.name), ids: changes.left.map(x => x.steamid) }));
      if (changes.joined.length && c.notifyMemberJoined)
        notifications.push(await notify.notifyFamilyEvent({ type: 'member-joined', names: changes.joined.map(x => x.name), ids: changes.joined.map(x => x.steamid) }));
      if (changes.newGames.length && c.notifyNewGame)
        notifications.push(await notify.notifyFamilyEvent({ type: 'new-game', games: changes.newGames.slice(0, 20) }));
    } catch { /* 通知失败不影响识别结果 */ }
  }

  const changeSummary = [];
  if (changes.joined.length) changeSummary.push(`+${changes.joined.length} 位新成员`);
  if (changes.left.length) changeSummary.push(`-${changes.left.length} 位退出`);
  if (changes.newGames.length) changeSummary.push(`+${changes.newGames.length} 款新游戏`);

  return {
    ok: true,
    snapshot,
    changes,
    notifications,
    message: `已识别 ${members.length} 位家庭成员、${library.length} 款共享游戏，家庭库估值 ¥${(totalValueCents / 100).toFixed(2)}（其中 ${pricedCount} 款有估价）。`
      + (changeSummary.length ? ` 本次变化：${changeSummary.join('，')}。` : '')
  };
}

/* 仅返回已保存的快照（无需联网），供前端直接渲染；不回显令牌 */
function status() {
  const snap = getSnapshot();
  const cfg = getConfig();
  const acct = account.getConfig();
  let tokenExpired = false, tokenExpiresAt = 0, tokenSub = '';
  const t = String(cfg.accessToken || '').trim();
  if (t) { const d = decodeToken(t); tokenExpired = d.expired; tokenExpiresAt = d.exp; tokenSub = d.sub; }
  return {
    ok: !!snap,
    snapshot: snap,
    config: { notifyNewGame: cfg.notifyNewGame, notifyMemberLeft: cfg.notifyMemberLeft, notifyMemberJoined: cfg.notifyMemberJoined, autoScan: cfg.autoScan },
    hasToken: !!t,
    tokenExpired, tokenExpiresAt, tokenSub,
    hasKey: !!String(acct.apiKey || '').trim(),
    myId: String(acct.steamId64 || '').trim()
  };
}

module.exports = { scan, status, getSnapshot, getConfig, saveConfig, detectChanges };
