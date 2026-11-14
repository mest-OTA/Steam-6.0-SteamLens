/**
 * SteamLens · 数据内核（零第三方依赖）
 *
 * 设计原则：
 *  1. 本地优先：Steam 客户端把 Playtime / LastPlayed 写在 userdata 的 localconfig.vdf 里，
 *     读它不需要联网、不需要 API Key，也不受 Steam 个人资料「私密 / 隐藏」设置影响。
 *  2. 透明：每个字段都记录来源（local / api / manual / override），UI 可逐项展示。
 *  3. 不外传：价格查询只访问 store.steampowered.com；账号只读授权只访问 Steam 官方 API。
 *  4. 真实库：以 GetOwnedGames 为准，已退款 / 愿望单 / 免费周末的游戏不计入库价值。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, execFile } = require('node:child_process');
const account = require('./account-core');
const valueLedger = require('./library-value-core');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'snapshots.json');
const PRICE_FILE = path.join(DATA_DIR, 'prices.json');
const OVERRIDE_FILE = path.join(DATA_DIR, 'overrides.json');
const STATE_CACHE = path.join(DATA_DIR, 'state.json');

const DEFAULT_CONFIG = {
  mode: 'auto',            // auto = 自动连接本机 Steam | manual = 手动连接
  steamPath: '',           // 手动指定 Steam 根目录，留空则自动探测
  steamId64: '',           // 手动模式的 SteamID64
  apiKey: '',              // 手动模式的 Steam Web API Key
  pastedOwnedGames: '',    // 手动模式：直接粘贴 GetOwnedGames 的 JSON
  includeFreeGames: true,
  maskPrivateNames: true,  // 展示时对「隐私游戏」名称打码，但统计照常计入
  autoEstimateValue: true, // 服务启动 / 定时自动补齐商店标价
  valueRefreshHours: 24,   // 库价值：每天自动重算一次
  playtimeRefreshHours: 1, // Steam 本机游玩时长：每小时强制全量重提取一次
  overviewRefreshSec: 60,  // 总览：每分钟自动刷新一次
  librarySyncHours: 12,    // 账号真实库自动重同步间隔（小时）
  includeUnverifiedInValue: true,  // 本机里有标价的历史记录也计入价值（价值账本按游戏增减累计）
  excludeDemosFromValue: true,     // Demo / 试玩版 / Playtest 不算购入，自动从价值里剔除
  port: 8787,
  theme: 'light',
  snapshotMinInterval: 10, // 分钟，避免频繁刷页面写入重复快照
  friendPollSec: 60,       // 好友状态后台轮询间隔（秒）
  friendNotify: true,      // 上线通知总开关
  friendNotifyOffline: true, // 好友退出 Steam 时也推送（与上线共用通道）
  friendLoadRemoteAvatars: false,
  friendPastedSummaries: '',
  // 上线 / 退出 Steam 通知
  notifyDesktop: true,     // Windows 原生桌面弹窗
  notifySound: false,
  notifyScope: 'all',      // all = 所有好友 | starred = 仅关注
  notifyWebhookUrl: '',
  notifyWebhookType: 'auto',
  notifyMinIntervalSec: 300,
  // QQ 邮箱（SMTP 授权码，非 QQ 密码；长期保存 = 永久登录）
  mailEnabled: false,
  mailHost: 'smtp.qq.com',
  mailPort: 465,
  mailUser: '',
  mailAuthCode: '',
  mailTo: '',
  mailOnOnline: true,
  mailOnOffline: true,
  mailOnGame: false,
  mailMinIntervalSec: 300,
  mailQuiet: '',
  mailSubjectPrefix: 'SteamLens',
  // 愿望单降价 / 回涨提醒
  wishlistThresholdYuan: 30,
  wishlistNotifyEnabled: true,
  wishlistAlertMinIntervalSec: 3600,
  wishlistCheckHours: 6,
  // 微信推送（只发给自己；官方扫码绑定拿到的 Key，非微信密码）
  wechatChannel: 'serverchan',
  wechatKey: '',
  wechatEnabled: false,
  wechatOnOnline: true,
  wechatOnOffline: true,
  wechatOnWishlist: true,
  wechatMinIntervalSec: 60,
  // QQ 通知（只发给自己；Qmsg酱扫码绑定 / 本机 OneBot 机器人，非 QQ 密码）
  qqChannel: 'qmsg',
  qqKey: '',
  qqUin: '',
  qqEndpoint: '',
  qqEnabled: false,
  qqOnOnline: true,
  qqOnOffline: true,
  qqOnWishlist: true,
  qqMinIntervalSec: 60,
  // 钉钉群机器人（只推给自己的群；不需要账号密码）
  dingtalkEnabled: false,
  dingtalkOnOnline: true,
  dingtalkOnOffline: true,
  dingtalkOnWishlist: true
};

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */
/* ------------------------------------------------------------------ */

function safeRead(file, enc = 'utf8') {
  try { return fs.readFileSync(file, enc); } catch { return null; }
}
function safeJson(file, fallback) {
  const t = safeRead(file);
  if (!t) return fallback;
  try { return JSON.parse(t); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}
function num(v, fallback = 0) {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : fallback;
}
function exists(p) {
  try { return p && fs.existsSync(p); } catch { return false; }
}
function listDir(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; }
}

