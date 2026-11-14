/**
 * SteamLens · Steam 账号自动连接与登录记录（零第三方依赖）
 *
 * 用户诉求：
 *   1. 打开 Steam 客户端时，自动与本机登录的 Steam 账号「连接」，并拾取只有登录才能
 *      拿到的信息（本机游戏库、时长、账号资料等，已由 steam-core 的本地扫描覆盖）。
 *   2. 若拿不到（没有 API Key / 没登录），则读取 Steam 客户端界面上显示的登录昵称自动填上去。
 *   3. Steam 在哪个地方登录了，要显示出来 + 推通知 + 把时间精确到秒记下来。
 *
 * 做法：
 *   - 账号身份来自本机 Steam 文件：detectSteamRoots().users（按最近登录时间排序），
 *     以及 userdata/<steamID64> 文件夹名。全部只读本机文件，不联网、不碰密码 / Cookie。
 *   - 「地点」用本机设备名（hostname）——这是「在哪台机器登录」的准确、可靠答案。
 *     Steam 官网侧的登录城市需要额外授权，暂未接入（界面已预留说明）。
 *   - 登录事件 = 检测到的账号在「Steam 客户端在线（好友页可读）」状态下出现 / 切换 / 消失，
 *     逐秒对比，按真实时钟精确到秒记录。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const core = require('./steam-core');
const notify = require('./notify-core');
const steamClient = require('./steam-client-core');

const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'account-link.json');
const LOGINS_FILE = path.join(DATA_DIR, 'account-logins.json');

let state = loadState();

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}; } catch { return {}; }
}
function saveState(s) {
  state = s;
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch {}
}
function loadLogins() {
  try { const a = JSON.parse(fs.readFileSync(LOGINS_FILE, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; }
}
function saveLogins(a) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(LOGINS_FILE, JSON.stringify(a.slice(0, 800), null, 2)); } catch {}
}

function deviceName() {
  try { return String(os.hostname() || '本机'); } catch { return '本机'; }
}

/** 从本机 Steam 文件检测当前（最近一次）登录的账号。
 *  @param {boolean} includeConfigFallback 为 true 时，本地探测不到才回退到已配置的账号（仅用于界面自动填值）；
 *                                         watchLogin 传 false，只用真实探测 + Steam 在线状态判断，才能识别「退出」。 */
function detectAccount(includeConfigFallback = true) {
  let info = null;
  try {
    const local = core.detectSteamRoots();
    const users = (local && local.users) || [];
    if (users.length) {
      const u = users[0]; // scanLoginUsers 已按 lastLogin 降序
      info = {
        steamId64: u.steamId64,
        personaName: u.personaName || '',
        accountName: u.accountName || '',
        autoLogin: !!u.autoLogin,
        lastLogin: u.lastLogin || 0,
        source: '本机 Steam 登录记录'
      };
    }
  } catch {}
  if (!info) {
    try {
      const local = core.detectSteamRoots();
      const ids = (local && local.userdata && local.userdata.accountIds) || [];
      if (ids.length) info = { steamId64: ids[0], personaName: '', accountName: '', source: '本机 Steam userdata' };
    } catch {}
  }
  if (!info && includeConfigFallback) {
    // 本地注册表 / 路径都没探到 Steam 时，用已配置的本机账号兜底——
    // 它本就是当前用户的账号，保证「打开 Steam 即连接」与登录检测稳定可用。
    try {
      const id = core.getConfig().steamId64;
      if (id && /^\d{17}$/.test(String(id))) info = { steamId64: String(id), personaName: '', accountName: '', source: '已配置的本机账号' };
    } catch {}
  }
  if (info) info.device = deviceName();
  return info;
}

/** 是否处于「Steam 客户端在线且已登录」的状态（好友页可读 = Steam 在跑且登录了） */
function isSteamLive() {
  try { return !!steamClient.status().connected; } catch { return false; }
}

/** 自动连接：配置里没填 steamID64 时，用检测到的本机账号填上 */
function autoLink() {
  const cfg = core.getConfig();
  if (cfg.steamId64 && /^\d{17}$/.test(String(cfg.steamId64))) {
    return { linked: true, already: true, steamId64: cfg.steamId64 };
  }
  if (state.autoLinkEnabled === false) return { linked: false, reason: '自动连接已关闭' };
  const a = detectAccount();
  if (!a || !/^\d{17}$/.test(String(a.steamId64))) return { linked: false, reason: '未检测到本机登录的 Steam 账号' };
  core.saveConfig({ steamId64: a.steamId64 });
  return { linked: true, account: a };
}

