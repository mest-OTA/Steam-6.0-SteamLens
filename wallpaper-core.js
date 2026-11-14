/**
 * SteamLens · 个性化 / 动态壁纸（小红车 Wallpaper Engine，AppID 431960）
 *
 * 能做的：
 *  1. 扫描本机 Steam 各库里 steamapps/workshop/content/431960/* 的已订阅壁纸，
 *     解析 project.json，直接把 mp4/webm 视频、HTML 网页壁纸、图片壁纸当软件背景播放。
 *  2. 接 Steam 官方公开 API ISteamRemoteStorage/GetPublishedFileDetails 读取创意工坊
 *     物品元数据，并把预览素材下载到 SteamLens 自己的 data/wallpapers/workshop/，
 *     不写进小红车目录、不改动 Steam 订阅。
 *
 * 边界（如实告诉用户）：
 *  - Scene（.pkg 场景）是 Wallpaper Engine 专有二进制格式，浏览器无法渲染，只能用预览图。
 *  - Steam 对匿名程序通常不返回 file_url（壁纸本体下载链接），因此工坊下载默认只能拿到
 *    公开预览图；完整互动壁纸需要在 Steam 客户端订阅，SteamLens 会自动从本机目录读取。
 *  - 所有文件都在本机，不上传任何数据。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const core = require('./steam-core');

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'wallpaper.json');
const DOWNLOAD_DIR = path.join(DATA_DIR, 'wallpapers', 'workshop');
/* 「我的照片壁纸」：SteamLens 自己目录下的小红车同款项目（project.json + 完整原图），
   不写进用户的 Steam 创意工坊目录。scanLocal() 会把它当成一条 local 壁纸，
   于是照片走 /api/wallpaper/media 的完整原图通道，不会被压成模糊预览图。 */
const CUSTOM_DIR = path.join(DATA_DIR, 'wallpapers', 'custom');
const META_CACHE = path.join(DATA_DIR, 'wallpaper-workshop-meta.json');
const APPID = '431960';
const STEAM_API = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';

const MIME = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mov': 'video/quicktime',
  '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf'
};
function mimeOf(f) { return MIME[path.extname(String(f || '')).toLowerCase()] || 'application/octet-stream'; }
function readJson(f, fallback) {
  try { return JSON.parse(String(fs.readFileSync(f, 'utf8')).replace(/^\uFEFF/, '')); }
  catch { return fallback; }
}
function writeJson(f, obj) {
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj, null, 2), 'utf8'); } catch { /* ignore */ }
}
function defaultConfig() {
  /* ui    = 界面不透明度（%）：0 完全透明只看壁纸，100 恢复原来的玻璃面板
     crisp = 高清壁纸模式：不压暗、不模糊、面板更透，壁纸保持原始亮度与清晰度
     customUrl = 自定义网页壁纸地址（任意网址或本地 HTML 转成的 data URL），不依赖小红车
     hiddenIds = 在「软件里删除」的壁纸（仅从列表隐藏，不碰小红车文件），重新扫描即恢复 */
  return { enabled: false, id: '', src: 'local', dim: 0, blur: 0, volume: 50, fit: 'cover', ui: 16, crisp: true, customUrl: '', hiddenIds: [] };
}
function config() {
  const c = readJson(CONFIG_FILE, {});
  return { ...defaultConfig(), ...(c && typeof c === 'object' ? c : {}) };
}
function reset() {
  const prev = config();
  const d = defaultConfig();
  /* 保留用户已选中的那款壁纸（启用状态 / ID / 来源），只把可调的设置项
     恢复成默认：界面透明度、压暗、模糊、音量、填充方式、高清模式。
     自定义网页壁纸的网址与「软件内删除」记录一并保留，不凭空消失。 */
  const next = {
    ...d,
    enabled: !!prev.enabled,
    id: String(prev.id || ''),
    src: prev.src === 'workshop' ? 'workshop' : (prev.src === 'url' ? 'url' : 'local'),
    customUrl: prev.customUrl || '',
    hiddenIds: Array.isArray(prev.hiddenIds) ? prev.hiddenIds : []
  };
  writeJson(CONFIG_FILE, next);
  return status();
}
function setConfig(patch = {}) {
  const c = config();
  const num = (v, min, max, old) => (v === undefined ? old : Math.max(min, Math.min(max, Number(v) || 0)));
  const next = {
    ...c,
    enabled: patch.enabled === undefined ? c.enabled : !!patch.enabled,
    id: patch.id === undefined ? c.id : String(patch.id || ''),
    /* 来源只能是 local（小红车本机）/ workshop（工坊下载）/ url（自定义网页），
       自定义网页必须保留 'url'，否则会被归一成 local 导致永远应用不上。 */
    src: patch.src === undefined ? c.src : (patch.src === 'workshop' ? 'workshop' : (patch.src === 'url' ? 'url' : 'local')),
    /* 只传一个字段时不能把其它设置重置掉（原来 fit 会被强制改回 cover） */
    fit: patch.fit === undefined ? c.fit : (patch.fit === 'contain' ? 'contain' : 'cover'),
    dim: num(patch.dim, 0, 80, c.dim),
    blur: num(patch.blur, 0, 20, c.blur),
    volume: num(patch.volume, 0, 100, c.volume),
    ui: num(patch.ui, 0, 100, c.ui),
    crisp: patch.crisp === undefined ? c.crisp : !!patch.crisp,
    /* 自定义网页壁纸：任意网址或本地 HTML 的 data URL，留空即清除 */
    customUrl: patch.customUrl === undefined ? (c.customUrl || '') : String(patch.customUrl || ''),
    /* 软件内隐藏的壁纸（删除）：保留已隐藏集合，除非显式覆盖 */
    hiddenIds: patch.hiddenIds === undefined
      ? (Array.isArray(c.hiddenIds) ? c.hiddenIds : [])
      : Array.isArray(patch.hiddenIds) ? patch.hiddenIds.map(String) : []
  };
  writeJson(CONFIG_FILE, next);
  return { ok: true, status: status() };
}