/** Valve KeyValues (VDF) 文本解析：支持引号转义、// 注释、无引号 token、嵌套块 */
function parseVDF(text) {
  if (!text) return {};
  const s = String(text).replace(/^\uFEFF/, '');
  let i = 0;
  const n = s.length;

  function skipSpace() {
    while (i < n) {
      const c = s[i];
      if (c === '/' && s[i + 1] === '/') { while (i < n && s[i] !== '\n') i++; continue; }
      if (c === '/' && s[i + 1] === '*') { i += 2; while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
      if (/\s/.test(c) || c === '\0') { i++; continue; }
      break;
    }
  }
  function token() {
    skipSpace();
    if (i >= n) return null;
    if (s[i] === '{' || s[i] === '}') return s[i++];
    if (s[i] === '"') {
      i++;
      let out = '';
      while (i < n) {
        const c = s[i++];
        if (c === '\\') {
          const d = s[i++];
          if (d === 'n') out += '\n';
          else if (d === 't') out += '\t';
          else if (d === 'r') out += '\r';
          else if (d === '"') out += '"';
          else if (d === '\\') out += '\\';
          else out += (d || '');
        } else if (c === '"') break;
        else out += c;
      }
      return out;
    }
    let out = '';
    while (i < n && !/[\s{}"\0]/.test(s[i])) out += s[i++];
    return out || null;
  }
  function block() {
    const obj = {};
    while (i < n) {
      skipSpace();
      if (i >= n) break;
      if (s[i] === '}') { i++; break; }
      const k = token();
      if (k === null) { i++; continue; }
      if (k === '}') break;
      skipSpace();
      if (i < n && s[i] === '{') { i++; obj[k] = block(); }
      else {
        const v = token();
        obj[k] = (v === null || v === '{' || v === '}') ? '' : v;
      }
    }
    return obj;
  }

  const root = {};
  while (i < n) {
    skipSpace();
    if (i >= n) break;
    if (s[i] === '}') { i++; continue; }
    const k = token();
    if (!k || k === '{' || k === '}') { continue; }
    skipSpace();
    if (i < n && s[i] === '{') { i++; root[k] = block(); }
    else { const v = token(); root[k] = v || ''; }
  }
  return root;
}

function vdfFile(file) { return parseVDF(safeRead(file)); }

/** 递归收集「数字 appid 键 + 含时长/隐藏字段的对象」，不依赖具体层级路径 */
function collectAppRecords(node, out = {}) {
  if (!node || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    if (/^\d{1,12}$/.test(k) &&
        ('Playtime' in v || 'Playtime2wks' in v || 'LastPlayed' in v ||
         'Hidden' in v || 'Private' in v || 'LaunchOptions' in v)) {
      out[k] = Object.assign(out[k] || {}, v);
    }
    collectAppRecords(v, out);
  }
  return out;
}

function deepFind(node, key) {
  if (!node || typeof node !== 'object') return undefined;
  if (key in node) return node[key];
  for (const v of Object.values(node)) {
    const r = deepFind(v, key);
    if (r !== undefined) return r;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

function getConfig() {
  return Object.assign({}, DEFAULT_CONFIG, safeJson(CONFIG_FILE, {}));
}
function saveConfig(patch) {
  const cur = getConfig();
  const next = Object.assign({}, cur, patch || {});
  // 不把大段粘贴内容意外写坏
  next.mode = next.mode === 'manual' ? 'manual' : 'auto';
  next.port = Math.min(65535, Math.max(1024, num(next.port, 8787)));
  writeJson(CONFIG_FILE, next);
  _rootCache = { at: 0, list: [] };
  return next;
}
function getOverrides() { return safeJson(OVERRIDE_FILE, { games: {} }); }
function saveOverride(appid, patch) {
  const o = getOverrides();
  o.games = o.games || {};
  o.games[String(appid)] = Object.assign({}, o.games[String(appid)] || {}, patch);
  writeJson(OVERRIDE_FILE, o);
  return o;
}

/* ------------------------------------------------------------------ */
/* 自动模式：探测 Steam 根目录                                          */
/* ------------------------------------------------------------------ */

const SKIP_DIRS = new Set([
  'windows', '$recycle.bin', 'system volume information', 'appdata', 'programdata',
  'node_modules', '.git', 'recovery', 'perflogs', 'documents and settings',
  'msocache', 'intel', 'amd', 'nvidia', 'temp', 'tmp', 'winsxs', 'assembly',
  'system32', 'syswow64', 'drivers', 'cache', 'logs'
]);

function isSteamRoot(p) {
  return exists(path.join(p, 'steam.exe')) ||
         exists(path.join(p, 'config', 'libraryfolders.vdf')) ||
         exists(path.join(p, 'steamapps'));
}
function dirScore(name) {
  const s = String(name).toLowerCase();
  if (s.includes('steam')) return 400;
  if (/games?|软件|software|下载|download|360|apps|应用|工具|tool|program/.test(s)) return 12;
  return 0;
}

/** 不依赖注册表的盘符浅层特征扫描：按目录名得分做 best-first，最多访问 1200 个节点 */
function scanDrivesForSteam(maxNodes = 1200) {
  const pq = [];
  const found = [];
  if (process.platform === 'win32') {
    for (let code = 65; code <= 90; code++) {
      const d = String.fromCharCode(code) + ':\\';
      if (exists(d)) pq.push({ p: d, depth: 0, score: 0 });
    }
  } else {
    for (const d of ['/', '/mnt', os.homedir()]) if (exists(d)) pq.push({ p: d, depth: 0, score: 0 });
  }
  let visited = 0;
  while (pq.length && visited < maxNodes && found.length < 4) {
    let best = 0;
    for (let i = 1; i < pq.length; i++) if (pq[i].score > pq[best].score) best = i;
    const node = pq.splice(best, 1)[0];
    visited++;
    if (isSteamRoot(node.p)) { found.push(node.p); continue; }
    if (node.depth >= 4) continue;
    const entries = listDir(node.p);
    const dirs = entries.filter(d => d.isDirectory() &&
      !SKIP_DIRS.has(d.name.toLowerCase()) && !d.name.startsWith('$')).slice(0, 45);
    for (const d of dirs) {
      pq.push({ p: path.join(node.p, d.name), depth: node.depth + 1, score: node.score + dirScore(d.name) });
    }
  }
  return found;
}

let _rootCache = { at: 0, list: [] };
function detectSteamRoots(force = false) {
  if (!force && _rootCache.list.length && Date.now() - _rootCache.at < 60000) return _rootCache.list;
  const cfg = getConfig();
  const found = [];
  const push = (p, src) => {
    if (!p) return;
    const norm = path.normalize(String(p).replace(/\//g, path.sep));
    if (exists(norm) && !found.some(f => f.path.toLowerCase() === norm.toLowerCase())) {
      found.push({ path: norm, source: src });
    }
  };

  if (cfg.steamPath) push(cfg.steamPath, '手动指定');

  // 上次自动发现并缓存的位置
  const prev = safeJson(path.join(DATA_DIR, 'discovered.json'), {});
  if (prev.path) push(prev.path, '上次自动发现');

  if (process.platform === 'win32' && process.env.STEAMLENS_NO_REG !== '1') {
    try {
      const buf = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
        { encoding: 'buffer', windowsHide: true, timeout: 4000 });
      let txt;
      try { txt = new TextDecoder('gbk').decode(buf); } catch { txt = buf.toString('utf8'); }
      const m = txt.match(/SteamPath\s+REG_SZ\s+(.+)/i);
      if (m) push(m[1].trim(), 'Windows 注册表');
    } catch { /* 无注册表项，继续用其他方式 */ }
  }

  const candidates = [
    'C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam',
    'D:\\Steam', 'E:\\Steam', 'F:\\Steam', 'G:\\Steam', 'H:\\Steam',
    path.join(os.homedir(), 'Steam'),
    '/usr/share/steam', path.join(os.homedir(), '.steam', 'steam'),
    path.join(os.homedir(), '.local', 'share', 'Steam')
  ];
  for (const c of candidates) push(c, '常见安装位置');

  // 注册表不可用 / 非标准安装位置时的自动发现
  if (!found.length) {
    for (const p of scanDrivesForSteam()) push(p, '盘符自动发现');
  }

  if (!found.length) {
    try {
      const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['steam'],
        { encoding: 'utf8', windowsHide: true, timeout: 3000 });
      const first = String(out).split(/\r?\n/).find(Boolean);
      if (first) push(path.dirname(first.trim()), 'PATH');
    } catch { /* ignore */ }
  }

  if (found.length) {
    writeJson(path.join(DATA_DIR, 'discovered.json'), { path: found[0].path, source: found[0].source, at: Date.now() });
  }
  _rootCache = { at: Date.now(), list: found };
  return found;
}

/** 注册表 HKCU\Software\Valve\Steam\Apps\<appid>\Name —— 本地游戏名映射 */
function registryAppNames() {
  const map = {};
  if (process.platform !== 'win32' || process.env.STEAMLENS_NO_REG === '1') return map;
  try {
    const buf = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam\\Apps', '/s'],
      { encoding: 'buffer', windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 });
    let txt;
    try { txt = new TextDecoder('gbk').decode(buf); } catch { txt = buf.toString('utf8'); }
    let current = null;
    for (const line of txt.split(/\r?\n/)) {
      const key = line.match(/Apps\\(\d+)\s*$/i);
      if (key) { current = key[1]; continue; }
      const nm = line.match(/^\s*Name\s+REG_SZ\s+(.+?)\s*$/i);
      if (nm && current) { map[current] = nm[1]; current = null; }
    }
  } catch { /* 走备用通道 */ }

  // 备用通道：某些环境限制 reg.exe，改用 PowerShell 注册表提供者读取同一份数据
  if (!Object.keys(map).length) {
    try {
      const ps = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
        "Get-ChildItem 'HKCU:\\Software\\Valve\\Steam\\Apps' -ErrorAction SilentlyContinue | " +
        'ForEach-Object { $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue; ' +
        '[pscustomobject]@{ id = $_.PSChildName; name = $p.Name } } | ConvertTo-Json -Compress';
      const buf = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { encoding: 'buffer', windowsHide: true, timeout: 9000, maxBuffer: 4 * 1024 * 1024 });
      const txt = buf.toString('utf8').replace(/^\uFEFF/, '').trim();
      const arr = JSON.parse(txt);
      for (const item of (Array.isArray(arr) ? arr : [arr])) {
        if (item && /^\d+$/.test(String(item.id)) && item.name) map[String(item.id)] = String(item.name);
      }
    } catch { /* 无注册表权限时保留 AppID 显示 */ }
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* 自动模式：扫描本地 Steam                                             */
/* ------------------------------------------------------------------ */

function scanLibraries(steamRoot) {
  const libs = [];
  const vdf = vdfFile(path.join(steamRoot, 'config', 'libraryfolders.vdf'));
  const folders = (vdf.libraryfolders || vdf.LibraryFolders || {});
  for (const [idx, entry] of Object.entries(folders)) {
    if (!entry || typeof entry !== 'object') continue;
    const p = entry.path || entry.Path;
    if (!p) continue;
    const root = path.normalize(String(p).replace(/\\\\/g, '\\'));
    libs.push({
      index: idx,
      root,
      available: exists(root),
      apps: Object.keys(entry.apps || {}).map(Number).filter(Boolean),
      totalSize: num(entry.totalsize)
    });
  }
  if (!libs.length) libs.push({ index: '0', root: steamRoot, available: true, apps: [], totalSize: 0 });
  return libs;
}

function scanManifests(libs) {
  const out = {};
  for (const lib of libs) {
    const sa = path.join(lib.root, 'steamapps');
    for (const d of listDir(sa)) {
      const m = d.name && d.name.match(/^appmanifest_(\d+)\.acf$/i);
      if (!m) continue;
      const appid = m[1];
      const a = vdfFile(path.join(sa, d.name)).AppState || {};
      out[appid] = {
        name: a.name || a.Name || '',
        installdir: a.installdir || '',
        sizeBytes: num(a.SizeOnDisk),
        lastUpdated: num(a.LastUpdated),
        lastPlayedManifest: num(a.LastPlayed),
        stateFlags: num(a.StateFlags),
        library: lib.root,
        libraryIndex: String(lib.index),
        buildid: a.buildid || ''
      };
    }
  }
  return out;
}

function scanLoginUsers(steamRoot) {
  const users = vdfFile(path.join(steamRoot, 'config', 'loginusers.vdf')).users || {};
  return Object.entries(users).map(([id, u]) => ({
    steamId64: id,
    accountName: (u && u.AccountName) || '',
    personaName: (u && u.PersonaName) || '',
    autoLogin: !!(u && num(u.AutoLogin)),
    lastLogin: num(u && u.timestamp)
  })).sort((a, b) => b.lastLogin - a.lastLogin);
}

function scanUserdata(steamRoot) {
  const result = { records: {}, hidden: {}, accountIds: [], files: [] };
  const base = path.join(steamRoot, 'userdata');
  for (const d of listDir(base)) {
    if (!d.isDirectory() || !/^\d+$/.test(d.name)) continue;
    result.accountIds.push(d.name);
    const lc = path.join(base, d.name, 'config', 'localconfig.vdf');
    if (exists(lc)) {
      result.files.push(lc);
      Object.assign(result.records, collectAppRecords(vdfFile(lc)));
    }
    const sc = path.join(base, d.name, '7', 'remote', 'sharedconfig.vdf');
    if (exists(sc)) {
      result.files.push(sc);
      const marks = collectAppRecords(parseVDF(safeRead(sc)));
      for (const [id, rec] of Object.entries(marks)) {
        const h = num(rec.Hidden) || num(rec.Private) || (String(rec.hidden || '').trim() === '1' ? 1 : 0);
        if (h) result.hidden[id] = true;
      }
      // Steam 某些版本把 Hidden 放在顶层 apps 下，纯扫描兜底
      const raw = safeRead(sc) || '';
      const re = /"(\d{1,12})"\s*\{[^}]*?"Hidden"\s*"1"/gs;
      let m;
      while ((m = re.exec(raw))) result.hidden[m[1]] = true;
    }
    // shortcuts.vdf：非 Steam 快捷方式（本地添加的游戏）
    const sh = path.join(base, d.name, 'config', 'shortcuts.vdf');
    if (exists(sh)) result.files.push(sh);
  }
  return result;
}

function scanLocal(steamRoot) {
  const libs = scanLibraries(steamRoot);
  const manifests = scanManifests(libs);
  const users = scanLoginUsers(steamRoot);
  const ud = scanUserdata(steamRoot);
  const regNames = registryAppNames();
  return { steamRoot, libs, manifests, users, userdata: ud, regNames };
}

/* ------------------------------------------------------------------ */
/* 手动模式：Steam Web API / 粘贴 JSON                                  */
/* ------------------------------------------------------------------ */

async function fetchJson(url, timeoutMs = 12000) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'SteamLens/1.0 (local, read-only)' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (primary) {
    // 某些网络/沙箱环境下 Node 出站受限，回退到 Windows 自带 WinHTTP 栈。
    // 回退超时严格跟随主超时，避免「一个游戏卡 50 秒」把整轮估价拖死。
    if (process.platform !== 'win32') throw primary;
    const sec = Math.max(4, Math.min(20, Math.ceil(timeoutMs / 1000)));
    return new Promise((resolve, reject) => {
      const ps = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference='Stop'; `
        + `$r=Invoke-WebRequest -UseBasicParsing -Uri '${url.replace(/'/g, '%27')}' -TimeoutSec ${sec}; Write-Output $r.Content`;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { timeout: sec * 1000 + 3000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (err, so) => {
          if (err) return reject(new Error(`${primary.message} / WinHTTP 回退失败: ${err.message}`));
          try { resolve(JSON.parse(String(so).trim())); }
          catch { reject(new Error('WinHTTP 返回内容不是 JSON')); }
        });
    });
  }
}

