/**
 * SteamLens · 游戏元数据补全（游戏名 + 封面图）
 *
 * 背景：Steam 商店 /dynamicstore/userdata/ 只给 rgWishlist 等 AppID 数组，
 *       浏览器扫描到的愿望单 / 购物车经常是「有 ID、没名字、没图」。
 *
 * 做法：
 *  1. 按 AppID 向 Steam 商店公开接口 appdetails 取中文名与 header_image，
 *     结果永久写进 data/game-meta.json（以后秒开，不重复联网）。
 *  2. decorate() 纯内存、零 IO，供 /api/browser/status 每秒调用；
 *     永不阻塞面板，取不到名字时先显示 AppID 并排队后台补全。
 *  3. 封面用「Steam CDN → 本机 librarycache」双回退，断网也能显示本地封面。
 *
 * 边界：只读 Steam 公开商店资料，不登录、不碰 Cookie、不上传任何本机数据。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const FILE = path.join(DATA_DIR, 'game-meta.json');
const API = 'https://store.steampowered.com/api/appdetails';
const BATCH = 4;
const RETRY_MS = 5 * 60 * 1000;

/* 通用封面：老 CDN 对大多数游戏有效；新上架游戏的封面路径带哈希，
   由 appdetails 返回的 header_image 精确覆盖并永久缓存。 */
const cdnCover = appid =>
  `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`;

let store = {};                 // appid -> { name, cover, at }
let failed = new Map();         // appid -> 下次可重试的时间戳
let pending = new Set();
let pumping = false;
let scheduled = false;
let timer = null;
const state = { lastAt: 0, lastError: '', resolved: 0, rounds: 0 };

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    store = (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
  } catch { store = {}; }
}
function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 1), 'utf8');
    try { fs.renameSync(tmp, FILE); }
    catch { fs.copyFileSync(tmp, FILE); try { fs.unlinkSync(tmp); } catch {} }
  } catch { /* 缓存写失败不能影响面板 */ }
}
load();

function nameOf(appid) {
  return String(store[String(appid)]?.name || '');
}
function coverOf(appid) {
  const id = String(appid || '').trim();
  return String(store[id]?.cover || (/^\d{1,12}$/.test(id) ? cdnCover(id) : ''));
}
/** Steam 商店官方短简介：详情弹窗「玩法」最可靠、最不会搜错的来源 */
function descOf(appid) {
  return String(store[String(appid)]?.desc || '');
}
/** Steam 商店公开成就：给本机没有成就文件的游戏（愿望单 / 未安装）兜底 */
function achievementsOf(appid) {
  const m = store[String(appid)] || {};
  return {
    checked: m.achChecked === true,
    total: Number(m.achTotal) || 0,
    list: (Array.isArray(m.achList) ? m.achList : []).map(a => ({
      name: a.name, desc: 'Steam 商店公开成就', icon: a.icon || '',
      unlocked: false, unlockedIso: ''
    }))
  };
}
/** 详情弹窗打开时按需补一次成就：排队后台请求，最多等 6 秒，不阻塞面板 */
async function ensureAchievements(appid) {
  const id = String(appid || '').trim();
  if (!/^\d{1,12}$/.test(id)) return achievementsOf(id);
  if (store[id] && store[id].achChecked) return achievementsOf(id);
  failed.delete(id);
  queue([id], true);
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 250));
    if (store[id] && store[id].achChecked) break;
  }
  return achievementsOf(id);
}

/**
 * 给「浏览器扫描」条目补上名字与封面。纯同步、零 IO，可每秒调用。
 * 返回新数组，不改动原始快照对象。
 */
function decorate(items) {
  return (Array.isArray(items) ? items : []).map(x => {
    const id = String((x && (x.appid ?? x.id)) ?? '').trim();
    if (!/^\d{1,12}$/.test(id)) return x;
    const m = store[id] || {};
    const name = String((x && x.name) || m.name || '').trim();
    if (!name) queue(id);
    return Object.assign({}, x, {
      appid: id,
      name,
      cover: String((x && x.cover) || m.cover || cdnCover(id)),
      nameResolved: !!name
    });
  });
}

function queue(ids, force = false) {
  for (const raw of (Array.isArray(ids) ? ids : [ids])) {
    const id = String(raw || '').trim();
    if (!/^\d{1,12}$/.test(id)) continue;
    if (!force && store[id] && store[id].name) continue;
    if (Date.now() < (failed.get(id) || 0)) continue;
    pending.add(id);
  }
  kick();
}
function kick() {
  if (!timer) {
    timer = setInterval(() => { pump().catch(() => {}); }, 12000);
    try { timer.unref(); } catch {}
  }
  if (pending.size && !pumping && !scheduled) {
    scheduled = true;
    const t = setTimeout(() => { scheduled = false; pump().catch(() => {}); }, 1200);
    try { t.unref(); } catch {}
  }
}