/* ---------------- 本机小红车目录发现 ---------------- */
function steamLibraryRoots() {
  const out = new Set();
  const add = p => { if (p) out.add(path.normalize(String(p).replace(/\//g, path.sep))); };
  try {
    for (const r of core.detectSteamRoots()) {
      add(r.path);
      try {
        const vdf = core.vdfFile(path.join(r.path, 'config', 'libraryfolders.vdf'));
        const folders = vdf.libraryfolders || vdf.LibraryFolders || {};
        for (const v of Object.values(folders)) if (v && typeof v === 'object' && v.path) add(String(v.path).replace(/\\\\/g, '\\'));
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  // 非标准安装位置：直接扫盘符下常见的 SteamLibrary / Steam
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    add(`${letter}:\\SteamLibrary`);
    add(`${letter}:\\Steam`);
  }
  const manual = String(core.getConfig().wallpaperPath || '').trim();
  if (manual) add(manual);
  return [...out];
}
function workshopDirs() {
  const dirs = [];
  for (const root of steamLibraryRoots()) {
    const p = path.join(root, 'steamapps', 'workshop', 'content', APPID);
    try { if (fs.statSync(p).isDirectory()) dirs.push(p); } catch { /* not there */ }
  }
  /* 自定义照片壁纸目录也是「小红车项目目录」：里面每个子目录都放 project.json，
     扫描逻辑与 Steam 订阅目录完全一致，只是位置在 SteamLens 自己的 data 下。 */
  try { fs.mkdirSync(CUSTOM_DIR, { recursive: true }); } catch { /* ignore */ }
  dirs.push(CUSTOM_DIR);
  return dirs;
}
function invalidate() { _cache = null; }

/* ---------------- 扫描本机壁纸 ---------------- */
function kindOf(file, type) {
  const ext = path.extname(String(file || '')).toLowerCase();
  if (['.mp4', '.webm', '.ogv', '.mov'].includes(ext)) return 'video';
  if (['.html', '.htm'].includes(ext)) return 'web';
  if (['.gif', '.jpg', '.jpeg', '.png', '.webp', '.bmp'].includes(ext)) return 'image';
  const t = String(type || '').toLowerCase();
  if (t === 'scene') return 'scene';
  return 'other';
}
function findPreview(dir, declared) {
  const names = [declared, 'preview.jpg', 'preview.png', 'preview.gif', 'preview.webp'].filter(Boolean);
  for (const n of names) {
    const p = path.join(dir, String(n));
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return '';
}
function scanLocal(force = false) {
  const dirs = workshopDirs();
  const items = [];
  for (const root of dirs) {
    let subs = [];
    try { subs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { continue; }
    for (const d of subs) {
      const dir = path.join(root, d.name);
      const pj = path.join(dir, 'project.json');
      if (!fs.existsSync(pj)) continue;
      const j = readJson(pj, null);
      if (!j) continue;
      const file = String(j.file || '');
      const main = file ? path.join(dir, file) : '';
      let size = 0;
      try { if (main && fs.existsSync(main)) size = fs.statSync(main).size; } catch { /* ignore */ }
      const kind = kindOf(file, j.type);
      const preview = findPreview(dir, j.preview);
      const playable = kind !== 'scene' && kind !== 'other' && !!main && fs.existsSync(main);
      items.push({
        id: String(j.workshopid || d.name),
        src: 'local',
        title: String(j.title || d.name),
        type: String(j.type || kind),
        kind,
        playable,
        reason: playable ? '' : (kind === 'scene'
          ? '小红车 Scene 场景（.pkg）是专有格式，网页放不了，只能用预览图当静态背景'
          : '这个壁纸格式暂时无法在网页里直接播放'),
        file, sizeMB: Math.round(size / 1048576 * 10) / 10,
        preview: preview ? path.basename(preview) : '',
        previewOk: !!preview,
        workshopUrl: String(j.workshopurl || `steam://url/CommunityFilePage/${j.workshopid || d.name}`),
        tags: Array.isArray(j.tags) ? j.tags.slice(0, 6) : [],
        description: String(j.description || '').slice(0, 160),
        dir
      });
    }
  }
  items.sort((a, b) => (b.playable - a.playable) || a.title.localeCompare(b.title, 'zh-CN'));
  return items;
}

/* ---------------- 下载到软件的工坊壁纸 ---------------- */
function scanDownloaded() {
  const out = [];
  try { fs.mkdirSync(DOWNLOAD_DIR, { recursive: true }); } catch { /* ignore */ }
  let dirs = [];
  try { dirs = fs.readdirSync(DOWNLOAD_DIR, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return out; }
  for (const d of dirs) {
    const dir = path.join(DOWNLOAD_DIR, d.name);
    const meta = readJson(path.join(dir, 'metadata.json'), null);
    if (!meta) continue;
    const media = ['preview.mp4', 'preview.webm', 'preview.gif', 'file.mp4', 'preview.jpg', 'preview.png']
      .find(n => fs.existsSync(path.join(dir, n))) || '';
    const kind = media ? kindOf(media, '') : 'image';
    out.push({
      id: String(meta.id || d.name), src: 'workshop',
      title: String(meta.title || ('工坊物品 ' + d.name)),
      type: 'workshop', kind: kind === 'other' ? 'image' : kind,
      playable: !!media,
      reason: meta.note || '',
      file: media, sizeMB: 0,
      preview: fs.existsSync(path.join(dir, 'preview.jpg')) ? 'preview.jpg' : media,
      previewOk: media !== '',
      workshopUrl: `https://steamcommunity.com/sharedfiles/filedetails/?id=${meta.id || d.name}`,
      tags: Array.isArray(meta.tags) ? meta.tags.slice(0, 6) : [],
      description: String(meta.description || '').slice(0, 160),
      subscriptions: Number(meta.subscriptions || 0),
      author: String(meta.author || ''),
      downloadedAt: String(meta.downloadedAt || ''),
      dir
    });
  }
  return out;
}

let _cache = null;
function allItems(force = false) {
  if (!force && _cache && Date.now() - _cache.at < 30000) return _cache.list;
  const list = [...scanLocal(force), ...scanDownloaded()];
  _cache = { at: Date.now(), list };
  return list;
}
function findItem(id, src) {
  return allItems().find(x => String(x.id) === String(id) && (!src || x.src === src))
    || allItems().find(x => String(x.id) === String(id));
}
function hideKey(id, src) { return String(id) + ':' + (src || 'local'); }
/* 「软件内删除」：只在软件列表里隐藏，不触碰小红车目录里的文件；重新扫描会恢复 */
function hideWallpaper(id, src) {
  const c = config();
  const set = new Set(Array.isArray(c.hiddenIds) ? c.hiddenIds : []);
  set.add(hideKey(id, src));
  const patch = { hiddenIds: [...set] };
  // 删掉当前正在用的那款，顺手把壁纸关掉
  if (String(c.id) === String(id) && (c.src || 'local') === (src || 'local')) patch.enabled = false;
  writeJson(CONFIG_FILE, { ...c, ...patch });
  _cache = null;
  return { ok: true, status: status(true) };
}
function status(force = false) {
  const hidden = new Set((config().hiddenIds || []));
  const items = allItems(force).filter(it => !hidden.has(hideKey(it.id, it.src)));
  const local = items.filter(x => x.src === 'local');
  const downloaded = items.filter(x => x.src === 'workshop');
  const c = config();
  const current = c.id ? findItem(c.id, c.src) : null;
  return {
    ok: true,
    dirs: workshopDirs(),
    downloadDir: DOWNLOAD_DIR,
    items, localCount: local.length, downloadedCount: downloaded.length,
    playableCount: items.filter(x => x.playable).length,
    sceneCount: items.filter(x => x.kind === 'scene').length,
    config: c, current: current ? { id: current.id, title: current.title, kind: current.kind, src: current.src } : null,
    note: 'Scene（.pkg）是小红车专有格式，网页无法渲染；Steam 不向匿名程序开放壁纸本体下载时，只能下载工坊预览图，完整壁纸请在 Steam 里订阅后点「重新扫描」。'
  };
}
/* 重新扫描本机小红车：清掉「软件内删除」记录，让被删的壁纸重新加载回来 */
function rescan() {
  const c = config();
  if (Array.isArray(c.hiddenIds) && c.hiddenIds.length) {
    writeJson(CONFIG_FILE, { ...c, hiddenIds: [] });
  }
  _cache = null;
  return { ok: true, status: status(true) };
}

/* ---------------- 文件服务（含 Range，视频拖动 / 循环必需） ---------------- */
function safeJoin(dir, rel) {
  const target = path.resolve(dir, String(rel || '').replace(/^[/\\]+/, ''));
  const base = path.resolve(dir);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}
function fileFor(id, src, which, rel) {
  const it = findItem(id, src);
  if (!it) return null;
  if (which === 'asset') return safeJoin(it.dir, rel || it.file || 'index.html');
  if (which === 'preview') return safeJoin(it.dir, it.preview || '');
  if (it.kind === 'scene' || !it.playable) return safeJoin(it.dir, it.preview || '');
  return safeJoin(it.dir, it.file || '');
}
function serveFile(req, res, file) {
  if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  let stat;
  try { stat = fs.statSync(file); } catch { res.writeHead(404); res.end(); return; }
  const type = mimeOf(file);
  const head = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=3600' };
  const range = String(req.headers.range || '');
  const m = /^bytes=(\d*)-(\d*)/.exec(range);
  if (m) {
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (isNaN(start) || start < 0 || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
    if (isNaN(end) || end >= stat.size) end = stat.size - 1;
    if (end < start) end = start;
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...head, 'Content-Length': stat.size });
    fs.createReadStream(file).pipe(res);
  }
}
function htmlIndexUrl(id, src, it) {
  return `/api/wallpaper/html/${encodeURIComponent(id)}/${src}/${encodeURIComponent(it.file || 'index.html')}`;
}

/* ---------------- Steam 创意工坊公开 API ---------------- */
function httpsRequest(url, opts = {}, body = null) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = https.request(url, {
        method: opts.method || 'GET', timeout: opts.timeout || 12000,
        rejectUnauthorized: false,   // 本机有 TLS 中间人证书；只读公开请求、不带任何凭证
        headers: {
          'User-Agent': 'SteamLens/1.0 (local, read-only)',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          ...(opts.headers || {})
        }
      }, res => {
        // 二进制下载走流式，不把图片/视频攒成字符串
        const done = opts.wantText === false ? Promise.resolve('')
          : new Promise(ok => { let s = ''; res.on('data', c => { s += c; if (s.length > 4000000) req.destroy(); }); res.on('end', () => ok(s)); });
        resolve({ res, done });
      });
    } catch (e) { reject(e); return; }
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
    req.end(body);
  });
}
async function steamApi(ids) {
  const list = [...new Set(ids.map(String).filter(x => /^\d{5,20}$/.test(x)))].slice(0, 50);
  if (!list.length) return [];
  const form = ['itemcount=' + list.length, ...list.map((id, i) => `publishedfileids%5B${i}%5D=${id}`)].join('&');
  const { res, done } = await httpsRequest(STEAM_API, {
    method: 'POST', timeout: 15000,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) }
  }, form);
  const text = await done;
  if (res.statusCode !== 200) throw new Error('Steam API HTTP ' + res.statusCode);
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('Steam API 返回的不是 JSON'); }
  const arr = j?.response?.publishedfiledetails || [];
  return arr.filter(d => d && d.publishedfileid && d.result !== 9).map(d => ({
    id: String(d.publishedfileid), title: String(d.title || ('工坊物品 ' + d.publishedfileid)),
    description: String(d.description || '').slice(0, 300),
    author: String(d.creator || ''), authorName: '',
    subscriptions: Number(d.subscriptions || d.lifetime_subscriptions || 0),
    favorited: Number(d.favorited || d.lifetime_favorited || 0), views: Number(d.views || 0),
    previewUrl: String(d.preview_url || ''), fileUrl: String(d.file_url || ''),
    fileSize: Number(d.file_size || 0), filename: String(d.filename || ''),
    timeCreated: Number(d.time_created || 0), timeUpdated: Number(d.time_updated || 0),
    tags: (Array.isArray(d.tags) ? d.tags : []).map(t => String(t.tag || t)).slice(0, 8)
  }));
}
async function workshopDetails(raw) {
  const ids = Array.isArray(raw) ? raw : String(raw || '').match(/\d{5,20}/g) || [];
  return await steamApi(ids);
}
function downloadUrl(url, dest, redirects = 0) {
  return new Promise(async (resolve) => {
    if (redirects > 4) { resolve({ ok: false, reason: '重定向过多' }); return; }
    let r;
    try { r = await httpsRequest(url, { timeout: 20000, wantText: false }); }
    catch (e) { resolve({ ok: false, reason: e.message }); return; }
    const { res } = r;
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      const next = new URL(res.headers.location, url).toString();
      res.resume();
      resolve(await downloadUrl(next, dest, redirects + 1)); return;
    }
    if (res.statusCode !== 200) { res.resume(); resolve({ ok: false, reason: 'HTTP ' + res.statusCode }); return; }
    try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch (e) { res.resume(); resolve({ ok: false, reason: e.message }); return; }
    const ws = fs.createWriteStream(dest);
    let bytes = 0;
    res.on('data', c => { bytes += c.length; });
    res.pipe(ws);
    ws.on('finish', () => resolve({ ok: true, bytes }));
    ws.on('error', e => resolve({ ok: false, reason: e.message }));
  });
}
async function downloadWorkshop(rawId) {
  const id = (String(rawId || '').match(/\d{5,20}/) || [])[0];
  if (!id) return { ok: false, error: '工坊 ID 不对，请粘贴链接或纯数字 ID' };
  let details;
  try { details = (await workshopDetails([id]))[0]; }
  catch (e) { return { ok: false, error: '读取创意工坊失败：' + e.message }; }
  if (!details) return { ok: false, error: 'Steam 没找到这个工坊物品（可能已下架或设为私密）' };

  const cache = readJson(META_CACHE, {});
  cache[id] = details; writeJson(META_CACHE, cache);

  const dir = path.join(DOWNLOAD_DIR, id);
  let note = '';
  let gotBody = false;
  if (details.fileUrl && details.fileSize > 0 && details.fileSize <= 250 * 1024 * 1024) {
    const ext = path.extname(details.filename).toLowerCase();
    const dest = path.join(dir, ['mp4', 'webm', 'gif', 'jpg', 'png', 'zip'].some(x => ext === '.' + x) ? ('file' + ext) : 'file.bin');
    const r = await downloadUrl(details.fileUrl, dest);
    gotBody = !!r.ok;
    if (!gotBody) note = 'Steam 提供了本体链接但下载失败：' + r.reason;
  } else {
    note = 'Steam 不向匿名程序开放这个壁纸的本体下载（file_url 为空）。已把工坊预览图下载到 SteamLens；想要完整互动壁纸，请在 Steam 里订阅，再回来点「↻ 重新扫描本机小红车」，SteamLens 会自动从本机目录读取。';
  }
  let previewOk = false;
  if (details.previewUrl) {
    const r = await downloadUrl(details.previewUrl, path.join(dir, 'preview.jpg'));
    previewOk = !!r.ok;
  }
  writeJson(path.join(dir, 'metadata.json'), {
    id, title: details.title, description: details.description, author: details.author,
    subscriptions: details.subscriptions, tags: details.tags,
    previewUrl: details.previewUrl, fileUrl: details.fileUrl, gotBody,
    note, downloadedAt: new Date().toLocaleString('zh-CN', { hour12: false })
  });
  _cache = null;
  return {
    ok: previewOk || gotBody, id, title: details.title,
    gotBody, previewOk, note, status: status(true)
  };
}

module.exports = {
  status, rescan, setConfig, reset, config, findItem, fileFor, serveFile,
  workshopDetails, downloadWorkshop, mimeOf, htmlIndexUrl, hideWallpaper,
  invalidate,
  DOWNLOAD_DIR, CUSTOM_DIR, APPID
};