async function fetchOwnedGames(cfg) {
  const warnings = [];
  let games = [];

  if (cfg.pastedOwnedGames && String(cfg.pastedOwnedGames).trim()) {
    try {
      const j = JSON.parse(String(cfg.pastedOwnedGames));
      const arr = j?.response?.games || j?.games || (Array.isArray(j) ? j : null);
      if (!arr) throw new Error('JSON 里找不到 response.games');
      games = arr;
    } catch (e) { warnings.push(`粘贴的 JSON 解析失败：${e.message}`); }
  } else if (cfg.apiKey && cfg.steamId64) {
    try {
      const u = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${encodeURIComponent(cfg.apiKey)}&steamid=${encodeURIComponent(cfg.steamId64)}&include_appinfo=1&include_played_free_games=1&format=json`;
      const j = await fetchJson(u);
      games = j?.response?.games || [];
      if (!games.length) warnings.push('GetOwnedGames 返回空：个人资料可能为「私密」。本地模式仍可读取全部时长。');
    } catch (e) { warnings.push(`Steam Web API 调用失败：${e.message}（可切换自动模式，或粘贴 JSON）`); }
  } else {
    warnings.push('手动模式尚未填写 API Key + SteamID64，也未粘贴 JSON。当前仅使用本地已配置的数据。');
  }

  let profile = null;
  if (cfg.apiKey && cfg.steamId64) {
    try {
      const u = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${encodeURIComponent(cfg.apiKey)}&steamids=${encodeURIComponent(cfg.steamId64)}`;
      const j = await fetchJson(u);
      profile = j?.response?.players?.[0] || null;
    } catch { /* 头像/昵称非关键 */ }
  }

  return { games, profile, warnings };
}