/** 每秒调用：对比「当前活跃账号」与上次记录，产生登录 / 退出 / 切换事件 */
function watchLogin() {
  const a = detectAccount();
  const live = isSteamLive();
  const activeId = (live && a && /^\d{17}$/.test(String(a.steamId64))) ? String(a.steamId64) : '';
  const prevId = state.activeId || '';

  if (activeId === prevId) {
    // 仍处于同一账号：仅刷新时间戳，不产生通知
    if (activeId) saveState({ ...state, activeId, since: state.since || Date.now(), lastSeen: Date.now() });
    return { changed: false, activeId };
  }

  const logins = loadLogins();
  let event = null;
  if (activeId && activeId !== prevId) {
    event = {
      type: prevId ? 'switch' : 'login',
      steamId64: a.steamId64,
      personaName: a.personaName || '',
      accountName: a.accountName || '',
      device: a.device,
      where: '本机 · ' + a.device,
      ts: Date.now(),
      iso: new Date().toISOString()
    };
    logins.unshift(event);
    saveLogins(logins);
    notifyAccount(event);
  } else if (!activeId && prevId) {
    event = {
      type: 'logout',
      steamId64: prevId,
      personaName: state.lastPersona || '',
      accountName: state.lastAccount || '',
      device: deviceName(),
      where: '本机 · ' + deviceName(),
      ts: Date.now(),
      iso: new Date().toISOString()
    };
    logins.unshift(event);
    saveLogins(logins);
    notifyAccount(event);
  }

  saveState({
    ...state,
    activeId,
    since: activeId ? Date.now() : 0,
    lastSeen: Date.now(),
    lastPersona: a ? a.personaName : state.lastPersona,
    lastAccount: a ? a.accountName : state.lastAccount
  });
  return { changed: true, event, activeId };
}

function notifyAccount(ev) {
  try {
    notify.notifyAccountEvent(ev);
  } catch (e) {
    console.log('[SteamLens 账号通知] 发送失败：' + e.message);
  }
}

function setAutoLink(enabled) {
  saveState({ ...state, autoLinkEnabled: !!enabled });
  if (enabled) autoLink();
  return { autoLinkEnabled: state.autoLinkEnabled };
}

function status() {
  const cfg = core.getConfig();
  const a = detectAccount();
  return {
    ok: true,
    autoLinkEnabled: state.autoLinkEnabled !== false,
    configuredId: (cfg.steamId64 && /^\d{17}$/.test(String(cfg.steamId64))) ? String(cfg.steamId64) : '',
    detected: a,
    activeId: state.activeId || '',
    since: state.since || 0,
    steamLive: isSteamLive(),
    loginsCount: loadLogins().length
  };
}

function logins() {
  return { ok: true, logins: loadLogins() };
}

/** 列出本机 Steam 登录过的全部账号（来自 loginusers.vdf），按最近登录降序，最前面标记为 current。
 *  用于「发现并创建账号」：用户启动另一个 Steam 账号后，这里能立刻捡到它的 SteamID64。 */
function detectAllAccounts() {
  const out = [];
  try {
    for (const r of core.detectSteamRoots()) {
      try {
        const users = (core.vdfFile(path.join(r.path, 'config', 'loginusers.vdf')).users) || {};
        for (const [id, u] of Object.entries(users)) {
          out.push({ steamId64: id, accountName: (u && u.AccountName) || '', personaName: (u && u.PersonaName) || '', lastLogin: Number((u && u.timestamp) || 0), source: r.source });
        }
      } catch {}
    }
  } catch {}
  const map = new Map();
  for (const a of out) { const ex = map.get(a.steamId64); if (!ex || a.lastLogin > ex.lastLogin) map.set(a.steamId64, a); }
  const list = [...map.values()].sort((a, b) => b.lastLogin - a.lastLogin);
  if (list.length) list[0].current = true;
  return list;
}

module.exports = { detectAccount, detectAllAccounts, autoLink, watchLogin, setAutoLink, status, logins, isSteamLive };
