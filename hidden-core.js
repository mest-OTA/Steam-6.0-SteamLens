/**
 * SteamLens · Steam 隐藏游戏自动识别（零第三方依赖）
 *
 * 目标：把 Steam 里被「隐藏」的游戏自动填进面板的「隐私与隐藏」页，并每分钟更新一次。
 *
 * 识别来源（全部只读本机 / 浏览器同源会话，不收任何密码）：
 *  1. userdata/*\/config/localconfig.vdf      → apps/<appid>/Hidden=1（Steam 旧版与部分新版）
 *  2. userdata/*\/7/remote/sharedconfig.vdf   → 名为 hidden / 隐藏 的库收藏夹分类
 *  3. userdata/*\/config/library*.vdf|json    → 新版收藏夹 / 隐藏集合
 *  4. VDF 文本正则兜底                        → "appid" { ... "Hidden" "1" }
 *  5. 浏览器已登录 Steam 会话                 → /dynamicstore/userdata/ 的 rgHiddenApps、
 *                                              Steam 库「隐藏」页面扫描到的 appid
 *
 * 结果持久化在 data/hidden-games.json：Steam 客户端没开也不会把已识别的隐藏游戏弄丢；
 * 用户手动移除的条目不会被下一轮自动加回来。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const core = require('./steam-core');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const FILE = path.join(DATA_DIR, 'hidden-games.json');
const BROWSER_FILE = path.join(DATA_DIR, 'browser-snapshot.json');

const DEFAULT = () => ({
  version: 2,
  lastScanAt: 0,
  scanCount: 0,
  stale: false,
  lastTrigger: '',
  lastAdded: [],
  lastRemoved: [],
  sources: {},                 // 来源标签 -> 命中数
  games: {},                   // appid -> { appid, name, sources, firstSeenAt, lastSeenAt }
  manualRemoved: {},           // appid -> 时间戳（永久不再自动加回）
  history: []                  // 最近 30 轮扫描摘要
});

let mem = null;
let scanning = false;

function atomicWrite(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  try { fs.renameSync(tmp, file); }
  catch { fs.copyFileSync(tmp, file); try { fs.unlinkSync(tmp); } catch {} }
}

function data() {
  if (mem) return mem;
  const d = DEFAULT();
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && Number(raw.version) >= 2) {
      for (const k of Object.keys(d)) if (raw[k] !== undefined) d[k] = raw[k];
    }
  } catch { /* 首次运行 */ }
  mem = d;
  return mem;
}
function save() { atomicWrite(FILE, data()); }

function cfg() {
  const c = core.getConfig();
  return {
    enabled: c.hiddenAutoSync !== false,
    intervalSec: Math.min(3600, Math.max(15, Number(c.hiddenSyncSec) || 60))
  };
}

const truthy = v => v === 1 || v === true || String(v ?? '').trim() === '1' || /^(true|yes)$/i.test(String(v ?? '').trim());
const isId = k => /^\d{1,12}$/.test(String(k));
const HIDDEN_NAME = /hidden|隐藏|私密|不显示|private/i;

/* ------------------------------ 多来源扫描 ------------------------------ */
function makeCollector() {
  const hits = new Map();   // appid -> { name, sources:Set }
  const add = (id, source, name) => {
    const key = String(id);
    if (!isId(key)) return;
    if (!hits.has(key)) hits.set(key, { name: '', sources: new Set() });
    const h = hits.get(key);
    h.sources.add(source);
    if (name && !h.name) h.name = String(name).slice(0, 160);
  };
  return { hits, add };
}