/* ------------------------------------------------------------------ */
/* 价格（仅显式触发时联网）                                            */
/* ------------------------------------------------------------------ */

function getPriceCache() { return safeJson(PRICE_FILE, {}); }
function savePriceCache(cache) { writeJson(PRICE_FILE, cache); }

const BROWSER_SNAP_FILE = path.join(DATA_DIR, 'browser-snapshot.json');
/** 游戏库里的游戏 = 浏览器扫描从 Steam 商店提取到的「已拥有」AppID（权威清单）。
 *  游戏价值只统计这些，按 AppID 去重；不含本机其他记录、愿望单、购物车、已退款、Demo。 */
function libraryAppids() {
  try {
    const raw = String(fs.readFileSync(BROWSER_SNAP_FILE, 'utf8')).replace(/^\uFEFF/, '');
    const s = JSON.parse(raw);
    const src = (s.storeOwnedApps && s.storeOwnedApps.length) ? s.storeOwnedApps : (s.owned || []);
    const ids = src
      .map(x => String((x && (x.appid || x)) || ''))
      .filter(id => /^\d{1,12}$/.test(id));
    return [...new Set(ids)];
  } catch { return []; }
}

const PRICE_TTL_OK = 7 * 24 * 3600 * 1000;     // 成功：7 天
const PRICE_TTL_MISS = 24 * 3600 * 1000;       // 商店确实无价格：1 天
const PRICE_TTL_ERROR = 20 * 60 * 1000;        // 网络失败：20 分钟后自动重试

/** 判断价格缓存是否仍然有效（失败结果单独用更短的 TTL，避免「一次超时，七天不算价」） */
function priceFresh(hit, now = Date.now()) {
  if (!hit) return false;
  const ttl = hit.networkError ? PRICE_TTL_ERROR : hit.unavailable ? PRICE_TTL_MISS : PRICE_TTL_OK;
  return (now - (hit.checkedAt || 0)) < ttl;
}

async function estimatePrices(appids, onProgress, opts = {}) {
  const cache = getPriceCache();
  const list = [...new Set((appids || []).map(String))];
  const total = list.length;
  const concurrency = Math.max(1, Math.min(6, Number(opts.concurrency) || 3));
  const timeoutMs = Math.max(3000, Number(opts.timeoutMs) || 9000);
  const maxDurationMs = Math.max(60000, Number(opts.maxDurationMs) || 300000);
  let fetched = 0, failed = 0, skipped = 0, done = 0, inflight = 0, cursor = 0;
  let cancelled = false;
  const activeIds = [];
  const report = () => {
    if (onProgress) onProgress({ done, total, fetched, failed, skipped, inflight, activeIds: activeIds.slice(0, 6) });
  };

  async function worker() {
    while (!cancelled && cursor < total) {
      const id = list[cursor++];
      if (priceFresh(cache[id])) {
        skipped++; done++; report();
        continue;
      }
      // ★ 请求一开始就上报，进度条/状态条立刻有反馈，不再「长时间 0%」
      inflight++; activeIds.push(id); report();
      try {
        const url = `https://store.steampowered.com/api/appdetails?appids=${id}&cc=cn&l=schinese`;
        const j = await fetchJson(url, timeoutMs);
        const d = j?.[id];
        if (d?.success && d.data) {
          const p = d.data.price_overview || null;
          cache[id] = {
            name: d.data.name || '',
            isFree: !!d.data.is_free,
            currency: p?.currency || 'CNY',
            initialCents: num(p?.initial),
            finalCents: num(p?.final),
            discount: num(p?.discount_percent),
            checkedAt: Date.now()
          };
          fetched++;
        } else {
          cache[id] = { unavailable: true, reason: '商店无价格信息 / 已下架 / 区域限制', checkedAt: Date.now() };
          failed++;
        }
      } catch (e) {
        // 网络失败不写死「不可估价」，只短暂缓存，下次自动重试
        cache[id] = { unavailable: true, networkError: true, reason: `网络失败：${e.message}`, checkedAt: Date.now() };
        failed++;
      }
      inflight--;
      const k = activeIds.indexOf(id); if (k >= 0) activeIds.splice(k, 1);
      done++;
      savePriceCache(cache);
      report();
      await new Promise(r => setTimeout(r, 180)); // 每个 worker 内部礼貌限速
    }
  }

  const deadline = Date.now() + maxDurationMs;
  const watchdog = setInterval(() => { if (Date.now() > deadline) cancelled = true; }, 2000);
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  } finally {
    clearInterval(watchdog);
    savePriceCache(cache);
  }
  return { fetched, failed, skipped, done, total, timedOut: cancelled, cache };
}

/** 列出真正需要（重新）查价的游戏 ID — 供后台自动刷新使用 */
function missingPriceIds(games) {
  const cache = getPriceCache();
  return games.filter(g => !priceFresh(cache[String(g.appid)])).map(g => String(g.appid));
}