/**
 * 单个 AppID 查商店公开资料。
 * 本机网络存在 TLS 中间人证书（Node 默认 CA 不信任，报 unable to verify the first certificate），
 * 因此这里对「只读公开商店资料、不携带任何凭证」的请求放宽证书校验。
 */
function fetchOne(id) {
  return new Promise(resolve => {
    const url = `${API}?appids=${id}&l=schinese&cc=cn`;
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };
    let req;
    try {
      req = https.get(url, {
        timeout: 12000,
        rejectUnauthorized: false,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'zh-CN,zh;q=0.9'
        }
      }, res => {
        let body = '';
        res.on('data', c => { body += c; if (body.length > 2000000) req.destroy(); });
        res.on('end', () => { try { done(JSON.parse(body)); } catch { done(null); } });
      });
    } catch { done(null); return; }
    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
  });
}
/** 小并发逐个查，避免批量 appids 在部分网络下被商店拒绝 */
async function fetchMeta(ids) {
  const pairs = await Promise.all(ids.map(async id => [id, await fetchOne(id)]));
  const out = {};
  let responded = false;
  for (const [id, j] of pairs) {
    if (j && typeof j === 'object' && j[id]) { responded = true; out[id] = j[id]; }
  }
  return responded ? out : null;
}

async function pump() {
  if (pumping || !pending.size) return;
  pumping = true;
  const batch = [...pending].slice(0, BATCH);
  batch.forEach(id => pending.delete(id));
  try {
    const j = await fetchMeta(batch);
    if (!j || typeof j !== 'object') {
      state.lastError = 'Steam 商店接口暂时无响应，稍后自动重试';
      batch.forEach(id => failed.set(id, Date.now() + RETRY_MS));
      return;
    }
    let ok = 0;
    for (const id of batch) {
      const d = j[id];
      if (d && d.success && d.data) {
        const name = String(d.data.name || '').trim();
        const cover = String(d.data.header_image || '').trim();
        const desc = String(d.data.short_description || '').trim();
        /* Steam 商店 appdetails 会公开成就总数和若干精选成就名。
           愿望单 / 未安装的游戏本机没有成就文件，用这些公开成就补上，
           点开游戏就能看到「有什么成就」，而不是一片空白。 */
        const ach = d.data.achievements || null;
        const achTotal = Number(ach && ach.total) || 0;
        const achList = (Array.isArray(ach && ach.highlighted) ? ach.highlighted : [])
          .slice(0, 30)
          .map(a => ({ name: String((a && a.name) || '').trim(), icon: String((a && a.path) || '').trim() }))
          .filter(a => a.name);
        if (name || cover || desc) {
          store[id] = Object.assign({}, store[id], {
            appid: id,
            name: name || store[id]?.name || '',
            cover: cover || store[id]?.cover || cdnCover(id),
            desc: desc || store[id]?.desc || '',
            achChecked: true,
            achTotal,
            achList,
            at: Date.now()
          });
          failed.delete(id);
          ok++;
        } else failed.set(id, Date.now() + RETRY_MS);
      } else failed.set(id, Date.now() + RETRY_MS);
    }
    state.resolved += ok;
    state.rounds++;
    state.lastAt = Date.now();
    state.lastError = ok ? '' : '这几个 AppID 商店暂时没有返回资料';
    if (ok) save();
  } catch (e) {
    state.lastError = String(e && e.message || e);
    batch.forEach(id => failed.set(id, Date.now() + RETRY_MS));
  } finally {
    pumping = false;
  }
}

function status() {
  return {
    cached: Object.keys(store).length,
    pending: pending.size,
    resolved: state.resolved,
    rounds: state.rounds,
    lastAt: state.lastAt,
    lastError: state.lastError
  };
}
/** 手动「重新补全」：清掉退避，把缺名字或缺官方简介的重新排队 */
function refreshAll() {
  failed.clear();
  const need = Object.keys(store).filter(id => !store[id].name || !store[id].desc);
  queue(need, true);
  kick();
  return status();
}
function start() {
  // 旧缓存可能只有名字 / 封面，启动时补一次官方简介给「玩法」用
  refreshAll();
  kick();
}

module.exports = {
  start, decorate, queue, nameOf, coverOf, descOf, cdnCover, status, refreshAll,
  achievementsOf, ensureAchievements
};