function walk(node, add, source, depth = 0, ctxName = '') {
  if (!node || typeof node !== 'object' || depth > 14) return;
  const entries = Array.isArray(node)
    ? node.map((v, i) => [String(i), v])
    : Object.entries(node);

  for (const [k, v] of entries) {
    const key = String(k);
    // (a) 数字 appid 对象里带 Hidden / Private 标记
    if (isId(key) && v && typeof v === 'object' && !Array.isArray(v)) {
      if (truthy(v.Hidden ?? v.hidden ?? v.Private ?? v.private ?? v.IsHidden ?? v.is_hidden ?? v.HideInLibrary)) {
        add(key, source, v.name || v.Name || ctxName);
      }
      if (v.name || v.Name) ctxName = v.name || v.Name;
    }
    // (b) 键名本身是隐藏集合：HiddenApps / rgHiddenApps / hidden …
    if (/^(hiddenapps|hidden_apps|rghiddenapps|appiconshidden|hidden|hiddengames|hidden_games)$/i.test(key)) {
      collectIds(v, add, source + ' · 隐藏集合');
      continue;
    }
    // (c) 名为 hidden / 隐藏 的库分类或收藏夹：把它下面的所有数字 appid 收进来
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const label = v.name || v.Name || v.title || v.label || '';
      if (label && HIDDEN_NAME.test(String(label))) {
        collectIds(v, add, source + ' · 分类「' + String(label).slice(0, 24) + '」');
      }
      // (d) 分类名字段直接等于 hidden（例如 { "name": "hidden" } 的父块）
      if (HIDDEN_NAME.test(key) && !/^(hiddenapps|hidden_apps|rghiddenapps|appiconshidden)$/i.test(key)) {
        collectIds(v, add, source + ' · 隐藏分类');
      }
      walk(v, add, source, depth + 1, ctxName);
    } else if (Array.isArray(v)) {
      walk(v, add, source, depth + 1, ctxName);
    } else if (isId(key) && truthy(v)) {
      // 数字键直接是标量 1，且父层是隐藏分类时由 collectIds 处理，这里不误收
    }
  }
}

function collectIds(node, add, source) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const x of node) {
      if (isId(x)) add(String(x), source);
      else if (x && typeof x === 'object') {
        const id = x.appid ?? x.id ?? x.app_id;
        if (isId(id)) add(String(id), source, x.name || x.title);
      }
    }
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (isId(k)) add(k, source, v?.name || v?.title);
    else if (v && typeof v === 'object') collectIds(v, add, source);
  }
}

function scanSteamFiles(add) {
  let fileCount = 0;
  const roots = core.detectSteamRoots();
  for (const r of roots.slice(0, 3)) {
    const udBase = path.join(r.path, 'userdata');
    let accounts = [];
    try {
      accounts = fs.readdirSync(udBase, { withFileTypes: true })
        .filter(d => d.isDirectory() && /^\d+$/.test(d.name)).map(d => d.name);
    } catch { continue; }
    for (const acc of accounts) {
      const dirs = [
        path.join(udBase, acc, 'config'),
        path.join(udBase, acc, '7', 'remote')
      ];
      for (const dir of dirs) {
        let files = [];
        try { files = fs.readdirSync(dir); } catch { continue; }
        for (const f of files) {
          const lower = f.toLowerCase();
          if (!(lower === 'localconfig.vdf' || lower === 'sharedconfig.vdf' ||
                /^(library|collections|hidden)/.test(lower) && /\.(vdf|json)$/.test(lower))) continue;
          const full = path.join(dir, f);
          let raw = '';
          try {
            const st = fs.statSync(full);
            if (st.size > 12 * 1024 * 1024) continue;
            raw = fs.readFileSync(full, 'utf8');
          } catch { continue; }
          if (!raw) continue;
          fileCount++;
          const source = lower.includes('localconfig') ? 'localconfig.vdf（本机 Steam）'
            : lower.includes('sharedconfig') ? 'sharedconfig.vdf（库收藏夹）'
              : `${f}（本机 Steam）`;
          let node = null;
          try { node = lower.endsWith('.json') ? JSON.parse(raw) : core.parseVDF(raw); }
          catch { /* 容错：下面用正则兜底 */ }
          if (node) walk(node, add, source);
          // 正则兜底：VDF 里 "appid" { ... "Hidden" "1" }（不跨块）
          const re = /"(\d{1,12})"\s*\{[^}]{0,600}?"Hidden"\s*"1"/gs;
          let m;
          while ((m = re.exec(raw))) add(m[1], source + ' · Hidden 标记');
        }
      }
    }
  }
  return fileCount;
}

function scanBrowserSnapshot(add) {
  let n = 0;
  try {
    const b = JSON.parse(fs.readFileSync(BROWSER_FILE, 'utf8'));
    const names = new Map();
    for (const arr of [b.owned, b.wishlist, b.cart]) {
      for (const x of arr || []) if (x && x.appid) names.set(String(x.appid), x.name || '');
    }
    for (const id of b.storeHiddenApps || []) { add(String(id), 'Steam 商店 rgHiddenApps（浏览器已登录）', names.get(String(id))); n++; }
    for (const id of b.hiddenApps || []) { add(String(id), 'Steam 库隐藏页（浏览器已登录）', names.get(String(id))); n++; }
  } catch { /* 没有浏览器快照 */ }
  return n;
}