/* ------------------------------------------------------------------ */
/* 合并：来源优先级 manual override > api > local > manifest            */
/* ------------------------------------------------------------------ */

function buildGames(local, remote, cfg) {
  const overrides = getOverrides().games || {};
  const prices = getPriceCache();
  const om = account.ownershipMap();       // 账号真实库（已拥有 / 愿望单 / 退款标记）
  const byId = new Map();
  const warnings = [];

  const ensure = (id) => {
    const k = String(id);
    if (!byId.has(k)) {
      byId.set(k, {
        appid: k, name: '', playtimeMin: 0, playtime2wksMin: 0,
        lastPlayed: 0, installed: false, sizeBytes: 0, library: '',
        hiddenBySteam: false, markedPrivate: false, isShortcut: false,
        priceCents: null, priceCurrency: 'CNY', isFree: false, priceStatus: 'unknown',
        ownership: 'unverified', valueEligible: true,
        sources: {}
      });
    }
    return byId.get(k);
  };

  // 1) 已安装清单（名称、体积、安装位置最可靠）
  if (local) {
    for (const [id, m] of Object.entries(local.manifests)) {
      const g = ensure(id);
      g.name = m.name; g.sources.name = 'appmanifest_' + id + '.acf';
      g.installed = true; g.sizeBytes = m.sizeBytes; g.library = m.library;
      g.lastPlayed = Math.max(g.lastPlayed, m.lastPlayedManifest);
      g.sources.install = 'appmanifest';
    }
    // 2) 注册表游戏名
    for (const [id, nm] of Object.entries(local.regNames)) {
      const g = ensure(id);
      if (!g.name && nm) { g.name = nm; g.sources.name = '注册表 Apps\\' + id; }
      g.registryKnown = true;
    }
    // 3) libraryfolders 中登记但清单缺失的游戏
    for (const lib of local.libs) {
      for (const id of lib.apps) {
        const g = ensure(id);
        if (!g.installed) { g.library = lib.root; g.libraryMissingManifest = true; }
      }
    }
    // 4) ★ 本地时长：包含私密 / 隐藏 / 未安装的游戏，一律纳入
    for (const [id, rec] of Object.entries(local.userdata.records)) {
      const g = ensure(id);
      const pt = num(rec.Playtime);
      g.playtimeMin = pt; g.sources.playtime = 'localconfig.vdf (本地·不受隐私设置影响)';
      g.playtime2wksMin = num(rec.Playtime2wks); g.sources.playtime2wks = 'localconfig.vdf';
      g.playtimeDisconnectedMin = num(rec.PlaytimeDisconnected);
      const lp = num(rec.LastPlayed);
      if (lp) { g.lastPlayed = lp; g.sources.lastPlayed = 'localconfig.vdf'; }
      if (num(rec.Hidden) || num(rec.Private)) g.hiddenBySteam = true;
    }
    for (const id of Object.keys(local.userdata.hidden)) ensure(id).hiddenBySteam = true;
  }

  // 5) Web API（手动模式）：权威的全库时长，可覆盖本地
  if (remote && remote.games && remote.games.length) {
    for (const r of remote.games) {
      const id = String(r.appid);
      const g = ensure(id);
      if (r.name && (!g.name || g.sources.name?.startsWith('注册表'))) {
        g.name = r.name; g.sources.name = 'Steam Web API';
      }
      const pt = num(r.playtime_forever);
      if (pt > 0 || !g.playtimeMin) {
        g.playtimeMin = pt; g.sources.playtime = 'Steam Web API (GetOwnedGames)';
      }
      g.playtime2wksMin = num(r.playtime_2weeks) || g.playtime2wksMin;
      if (num(r.rtime_last_played)) { g.lastPlayed = num(r.rtime_last_played); g.sources.lastPlayed = 'Steam Web API'; }
      if (r.img_icon_url) g.iconHash = r.img_icon_url;
      g.inLibrary = true;
    }
  }

  // 5b) ★ 账号真实库：补齐「确实拥有但本机没装过 / 没玩过」的游戏。
  //     GetOwnedGames 天然不含已退款游戏与愿望单，所以这一步不会把它们带回来。
  for (const [id, t] of om.timeline) {
    const g = ensure(id);
    if (!g.name && t.name) { g.name = t.name; g.sources.name = 'Steam 账号真实库 (GetOwnedGames)'; }
    if (t.playtime > 0 && !g.playtimeMin) {
      g.playtimeMin = t.playtime; g.sources.playtime = 'Steam 账号真实库 (GetOwnedGames)';
    }
    g.inLibrary = true;
  }

  // 6) 价格缓存 + 手动覆盖
  for (const g of byId.values()) {
    const p = prices[g.appid];
    if (p && !p.unavailable) {
      g.priceCents = p.initialCents > 0 ? p.initialCents : p.finalCents;
      g.currentPriceCents = p.finalCents;
      g.priceCurrency = p.currency || 'CNY';
      g.isFree = !!p.isFree;
      g.priceStatus = p.isFree ? 'free' : 'estimated';
      g.priceSource = 'Steam 商店当前标价（原价，非实际购入价）';
      if (p.name && !g.name) { g.name = p.name; g.sources.name = 'Steam 商店'; }
    } else if (p?.unavailable) {
      g.priceStatus = 'unavailable';
      g.priceSource = p.reason;
    }
  }

  // 7) 用户手动录入：最高优先级
  for (const [id, o] of Object.entries(overrides)) {
    const g = ensure(id);
    if (o.name !== undefined) { g.name = o.name; g.sources.name = '手动录入'; }
    if (o.playtimeMin !== undefined && o.playtimeMin !== '') {
      g.playtimeMin = num(o.playtimeMin); g.sources.playtime = '手动录入（覆盖）';
    }
    if (o.priceCents !== undefined && o.priceCents !== '') {
      g.priceCents = num(o.priceCents); g.priceStatus = 'manual';
      g.priceSource = '手动录入'; g.currentPriceCents = g.priceCents;
    }
    if (o.markedPrivate !== undefined) g.markedPrivate = !!o.markedPrivate;
    if (o.hiddenBySteam !== undefined) g.hiddenBySteam = !!o.hiddenBySteam;
    if (o.targetHours !== undefined && o.targetHours !== '') g.targetHours = num(o.targetHours);
  }

  // 8) 兜底名称
  for (const g of byId.values()) {
    if (!g.name) { g.name = `App ${g.appid}`; g.sources.name = '未提供名称（可手动填写）'; }
    g.playtimeHours = Math.round(g.playtimeMin / 60 * 10) / 10;
    g.playtime2wksHours = Math.round(g.playtime2wksMin / 60 * 10) / 10;
    g.sizeGB = Math.round(g.sizeBytes / 1024 / 1024 / 1024 * 10) / 10;
    g.cover = `/api/cover/${g.appid}`;
    g.effectivePrivate = g.markedPrivate || g.hiddenBySteam;
    g.hourlyCost = (g.priceCents > 0 && g.playtimeHours > 0)
      ? Math.round(g.priceCents / 100 / g.playtimeHours * 100) / 100 : null;

    // 所有权与计价资格：退款 / 愿望单永远不计价
    g.ownership = account.classify(g.appid, om);
    g.ownershipLabel = om.connected
      ? (account.OWNERSHIP_LABEL[g.ownership] || g.ownership)
      : '本机记录（未校验账号）';
    g.accountConnected = om.connected;
    // 没花钱的东西不该算进「库价值」：Demo / 试玩版 / Playtest / 序章 / 测试服
    const trial = /\b(demo|playtest|prologue|trial|beta|test server|playtest)\b|试玩|体验版|序章|测试版|抢先试玩/i.test(g.name);
    g.isTrial = trial;
    if (trial && cfg.excludeDemosFromValue !== false) {
      g.valueEligible = false;
      g.excludeReason = '试玩版 / Demo（未产生购入消费）';
    } else if (g.ownership === 'refunded' || g.ownership === 'wishlist') {
      g.valueEligible = false;
      g.excludeReason = g.ownership === 'refunded' ? '已退款 / 已移除' : '仅在愿望单，未购买';
    } else if (g.ownership === 'owned') {
      g.valueEligible = true;
    } else if (om.connected && om.hasOwnedList) {
      g.valueEligible = !!cfg.includeUnverifiedInValue;
      if (!g.valueEligible) {
        g.excludeReason = g.isFree || g.priceStatus === 'free'
          ? '免费游戏 / 免费周末（未产生消费）'
          : '账号里已不存在（疑似已退款 / 家庭共享 / 曾卸载）';
      }
    } else {
      g.valueEligible = true; // 未连接账号时按本地记录计价，口径里会明确标注「未校验」
    }
  }

  const games = [...byId.values()].sort((a, b) => b.playtimeMin - a.playtimeMin);
  if (!cfg.includeFreeGames) {
    return { games: games.filter(g => !g.isFree), warnings };
  }
  return { games, warnings };
}

/* ------------------------------------------------------------------ */
/* 快照 / 进度保存                                                     */
/* ------------------------------------------------------------------ */

function getSnapshots() { return safeJson(SNAPSHOT_FILE, []); }

function writeSnapshot(state, force = false) {
  const all = getSnapshots();
  const last = all[all.length - 1];
  const cfg = getConfig();
  const gapMin = (Date.now() - (last?.ts || 0)) / 60000;
  if (!force && last && gapMin < num(cfg.snapshotMinInterval, 10)) {
    return { snapshots: all, created: false };
  }
  const snap = {
    ts: Date.now(),
    iso: new Date().toISOString(),
    mode: state.mode,
    totalMinutes: state.totals.totalMinutes,
    playedGames: state.totals.playedGames,
    totalValueCents: state.totals.totalValueCents,
    games: Object.fromEntries(state.games.map(g => [g.appid, g.playtimeMin]))
  };
  all.push(snap);
  if (all.length > 720) all.splice(0, all.length - 720);
  writeJson(SNAPSHOT_FILE, all);
  return { snapshots: all, created: true };
}

function snapshotDeltas(state, snapshots) {
  const prev = snapshots.length > 1 ? snapshots[snapshots.length - 2] : null;
  if (!prev) return { hasBaseline: false };
  const dMin = state.totals.totalMinutes - (prev.totalMinutes || 0);
  const perGame = {};
  for (const g of state.games) {
    const before = prev.games?.[g.appid] || 0;
    if (g.playtimeMin > before) perGame[g.appid] = g.playtimeMin - before;
  }
  const top = Object.entries(perGame).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([id, m]) => ({ appid: id, name: state.games.find(g => g.appid === id)?.name || id, minutes: m }));
  return { hasBaseline: true, since: prev.iso, minutes: Math.max(0, dMin), perGame, top };
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