/** 执行一次完整扫描，返回本轮变化 */
function scan(trigger = '自动') {
  if (scanning) return { ok: false, reason: '正在扫描', changed: false };
  scanning = true;
  try {
    const d = data();
    const { hits, add } = makeCollector();
    const fileCount = scanSteamFiles(add);
    const browserCount = scanBrowserSnapshot(add);
    const now = Date.now();

    // 手动移除的条目永远不再自动加回
    const found = new Map();
    for (const [id, h] of hits) {
      if (d.manualRemoved && d.manualRemoved[id]) continue;
      found.set(id, { name: h.name, sources: [...h.sources] });
    }

    const added = [], removed = [];
    for (const [id, h] of found) {
      if (!d.games[id]) added.push(id);
      const old = d.games[id] || {};
      d.games[id] = {
        appid: id,
        name: h.name || old.name || '',
        sources: [...new Set([...(old.sources || []), ...h.sources])].slice(-8),
        firstSeenAt: old.firstSeenAt || now,
        lastSeenAt: now
      };
    }
    // 只有真的读到 Steam 本机文件时，才按本轮结果移除「已取消隐藏」的游戏。
    // Steam 客户端未运行 / 目录不可读时保留旧记录，避免列表突然清空。
    if (fileCount > 0 || browserCount > 0) {
      for (const id of Object.keys(d.games)) {
        if (!found.has(id)) { delete d.games[id]; removed.push(id); }
      }
      d.stale = false;
    } else {
      d.stale = Object.keys(d.games).length > 0;
    }

    const sources = {};
    for (const [, h] of found) for (const s of h.sources) sources[s] = (sources[s] || 0) + 1;
    d.sources = sources;
    d.lastScanAt = now;
    d.scanCount = Number(d.scanCount || 0) + 1;
    d.lastTrigger = trigger;
    d.lastAdded = added;
    d.lastRemoved = removed;
    d.history.unshift({
      iso: new Date(now).toISOString(), trigger,
      total: Object.keys(d.games).length, added: added.length, removed: removed.length,
      files: fileCount, browser: browserCount, stale: d.stale
    });
    if (d.history.length > 30) d.history.length = 30;
    save();
    const changed = added.length > 0 || removed.length > 0;
    if (changed) console.log(`[SteamLens 隐藏识别] ${trigger}：新增 ${added.length} · 移除 ${removed.length} · 共 ${Object.keys(d.games).length} 款`);
    return {
      ok: true, changed, trigger, scannedAt: now,
      total: Object.keys(d.games).length,
      added, removed, files: fileCount, browser: browserCount, stale: d.stale
    };
  } finally { scanning = false; }
}

/** 到期自动扫描；由后台定时器每 5 秒调用一次 */
function tick() {
  const c = cfg();
  const d = data();
  if (!c.enabled) return { changed: false, skipped: '自动同步已关闭' };
  if (d.lastScanAt && Date.now() - d.lastScanAt < c.intervalSec * 1000) return { changed: false, skipped: '未到刷新时间' };
  return scan('每分钟自动同步');
}

/** 只在需要时补一次扫描，保证 MCP / 直接调 buildState 也能拿到最新隐藏清单 */
function ensureFresh() {
  const c = cfg();
  const d = data();
  if (c.enabled && (!d.lastScanAt || Date.now() - d.lastScanAt >= c.intervalSec * 1000)) {
    try { scan('按需'); } catch (e) { console.error('[SteamLens 隐藏识别]', e.message); }
  }
}

/* ------------------------------ 注入到统计状态 ------------------------------ */
function newHiddenGame(appid, info) {
  return {
    appid, name: info.name || `App ${appid}`,
    playtimeMin: 0, playtime2wksMin: 0, lastPlayed: 0,
    installed: false, sizeBytes: 0, library: '',
    hiddenBySteam: true, markedPrivate: false, autoHidden: true,
    hiddenSources: info.sources || [], isShortcut: false,
    priceCents: null, priceCurrency: 'CNY', isFree: false, priceStatus: 'unknown',
    ownership: 'unverified', valueEligible: false,
    excludeReason: '仅来自 Steam 隐藏清单，未校验购入',
    ownershipLabel: 'Steam 隐藏清单（未计价）',
    sources: { name: 'Steam 隐藏清单' },
    playtimeHours: 0, playtime2wksHours: 0, sizeGB: 0,
    cover: `/api/cover/${appid}`, effectivePrivate: true, hourlyCost: null,
    accountConnected: false
  };
}