async function buildState(opts = {}) {
  const cfg = Object.assign({}, getConfig(), opts.config || {});
  const mode = opts.mode || cfg.mode || 'auto';
  const warnings = [];
  const localFiles = [];
  let local = null, remote = null;

  // 自动模式：本地扫描；手动模式也能叠加本地数据（用于补齐隐私/隐藏游戏）
  if (mode === 'auto' || opts.includeLocal !== false) {
    const roots = detectSteamRoots();
    if (!roots.length) {
      warnings.push('未找到本机 Steam。可在「连接与配对」里手动指定 Steam 根目录，或切换到手动模式。');
    } else {
      local = scanLocal(roots[0].path);
      localFiles.push(
        path.join(local.steamRoot, 'config', 'libraryfolders.vdf'),
        path.join(local.steamRoot, 'config', 'loginusers.vdf'),
        ...local.userdata.files
      );
      if (!Object.keys(local.userdata.records).length) {
        warnings.push('未读到 localconfig.vdf 的时长记录，可能 Steam 从未登录过或目录权限受限。');
      }
    }
  }

  if (mode === 'manual') {
    remote = await fetchOwnedGames(cfg);
    warnings.push(...remote.warnings);
  }

  const { games, warnings: gw } = buildGames(local, remote, cfg);
  warnings.push(...gw);

  const om = account.ownershipMap();
  const truth = account.getTruth();
  const priceCacheAll = getPriceCache();
  const played = games.filter(g => g.playtimeMin > 0);

  /* ★ 游戏价值口径：只算「游戏库里的游戏」——浏览器扫描从 Steam 商店提取到的已拥有 AppID，
     按 AppID 去重，不重复计入；不含本机其他记录、愿望单、购物车、已退款、Demo。 */
  const libIds = libraryAppids();
  /* ★ 游戏清单两个来源合并（用户要求「Steam 客户端 + 网页端一起算」）：
       1) 网页端采集器从 Steam 商店 dynamicstore 拿到的权威已购买清单；
       2) 本机 Steam 客户端里账号已校验为「拥有」且可计价的游戏（appmanifest / 本机记录）。
     仍严格排除退款 / 愿望单 / Demo，按 AppID 去重，不会重复计钱。 */
  const localOwnedIds = games
    .filter(g => g.valueEligible === true && g.ownership === 'owned')
    .map(g => String(g.appid));
  const mergedLibIds = [...new Set([...libIds.map(String), ...localOwnedIds.map(String)])];
  /* ★ 真实库逐款明细（用户要求「最值钱的游戏 / 每小时成本」也只按 Steam 客户端 + 网页端显示）：
       · 以合并后的 AppID 清单为准，本机 174 条记录里不在清单的游戏一律不进排行榜 / 明细；
       · 清单里有、本机却没扫描到的（网页端买了但未安装）用价格缓存补一条占位，保证「有的就显示」；
       · 每款标注来源（网页端 / 客户端 / 双端都有），前端直接展示，口径可追溯。 */
  const webSet = new Set(libIds.map(String));
  const clientSet = new Set(localOwnedIds.map(String));
  const gameById = new Map(games.map(g => [String(g.appid), g]));
  const libGames = mergedLibIds.map(id => {
    const g = gameById.get(id) || {};
    const p = priceCacheAll[id];
    const cachedCents = (p && !p.unavailable)
      ? (Number(p.initialCents > 0 ? p.initialCents : p.finalCents) || 0) : 0;
    const priceCents = Number(g.priceCents) > 0 ? Number(g.priceCents) : cachedCents;
    const playtimeHours = Number(g.playtimeHours) || 0;
    const hourlyCost = (Number.isFinite(Number(g.hourlyCost)) && Number(g.hourlyCost) > 0)
      ? Number(g.hourlyCost)
      : (priceCents > 0 && playtimeHours > 0
        ? Math.round(priceCents / 100 / playtimeHours * 100) / 100 : null);
    const inWeb = webSet.has(id), inClient = clientSet.has(id);
    return {
      appid: id,
      name: g.name || (p && p.name) || `AppID ${id}`,
      priceCents,
      playtimeHours,
      playtimeMin: Number(g.playtimeMin) || 0,
      hourlyCost,
      installed: !!g.installed,
      ownership: g.ownership || '',
      valueEligible: g.valueEligible !== false,
      effectivePrivate: !!g.effectivePrivate,
      inWeb, inClient,
      sourceLabel: inWeb && inClient ? '双端' : (inWeb ? '网页端' : '客户端'),
      inLocalScan: !!gameById.get(id)
    };
  });
  const valueSources = {
    webOwned: libIds.length,
    steamClientOwned: localOwnedIds.length,
    merged: mergedLibIds.length,
    both: mergedLibIds.filter(id => webSet.has(id) && clientSet.has(id)).length,
    appids: mergedLibIds,          // 真实游戏清单：客户端 + 网页端合并，供「时长构成/排行」过滤
    webAppids: libIds.map(String),
    clientAppids: localOwnedIds.map(String),
    games: libGames,               // 真实库逐款明细：只显示库里有的，库外历史记录一律剔除
    realHours: Math.round(libGames.reduce((n, g) => n + g.playtimeHours, 0) * 10) / 10,
    atIso: new Date().toISOString()
  };
  const seenLib = new Set();
  const valueGames = [];
  for (const id of mergedLibIds) {
    if (seenLib.has(id)) continue;            // 不重复增加游戏
    seenLib.add(id);
    const p = priceCacheAll[id];
    const cents = (p && !p.unavailable) ? (Number(p.initialCents > 0 ? p.initialCents : p.finalCents) || 0) : 0;
    if (!(cents > 0)) continue;               // 无标价的游戏不计入（账本会保留历史价，等有价再显示）
    valueGames.push({
      appid: id, name: (p && p.name) || '',
      valueEligible: true, priceCents: cents, priceSource: 'Steam 商店标价'
    });
  }
  const valued = valueGames;
  const excluded = [];                         // 价值范围已收窄到游戏库，不再有「排除项」概念
  const excludedCents = 0;
  /* ★ 价值永久账本：价格按 AppID 永久保存；当前清单多了就加、少了就减；
     临时读不到清单时保留上次已确认的价值，不回退成 0。 */
  const ledger = valueLedger.sync(valueGames, priceCacheAll);

  // 愿望单单独成表：展示价格方便参考，但绝不混入库价值
  const wishlist = (truth.wishlist || []).map(w => {
    const p = priceCacheAll[String(w.appid)];
    return {
      appid: String(w.appid),
      name: w.name || p?.name || ('App ' + w.appid),
      priceCents: p && !p.unavailable ? (p.initialCents > 0 ? p.initialCents : p.finalCents) : null,
      isFree: !!p?.isFree,
      cover: `/api/cover/${w.appid}`
    };
  }).sort((a, b) => (b.priceCents || 0) - (a.priceCents || 0));

  const totals = {
    games: games.length,
    installed: games.filter(g => g.installed).length,
    playedGames: played.length,
    totalMinutes: games.reduce((s, g) => s + g.playtimeMin, 0),
    totalHours: Math.round(games.reduce((s, g) => s + g.playtimeMin, 0) / 60 * 10) / 10,
    last14Minutes: games.reduce((s, g) => s + g.playtime2wksMin, 0),
    last14Hours: Math.round(games.reduce((s, g) => s + g.playtime2wksMin, 0) / 60 * 10) / 10,
    totalSizeGB: Math.round(games.reduce((s, g) => s + g.sizeBytes, 0) / 1024 / 1024 / 1024 * 10) / 10,
    totalValueCents: ledger.totalCents,
    totalValueYuan: ledger.totalYuan,
    valuedGames: ledger.valuedGames,
    valueLedger: {
      savedPrices: ledger.savedPrices, firstIso: ledger.firstIso, lastIso: ledger.lastIso,
      frozen: ledger.frozen, deltaCents: ledger.deltaCents,
      added: ledger.added, removed: ledger.removed,
      addedCents: ledger.addedCents, removedCents: ledger.removedCents
    },
    freeGames: games.filter(g => g.isFree).length,
    hiddenGames: games.filter(g => g.hiddenBySteam).length,
    privateGames: games.filter(g => g.effectivePrivate).length,
    privateMinutes: games.filter(g => g.effectivePrivate).reduce((s, g) => s + g.playtimeMin, 0),
    // 真实库 / 排除项
    accountConnected: !!om.connected,
    trialGames: games.filter(g => g.isTrial).length,
    ownedGames: games.filter(g => g.ownership === 'owned').length,
    refundedGames: games.filter(g => g.ownership === 'refunded').length,
    unverifiedGames: games.filter(g => g.ownership === 'unverified').length,
    wishlistGames: wishlist.length,
    excludedFromValue: excluded.length,
    excludedValueCents: excludedCents,
    excludedValueYuan: Math.round(excludedCents / 100 * 100) / 100,
    valueScope: '只算「游戏库里的游戏」——即浏览器扫描从 Steam 商店提取到的已拥有 AppID（按 AppID 去重，不重复计入）；愿望单、购物车、已退款、Demo 及本机其他记录均不计价'
      + (cfg.excludeDemosFromValue !== false ? '；Demo / 试玩版自动剔除' : '')
      + '；价值账本：提取过的标价永久保存，新增游戏自动加价、移除游戏自动减价，同步失败不会清零',
    valueSource: 'Steam 商店已购买清单（浏览器扫描）'
  };
  totals.avgCostPerHour = (totals.totalHours > 0 && totals.totalValueCents > 0)
    ? Math.round(totals.totalValueCents / 100 / totals.totalHours * 100) / 100 : null;

  const snap = writeSnapshot({ mode, totals, games }, !!opts.forceSnapshot);
  let identity = remote?.profile
    ? { personaName: remote.profile.personaname, avatar: remote.profile.avatarfull, steamId64: cfg.steamId64 }
    : (local?.users?.[0]
        ? { personaName: local.users[0].personaName, accountName: local.users[0].accountName, steamId64: local.users[0].steamId64, avatar: null }
        : null);
  // 已连接账号时，用 Steam 官方资料覆盖本地昵称 / 头像
  if (om.connected && truth.profile) {
    identity = Object.assign({}, identity || {}, {
      personaName: truth.profile.personaname || identity?.personaName || '',
      avatar: truth.profile.avatarfull || identity?.avatar || null,
      steamId64: truth.steamId64 || identity?.steamId64 || '',
      connectedAt: truth.lastSyncIso || ''
    });
  }

  const state = {
    generatedAt: new Date().toISOString(),
    mode,
    connection: {
      type: mode === 'auto' ? '自动连接 · 本机 Steam' : '手动连接 · Steam Web API / 粘贴 JSON',
      steamRoot: local?.steamRoot || cfg.steamPath || '',
      steamRootSource: (detectSteamRoots()[0] || {}).source || '',
      account: identity,
      userdataAccounts: local?.userdata?.accountIds || [],
      libraries: local?.libs || [],
      localFiles: localFiles.filter(exists),
      usedApi: !!(remote && cfg.apiKey && cfg.steamId64 && !cfg.pastedOwnedGames),
      usedPastedJson: !!cfg.pastedOwnedGames,
      apiGameCount: remote?.games?.length || 0,
      localRecordCount: local ? Object.keys(local.userdata.records).length : 0,
      warnings
    },
    totals,
    valueSources,
    games,
    wishlist,
    excluded: excluded.map(g => ({
      appid: g.appid, name: g.name, ownership: g.ownership,
      ownershipLabel: g.ownershipLabel, excludeReason: g.excludeReason,
      priceCents: g.priceCents || 0, playtimeHours: g.playtimeHours,
      effectivePrivate: g.effectivePrivate
    })),
    account: Object.assign(account.publicView(truth), {
      apiKeySet: !!cfg.apiKey,
      autoSyncHours: num(cfg.librarySyncHours, 12)
    }),
    snapshots: snap.snapshots.map(s => ({ ts: s.ts, iso: s.iso, totalMinutes: s.totalMinutes, totalValueCents: s.totalValueCents, mode: s.mode })),
    deltas: snapshotDeltas({ totals, games }, snap.snapshots),
    privacy: {
      localOnly: true,
      statement: '时长、隐藏游戏、账号信息全部来自本机文件；价格查询只访问 Steam 商店，账号连接只读取 Steam 官方 API，不上传你的游戏列表、时长或凭证。',
      priceBasis: '库价值按 Steam 商店当前人民币原价估算，不等于实际购入价，不含历史折扣、区服差异、DLC 与内购。' + totals.valueScope + '。',
      privateRule: 'Steam 里设为隐藏的游戏会自动填入「隐私与隐藏」并每分钟同步；名称可脱敏显示，但时长与价值始终计入总量统计。'
    }
  };

  // ★ 自动识别 Steam 隐藏游戏，填进 privacy 列表（延迟 require，避免模块循环）
  try { require('./hidden-core').applyToState(state); }
  catch (e) { console.error('[SteamLens 隐藏识别注入失败]', e.message); }

  writeJson(STATE_CACHE, state);
  return state;
}

/* ------------------------------------------------------------------ */
/* 导出 / 给 DeepSeek 的上下文包                                        */
/* ------------------------------------------------------------------ */

function maskName(g, mask = true) {
  if (!mask || !g.effectivePrivate) return g.name;
  return `隐私游戏 #${String(g.appid).slice(-4)}`;
}

function exportMarkdown(state, mask = true) {
  const t = state.totals;
  const lines = [
    '# SteamLens · Steam 使用报告',
    '',
    `- 生成时间：${new Date(state.generatedAt).toLocaleString('zh-CN')}`,
    `- 连接模式：${state.connection.type}`,
    `- 游戏总数：${t.games}（已安装 ${t.installed} / 有游玩记录 ${t.playedGames}）`,
    `- 累计时长：${t.totalHours} 小时（${t.totalMinutes} 分钟）`,
    `- 近 14 天：${t.last14Hours} 小时`,
    `- 库价值估算：¥${t.totalValueYuan}（已估价 ${t.valuedGames} 款）`,
    `- 计价口径：${t.valueScope || '按本机记录统计'}；排除 ${t.excludedFromValue || 0} 款（约 ¥${t.excludedValueYuan || 0}），愿望单 ${t.wishlistGames || 0} 款不计入`,
    `- 平均每小时成本：${t.avgCostPerHour === null ? '—' : '¥' + t.avgCostPerHour}`,
    `- 隐私/隐藏游戏：${t.privateGames} 款，合计 ${(t.privateMinutes / 60).toFixed(1)} 小时（已计入上述总量）`,
    '',
    '## 时长排行（前 20）',
    '',
    '| # | 游戏 | 时长(h) | 近14天(h) | 状态 | 估价(¥) | 时长来源 |',
    '|---|------|--------:|----------:|------|--------:|----------|'
  ];
  state.games.slice(0, 20).forEach((g, i) => {
    lines.push(`| ${i + 1} | ${maskName(g, mask)} | ${g.playtimeHours} | ${g.playtime2wksHours} | ${g.installed ? '已安装' : '未安装'}${g.effectivePrivate ? ' · 隐私' : ''} | ${g.priceCents ? (g.priceCents / 100).toFixed(2) : '—'} | ${g.sources.playtime || '未知'} |`);
  });
  lines.push('', '> 口径说明：' + state.privacy.priceBasis, '', '> ' + state.privacy.statement, '',
    '## 请帮我分析', '',
    '基于以上数据，请分析我的游戏时间分布、投入产出比、最近游玩趋势，并给出 3 条可执行建议。');
  return lines.join('\n');
}

function exportCSV(state, mask = true) {
  const head = ['appid', 'name', 'playtime_minutes', 'playtime_hours', 'last14_minutes', 'last_played', 'installed', 'size_gb', 'price_cny', 'ownership', 'counts_in_value', 'private', 'source'];
  const rows = [head.join(',')];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  for (const g of state.games) {
    rows.push([g.appid, maskName(g, mask), g.playtimeMin, g.playtimeHours, g.playtime2wksMin,
      g.lastPlayed ? new Date(g.lastPlayed * 1000).toISOString() : '', g.installed ? 1 : 0,
      g.sizeGB, g.priceCents ? (g.priceCents / 100).toFixed(2) : '',
      g.ownership || 'unverified', g.valueEligible === false ? 0 : 1, g.effectivePrivate ? 1 : 0,
      g.sources.playtime || ''].map(esc).join(','));
  }
  return '\uFEFF' + rows.join('\r\n');
}

function loadCachedState() { return safeJson(STATE_CACHE, null); }

module.exports = {
  ROOT, DATA_DIR,
  parseVDF, vdfFile, getConfig, saveConfig, getOverrides, saveOverride,
  detectSteamRoots, scanLocal, registryAppNames,
  fetchOwnedGames, estimatePrices, getPriceCache, savePriceCache,
  priceFresh, missingPriceIds, fetchJson, DEFAULT_CONFIG,
  buildState, loadCachedState, getSnapshots, writeSnapshot,
  exportMarkdown, exportCSV, maskName, safeRead, exists
};