/** 由 steam-core.buildState 调用：把自动识别的隐藏游戏填进 state.games 与 totals */
function applyToState(state) {
  if (!state || !Array.isArray(state.games)) return state;
  ensureFresh();
  const d = data();
  const ids = Object.keys(d.games || {});
  if (ids.length) {
    const byId = new Map(state.games.map(g => [String(g.appid), g]));
    for (const id of ids) {
      const info = d.games[id];
      let g = byId.get(id);
      if (!g) {
        // 价格缓存里也许有游戏名，优先展示真名
        const price = core.getPriceCache()[id];
        const nm = info.name || (price && price.name) || '';
        g = newHiddenGame(id, { ...info, name: nm });
        state.games.push(g);
        byId.set(id, g);
      }
      g.hiddenBySteam = true;
      g.autoHidden = true;
      g.hiddenSources = info.sources || [];
      g.effectivePrivate = !!g.markedPrivate || !!g.hiddenBySteam;
      if (!g.name || /^App \d+$/.test(g.name)) {
        g.name = info.name || core.getPriceCache()[id]?.name || g.name;
      }
    }
  }
  const priv = state.games.filter(g => g.effectivePrivate);
  if (state.totals) {
    state.totals.games = state.games.length;
    state.totals.hiddenGames = state.games.filter(g => g.hiddenBySteam).length;
    state.totals.privateGames = priv.length;
    state.totals.privateMinutes = priv.reduce((s, g) => s + (g.playtimeMin || 0), 0);
    state.totals.autoHiddenGames = ids.length;
  }
  state.hidden = status();
  return state;
}

/* ------------------------------ 状态 / 配置 / 人工干预 ------------------------------ */
function status() {
  const c = cfg();
  const d = data();
  const list = Object.values(d.games || {}).sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
  const nextAt = d.lastScanAt ? d.lastScanAt + c.intervalSec * 1000 : Date.now();
  return {
    ok: true,
    enabled: c.enabled, intervalSec: c.intervalSec,
    lastScanAt: d.lastScanAt, nextAt,
    secondsUntilNext: Math.max(0, Math.round((nextAt - Date.now()) / 1000)),
    secondsSinceScan: d.lastScanAt ? Math.round((Date.now() - d.lastScanAt) / 1000) : null,
    scanCount: d.scanCount || 0, lastTrigger: d.lastTrigger || '',
    count: list.length, sources: d.sources || {},
    stale: !!d.stale,
    lastAdded: d.lastAdded || [], lastRemoved: d.lastRemoved || [],
    manualRemovedCount: Object.keys(d.manualRemoved || {}).length,
    games: list.map(x => ({ appid: x.appid, name: x.name || '', sources: x.sources || [], firstSeenAt: x.firstSeenAt, lastSeenAt: x.lastSeenAt })),
    history: (d.history || []).slice(0, 12),
    rule: '自动识别 Steam 本机与已登录浏览器里的「隐藏」游戏，写入隐私与隐藏列表；时长与价值照常计入，名称可脱敏。',
    serverNow: Date.now()
  };
}

function saveConfig(patch = {}) {
  const allowed = {};
  if (patch.enabled !== undefined) allowed.hiddenAutoSync = !!patch.enabled;
  if (patch.intervalSec !== undefined) allowed.hiddenSyncSec = Math.min(3600, Math.max(15, Number(patch.intervalSec) || 60));
  if (Object.keys(allowed).length) core.saveConfig(allowed);
  return status();
}

/** 用户在列表里手动移除：永久不再自动加回（除非「恢复全部」） */
function remove(appid) {
  const d = data();
  const id = String(appid);
  d.manualRemoved[id] = Date.now();
  delete d.games[id];
  save();
  return status();
}
function restore() {
  const d = data();
  d.manualRemoved = {};
  save();
  return scan('手动全量重新识别');
}
/** 用户在编辑弹窗里手动把某游戏标为 Steam 隐藏 */
function addManual(appid) {
  const d = data();
  const id = String(appid);
  delete d.manualRemoved[id];
  const now = Date.now();
  d.games[id] = {
    appid: id, name: '', sources: ['手动标记'],
    firstSeenAt: d.games[id]?.firstSeenAt || now, lastSeenAt: now
  };
  save();
  return status();
}

module.exports = {
  scan, tick, ensureFresh, applyToState, status, saveConfig,
  remove, restore, addManual, data, cfg
};
