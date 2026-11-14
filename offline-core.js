/**
 * SteamLens · 离线模式内核（零第三方依赖）
 *
 * 用户诉求：服务器关掉之后软件还能用；所有数据都存在自己的电脑上；
 *           服务器重新打开后，把离线期间产生的数据自动合并回在线版。
 *
 * 做法：
 *  1. 在线时，服务端把「全量快照」写成两个本机文件：
 *       assets/offline-data.js   → window.SL_OFFLINE_DATA = {...}（给 file:// 直接双击的页面读，绕开 CORS）
 *       data/offline-snapshot.json → 结构化备份，可导出/导入
 *  2. 离线页面（file:// 双击 index.html）用这份快照完整渲染，操作写入浏览器 localStorage 队列。
 *  3. 服务器恢复后，前端自动把队列 POST 到 /api/offline/sync，由本模块按白名单合并回
 *     config.json / ui-settings.json / overrides / hidden / 好友名册 / 离线笔记。
 *  4. 双写 localStorage：在线时前端也把同一份快照存到浏览器，离线页面可用它兜底。
 *
 * 边界：不上传任何数据到外部；凭证（API Key / 授权码 / 推送 Key）不写进离线 JS 文件，
 *       只保留「是否已配置」的布尔标记，避免明文散落在可直接打开的 HTML 目录里。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const core = require('./steam-core');
const settings = require('./settings-core');
const hidden = require('./hidden-core');
const friends = require('./friends-core');
const accountLink = require('./account-link-core');
const notify = require('./notify-core');
const gameDetail = require('./game-detail-core');
const friendAchievement = require('./friend-achievement-core');
const watchlist = require('./watchlist-core');
const updateCore = require('./update-core');
const smsMod = require('./sms-core');
const wallpaperMod = require('./wallpaper-core');
const pcSpecMod = require('./pc-spec-core');        // 本机硬件配置（导出离线版时一并打包）

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const JS_FILE = path.join(ROOT, 'assets', 'offline-data.js');
/* 完全自包含的单文件离线版：CSS / JS / 快照 / 二维码全部内联，双击必开 */
const STANDALONE_FILE = path.join(ROOT, 'SteamLens-Offline.html');
/* 离线壁纸包：单文件 HTML 装不下几 GB 视频，所以把壁纸文件复制到一个文件夹里，
   HTML 用相对路径引用。整个文件夹拷走即可在别的电脑双击使用全部动态壁纸。 */
const PACK_DIR = path.join(ROOT, 'SteamLens-离线版');
const PACK_HTML = path.join(PACK_DIR, 'SteamLens-Offline.html');
const WP_DIR = path.join(PACK_DIR, 'wallpapers');
const SNAP_FILE = path.join(DATA_DIR, 'offline-snapshot.json');
const NOTES_FILE = path.join(DATA_DIR, 'offline-notes.json');
const SYNC_FILE = path.join(DATA_DIR, 'offline-sync-log.json');

let lastSnapshot = null;
let lastWriteAt = 0;
let writing = false;
let syncCount = 0;

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  try { fs.renameSync(tmp, file); }
  catch { fs.copyFileSync(tmp, file); try { fs.unlinkSync(tmp); } catch {} }
}

/* 只保留非敏感字段，凭证一律不出现在可被双击打开的 JS 里 */
function safeConfig(c) {
  const secret = /(apikey|authcode|password|secret|token|pastedown|wechatkey|qqkey|mailauth|authcode|smsphone|smswebhook|smstoken)/i;
  const out = {};
  for (const [k, v] of Object.entries(c || {})) {
    if (secret.test(k)) { out[k] = v ? '••已配置••' : ''; continue; }
    out[k] = v;
  }
  return out;
}

/**
 * 写入全量本机快照。
 * @param {object} parts { state, friends, account, notify, mail, wishlist, browser, hidden, wechat, qq, autorefresh, steamInfo }
 */
function writeSnapshot(parts = {}) {
  if (writing) return lastSnapshot;
  writing = true;
  try {
    const now = Date.now();
    /* ★ 服务重启后内存里的 lastSnapshot 是空的；定时重写快照若只看内存，会把
       「离线壁纸完整媒体清单」清成 null，离线单文件就只能退回模糊预览图。
       这里先从磁盘快照兜底，保证打包好的完整视频 / 网页壁纸路径不会被抹掉。 */
    let prev = lastSnapshot;
    if (!prev) { try { prev = JSON.parse(fs.readFileSync(SNAP_FILE, 'utf8')); } catch { prev = null; } }
    /* 服务端 saveListCache 落盘的是 {version,at,count,data:{friends:[...]}}，
       而前端 friendCacheRead() 只认顶层 friends 数组。这里统一拆掉外壳，
       否则离线单文件打开时永远读不到缓存好友。 */
    const rawFc = parts.friendListCache || friends.listCache() || prev?.friendListCache || null;
    const friendListCache = Array.isArray(rawFc?.friends) ? rawFc
      : (Array.isArray(rawFc?.data?.friends) ? rawFc.data : null);
    const cfg = core.getConfig();
    const snap = {
      app: 'SteamLens',
      version: 3,
      generatedAt: now,
      generatedAtIso: new Date(now).toISOString(),
      root: ROOT,
      offlineCapable: true,
      config: safeConfig(cfg),
      hidden: hidden.status(),
      friendsMeta: friends.getMeta(),
      /* 关闭软件时保存的好友列表：离线单文件打开即可显示，不用等 Steam 重新拉取 */
      friendListCache,
      state: parts.state || lastSnapshot?.state || null,
      friends: parts.friends || lastSnapshot?.friends || null,
      account: parts.account || lastSnapshot?.account || null,
      notify: parts.notify || lastSnapshot?.notify || null,
      mail: parts.mail || lastSnapshot?.mail || null,
      wishlist: parts.wishlist || lastSnapshot?.wishlist || null,
      browser: parts.browser || lastSnapshot?.browser || null,
      wechat: parts.wechat || lastSnapshot?.wechat || null,
      qq: parts.qq || lastSnapshot?.qq || null,
      dingtalk: parts.dingtalk || lastSnapshot?.dingtalk || null,
      autorefresh: parts.autorefresh || lastSnapshot?.autorefresh || null,
      steamInfo: parts.steamInfo || lastSnapshot?.steamInfo || null,
      friendProfiles: parts.friendProfiles || lastSnapshot?.friendProfiles || null,
      friendLibraries: parts.friendLibraries || lastSnapshot?.friendLibraries || null,
      accountLink: parts.accountLink || lastSnapshot?.accountLink || accountLink.status(),
      accountLogins: parts.accountLogins || lastSnapshot?.accountLogins || accountLink.logins().logins,
      notifyOutbox: parts.notifyOutbox || notify.getOutbox(),
      // 游戏详情缓存：每次都读实时目录，删掉某款后快照里也会同步消失
      gameDetails: parts.gameDetails || gameDetail.allCached(),
      /* 本机硬件配置：离线版导出时打包进去，离线打开也能做「我的配置 vs 需求」对比
         （标注「导出时捕获」；在线版点「重新检测」会用实时数据覆盖） */
      pcSpecs: parts.pcSpecs || pcSpecMod.getCached() || lastSnapshot?.pcSpecs || null,
      // 好友成就与好友关系链：同样读实时缓存，离线版也能看到 Steam 上抓到的好友成就
      friendAchievements: parts.friendAchievements || friendAchievement.snapshot(),
      discoveredFriends: parts.discoveredFriends || friendAchievement.discovered(),
      // 愿望单监控：清单、价格、提醒记录，离线版同样能看
      watchStatus: parts.watchStatus || watchlist.snapshot(),
      // 更新日志：离线版也能看到精确到秒的每条更新记录
      updateLog: parts.updateLog || updateCore.status(),
      /* 「QQ 登录 · 自己发自己」已移除：离线快照不再保存任何 QQ 直登状态 */
      /* 短信 / 动态壁纸每次生成快照都读实时状态，离线版不会拿到过期的开关和透明度 */
      sms: parts.sms || smsMod.status(),
      wallpaper: parts.wallpaper || wallpaperMod.status(),
      /* 离线壁纸资源：相对路径清单 / 内联预览图 / 打包统计（由 buildWallpaperPack 生成） */
      wallpaperMedia: parts.wallpaperMedia || prev?.wallpaperMedia || null,
      wallpaperInline: parts.wallpaperInline || prev?.wallpaperInline || null,
      wallpaperPack: parts.wallpaperPack || prev?.wallpaperPack || null,
      steamClient: parts.steamClient || lastSnapshot?.steamClient || null,
      uiSettings: parts.uiSettings || settings.get(),
      notes: readNotes()
    };
    lastSnapshot = snap;
    lastWriteAt = now;
    const text = JSON.stringify(snap);
    atomicWrite(SNAP_FILE, JSON.stringify(snap, null, 2));
    // 用 JS 赋值而非 JSON 文件：file:// 页面用 <script src> 就能读到，不受 CORS 限制
    atomicWrite(JS_FILE, '/* SteamLens 本机离线快照：由服务自动生成，请勿手改 */\n'
      + 'window.SL_OFFLINE_DATA = ' + text + ';\n'
      + 'window.SL_OFFLINE_DATA_READY = true;\n');
    try { writeStandalone(STANDALONE_FILE, 'SteamLens-离线版/'); }
    catch (e) { console.error('[SteamLens 单文件离线版生成失败]', e.message); }
    return snap;
  } finally { writing = false; }
}

/**
 * 生成「完全自包含」的单文件离线版：把 index.html / CSS / 三个 JS / 全部二维码图片
 * 内联进一个 HTML。这样双击时不再依赖 assets/ 目录、相对路径、中文 bat 名或浏览器
 * 对 file:// 外部脚本的限制，服务器关掉也能完整打开。
 */
function inlineImages() {
  const dir = path.join(ROOT, 'assets');
  const out = {};
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const f of names) {
    const m = f.match(/\.(png|jpe?g|gif|webp|svg)$/i);
    if (!m) continue;
    const ext = m[1].toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : ext === 'svg' ? 'image/svg+xml' : `image/${ext}`;
    try {
      out['assets/' + f] = `data:${mime};base64,${fs.readFileSync(path.join(dir, f)).toString('base64')}`;
    } catch {}
  }
  return out;
}
function writeStandalone(dest, base) {
  const out = dest || STANDALONE_FILE;
  /* 根目录单文件的壁纸资源在子文件夹里；包内 HTML 与 wallpapers 同级，基址为空 */
  const wpBase = base === undefined ? 'SteamLens-离线版/' : base;
  const images = inlineImages();
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'assets', 'style.css'), 'utf8');
  // ★ 必须用函数式 replace：源码里的 $$ / $& / $' 在字符串替换里会被当成替换语法吃掉，
  //   之前就是 app.js 的 `const $$ = ...` 被改成了 `const $ = ...`，导致整段脚本语法错误、页面白屏。
  const put = (from, to) => { html = html.replace(from, () => to); };
  put('<link rel="stylesheet" href="assets/style.css">', `<style>\n${css}\n</style>`);
  for (const f of ['offline-data.js', 'offline.js', 'app.js']) {
    const code = String(fs.readFileSync(path.join(ROOT, 'assets', f), 'utf8'))
      .replace(/<\/script/gi, '<\\/script');
    put(`<script src="assets/${f}"></script>`, `<script>\n${code}\n</script>`);
  }
  for (const [k, v] of Object.entries(images)) html = html.split(`src="${k}"`).join(`src="${v}"`);
  put('</head>', `<script>window.SL_INLINE_IMAGES=${JSON.stringify(images)};window.SL_WP_BASE=${JSON.stringify(wpBase)};</script>\n</head>`);
  put('<body', '<body data-sl-standalone="1"');
  atomicWrite(out, html);
  return { file: out, bytes: Buffer.byteLength(html), images: Object.keys(images).length };
}

/* ---------------- 离线壁纸资源打包 ----------------
   81 款壁纸的主媒体合计 5.6 GB，无法塞进单个 HTML。这里把文件「下载 / 复制」
   到 SteamLens-离线版/wallpapers/，HTML 用相对路径引用；整个文件夹拷走即可在
   别的电脑双击使用。默认策略：
     · 所有预览图都带（约 60 MB，列表与降级显示用）
     · 当前正在使用的那款完整带（哪怕 300 MB，保证打开就是动态壁纸）
     · ≤12 MB 的小壁纸全部带
     · 其余大视频只带预览图，离线切换时降级成静态图
     · full=true 时全部带（约 5.6 GB，需足够磁盘）                        */
function wpKey(id, src) {
  const a = String(id || '').replace(/[^0-9A-Za-z_-]/g, '_').slice(0, 60);
  const b = String(src || 'local').replace(/[^0-9A-Za-z_-]/g, '_').slice(0, 20);
  return a + '_' + b;
}
function copyIfNeeded(srcFile, destFile) {
  if (!srcFile) return 0;
  let size = 0;
  try { size = fs.statSync(srcFile).size; } catch { return 0; }
  if (!size) return 0;
  try { if (fs.statSync(destFile).size === size) return size; } catch {}
  try { fs.mkdirSync(path.dirname(destFile), { recursive: true }); fs.copyFileSync(srcFile, destFile); } catch {}
  return size;
}
/* 递归复制整个目录（网页壁纸要用它自带的 js/css/图片）。
   不用 fs.cpSync：Windows 上遇到个别文件会整体抛错，导致整个网页壁纸被跳过。
   这里逐文件复制，单个文件失败只记数，不影响其它文件。 */
function copyTree(srcDir, destDir, maxFile, counter, keep) {
  const must = keep instanceof Set ? keep : new Set();
  const walk = (s, d) => {
    let ents = [];
    try { ents = fs.readdirSync(s, { withFileTypes: true }); } catch { return; }
    try { fs.mkdirSync(d, { recursive: true }); } catch {}
    for (const e of ents) {
      const sp = path.join(s, e.name), dp = path.join(d, e.name);
      if (e.isDirectory()) { walk(sp, dp); continue; }
      if (!e.isFile()) continue;
      let size = 0;
      try { size = fs.statSync(sp).size; } catch { continue; }
      /* 入口 HTML 必须带走（有的壁纸把资源全内联，index.html 本身就有十几 MB） */
      if (maxFile && size > maxFile && !must.has(sp)) continue;
      try {
        let same = false;
        try { same = fs.statSync(dp).size === size; } catch {}
        if (!same) fs.copyFileSync(sp, dp);
        if (counter) { counter.bytes += size; counter.files++; }
      } catch { if (counter) counter.failed++; }
    }
  };
  walk(srcDir, destDir);
  return counter;
}
const WP_BUDGET = 1200 * 1048576;   // 默认总预算约 1.2 GB：优先带体积小的视频，保证离线真的能放
function buildWallpaperPack(opts = {}) {
  const full = opts.full === true || opts.full === 1 || opts.full === '1';
  const budget = full ? Infinity : (Number(opts.budgetMB) > 0 ? Number(opts.budgetMB) * 1048576 : WP_BUDGET);
  const st = wallpaperMod.status(true);
  const cfg = st.config || {};
  const items = st.items || [];
  const curKey = cfg.id ? wpKey(cfg.id, cfg.src) : '';
  const map = {}, inline = {};
  const stats = {
    ok: true, full, items: 0, fullMedia: 0, previewOnly: 0, webDirs: 0,
    packedBytes: 0, packDir: PACK_DIR, budgetMB: full ? 0 : Math.round(budget / 1048576), generatedAt: Date.now()
  };
  fs.mkdirSync(WP_DIR, { recursive: true });

  /* ① 先量出每款主媒体的大小，按「从小到大」装进预算：这样离线能放几十款，
        而不是一款都放不下（视频最小也有 14 MB，用固定阈值会全被排除） */
  const info = new Map();
  for (const it of items) {
    const key = wpKey(it.id, it.src);
    const mainAbs = wallpaperMod.fileFor(it.id, it.src, 'media');
    let size = 0;
    try { if (mainAbs) size = fs.statSync(mainAbs).size; } catch {}
    info.set(key, { mainAbs, size });
  }
  const include = new Set();
  if (curKey) include.add(curKey);        // 当前在用的那款必须完整带
  let used = 0;
  const cand = items
    .filter(it => { const k = wpKey(it.id, it.src); return k !== curKey && it.kind !== 'scene' && it.playable; })
    .sort((a, b) => info.get(wpKey(a.id, a.src)).size - info.get(wpKey(b.id, b.src)).size);
  for (const it of cand) {
    const key = wpKey(it.id, it.src);
    if (it.kind === 'web') { include.add(key); continue; }   // 网页壁纸普遍很小，整目录都带
    const sz = info.get(key).size;
    if (!sz) { include.add(key); continue; }
    if (used + sz > budget) continue;
    include.add(key); used += sz;
  }

  for (const it of items) {
    const key = wpKey(it.id, it.src);
    const dest = path.join(WP_DIR, key);
    const entry = { key, kind: it.kind, id: String(it.id), src: it.src };
    const isCur = key === curKey;
    try { fs.mkdirSync(dest, { recursive: true }); } catch {}

    // 1) 预览图：全部带走；当前款额外内联进 HTML（单文件双击也能看到图）
    const prevAbs = wallpaperMod.fileFor(it.id, it.src, 'preview');
    if (prevAbs && fs.existsSync(prevAbs)) {
      const name = 'sl-preview' + path.extname(prevAbs).toLowerCase();
      entry.previewBytes = copyIfNeeded(prevAbs, path.join(dest, name));
      stats.packedBytes += entry.previewBytes;
      entry.preview = 'wallpapers/' + key + '/' + name;
      if (isCur) {
        try {
          const b = fs.readFileSync(prevAbs);
          inline[key] = { preview: 'data:' + wallpaperMod.mimeOf(prevAbs) + ';base64,' + b.toString('base64') };
        } catch {}
      }
    }

    // 2) 主媒体：当前款 / 预算内 / full 才完整带走
    const mainAbs = info.get(key) ? info.get(key).mainAbs : null;
    const canFull = full || isCur || include.has(key);
    if (mainAbs && fs.existsSync(mainAbs) && it.kind !== 'scene' && it.playable && canFull) {
      if (it.kind === 'web') {
        // 网页壁纸要把整目录（HTML 依赖的 js/css/图片）一起带，否则页面会花屏
        const c = { bytes: 0, files: 0, failed: 0 };
        copyTree(it.dir, dest, (full || isCur) ? 0 : 8 * 1048576, c, new Set([mainAbs]));
        stats.packedBytes += c.bytes;
        stats.webFiles = (stats.webFiles || 0) + c.files;
        if (c.failed) stats.copyFailed = (stats.copyFailed || 0) + c.failed;
        stats.webDirs++;
        entry.media = 'wallpapers/' + key + '/' + String(path.relative(it.dir, mainAbs)).replace(/\\/g, '/');
        entry.webDir = true;
      } else {
        const name = 'sl-media' + path.extname(mainAbs).toLowerCase();
        entry.mediaBytes = copyIfNeeded(mainAbs, path.join(dest, name));
        stats.packedBytes += entry.mediaBytes;
        entry.media = 'wallpapers/' + key + '/' + name;
      }
      stats.fullMedia++;
    } else {
      entry.previewOnly = true;
      stats.previewOnly++;
      /* 之前打包过、现在不在预算里的主媒体要清掉，避免文件夹越滚越大 */
      try {
        for (const f of fs.readdirSync(dest)) {
          if (/^sl-media\./i.test(f)) fs.unlinkSync(path.join(dest, f));
        }
      } catch {}
    }
    map[key] = entry;
    stats.items++;
  }

  stats.packedMB = Math.round(stats.packedBytes / 1048576 * 10) / 10;
  // 把资源清单写进快照，并生成两份 HTML：根目录单文件 + 壁纸包内单文件
  writeSnapshot({ wallpaperMedia: map, wallpaperInline: inline, wallpaperPack: stats });
  writeStandalone(PACK_HTML, '');
  writeStandalone(STANDALONE_FILE, 'SteamLens-离线版/');
  return stats;
}

function readNotes() {
  try { const a = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8')); return Array.isArray(a) ? a.slice(-100) : []; }
  catch { return []; }
}
function addNote(text, source = '离线记录') {
  const notes = readNotes();
  notes.push({ ts: Date.now(), iso: new Date().toISOString(), text: String(text || '').slice(0, 2000), source });
  if (notes.length > 300) notes.splice(0, notes.length - 300);
  atomicWrite(NOTES_FILE, JSON.stringify(notes, null, 2));
  return notes.slice(-20);
}

/* ------------------------------ 离线变更合并 ------------------------------ */
/* 前端离线时把每条 POST 记成 { path, body, ts }，恢复后一次性提交。
   这里按白名单映射到真实模块，绝不执行任意路径（避免被当成开放代理）。 */
const ALLOWED_CONFIG_KEYS = new Set([
  'mode', 'steamPath', 'steamId64', 'includeFreeGames', 'maskPrivateNames',
  'autoEstimateValue', 'valueRefreshHours', 'librarySyncHours', 'includeUnverifiedInValue',
  'excludeDemosFromValue', 'theme', 'snapshotMinInterval', 'friendPollSec', 'friendNotify',
  'friendNotifyOffline',
  'friendLoadRemoteAvatars', 'notifyDesktop', 'notifySound', 'notifyScope',
  'notifyWebhookUrl', 'notifyWebhookType', 'notifyMinIntervalSec',
  'mailEnabled', 'mailHost', 'mailPort', 'mailUser', 'mailTo',
  'mailOnOnline', 'mailOnOffline', 'mailOnGame', 'mailMinIntervalSec', 'mailQuiet', 'mailSubjectPrefix',
  'wishlistThresholdYuan', 'wishlistNotifyEnabled', 'wishlistAlertMinIntervalSec', 'wishlistCheckHours',
  'wechatChannel', 'wechatEnabled', 'wechatOnOnline', 'wechatOnOffline', 'wechatOnWishlist', 'wechatMinIntervalSec',
  'qqChannel', 'qqUin', 'qqEndpoint', 'qqEnabled', 'qqOnOnline', 'qqOnOffline', 'qqOnWishlist', 'qqMinIntervalSec',
  'dingtalkEnabled', 'dingtalkWebhook', 'dingtalkSecret', 'dingtalkKeyword',
  'dingtalkOnOnline', 'dingtalkOnOffline', 'dingtalkOnWishlist', 'dingtalkMinIntervalSec',
  'hiddenAutoSync', 'hiddenSyncSec'
]);

function applyOne(op) {
  const p = String(op?.path || '');
  const b = op?.body && typeof op.body === 'object' ? op.body : {};
  if (p === '/api/ui-settings') { settings.patch(b); return '界面设置已合并'; }
  if (p === '/api/config') {
    const clean = {};
    for (const [k, v] of Object.entries(b)) if (ALLOWED_CONFIG_KEYS.has(k)) clean[k] = v;
    if (Object.keys(clean).length) core.saveConfig(clean);
    return `配置已合并 ${Object.keys(clean).length} 项`;
  }
  if (p === '/api/override' && b.appid) {
    const allowed = ['name', 'playtimeMin', 'priceCents', 'markedPrivate', 'hiddenBySteam', 'targetHours'];
    const patch = {};
    for (const k of allowed) if (b[k] !== undefined) patch[k] = b[k];
    core.saveOverride(String(b.appid), patch);
    if (patch.hiddenBySteam === false) hidden.remove(String(b.appid));
    else if (patch.hiddenBySteam === true) hidden.addManual(String(b.appid));
    return `游戏 ${b.appid} 的离线编辑已合并`;
  }
  if (p === '/api/hidden/config') { hidden.saveConfig(b); return '隐藏识别开关已合并'; }
  if (p === '/api/hidden/remove' && b.appid) { hidden.remove(b.appid); return '隐藏移除已合并'; }
  if (p === '/api/hidden/restore') { hidden.restore(); return '隐藏识别已重置'; }
  if (p === '/api/friends/star' && b.steamId64) { friends.setStar(b.steamId64, !!b.starred); return '好友关注已合并'; }
  if (p === '/api/friends/add' && b.steamId64) { friends.addManual(b.steamId64, b.name || ''); return '手动好友已合并'; }
  if (p === '/api/offline/note' && b.text) { addNote(b.text, b.source || '离线记录'); return '离线笔记已保存'; }
  // 动态壁纸：离线期间选的壁纸 / 调的滑块 / 软件内删除，服务恢复后合并回在线版
  if (p === '/api/wallpaper/config') { wallpaperMod.setConfig(b); return '动态壁纸设置已合并'; }
  if (p === '/api/wallpaper/hide' && b.id) { wallpaperMod.hideWallpaper(b.id, b.src); return '壁纸删除记录已合并'; }
  // 开关类配置端点：字段名与 /api/config 一致，统一合并到 config.json
  const CONFIG_ENDPOINTS = new Set([
    '/api/friends/config', '/api/notify/config', '/api/wishlist/config',
    '/api/wechat/config', '/api/qq/config', '/api/dingtalk/config', '/api/mail/config'
  ]);
  if (CONFIG_ENDPOINTS.has(p)) {
    const clean = {};
    for (const [k, v] of Object.entries(b)) if (ALLOWED_CONFIG_KEYS.has(k)) clean[k] = v;
    if (Object.keys(clean).length) { core.saveConfig(clean); return `${p} 已合并 ${Object.keys(clean).length} 项`; }
    return `${p} 无可合并字段（凭证只在在线时提交）`;
  }
  return null; // 不支持的路径直接丢弃，不报错、不中断其它条目
}

function sync(payload = {}) {
  const ops = Array.isArray(payload.changes) ? payload.changes.slice(0, 500) : [];
  const applied = [], skipped = [];
  for (const op of ops) {
    try { const r = applyOne(op); if (r) applied.push(r); else skipped.push(op?.path || '未知操作'); }
    catch (e) { skipped.push(`${op?.path || '?'}: ${e.message}`); }
  }
  if (payload.settings && typeof payload.settings === 'object') settings.patch(payload.settings);
  if (Array.isArray(payload.notes)) for (const n of payload.notes.slice(0, 100)) {
    if (n && n.text) addNote(n.text, n.source || '离线记录');
  }
  syncCount++;
  const rec = {
    ts: Date.now(), iso: new Date().toISOString(),
    received: ops.length, applied: applied.length, skipped: skipped.length,
    clientId: String(payload.clientId || '').slice(0, 64),
    offlineSince: payload.offlineSince || null
  };
  let log = [];
  try { log = JSON.parse(fs.readFileSync(SYNC_FILE, 'utf8')); if (!Array.isArray(log)) log = []; } catch {}
  log.unshift(rec); log = log.slice(0, 50);
  atomicWrite(SYNC_FILE, JSON.stringify(log, null, 2));
  // 合并后立刻刷新本机快照，保证离线文件也是最新的
  if (applied.length) writeSnapshot({});
  return { ok: true, ...rec, details: applied.slice(0, 30), skippedItems: skipped.slice(0, 20) };
}

function status() {
  return {
    ok: true,
    generatedAt: lastWriteAt,
    generatedAtIso: lastWriteAt ? new Date(lastWriteAt).toISOString() : null,
    hasSnapshot: !!lastSnapshot,
    snapshotKeys: lastSnapshot ? Object.keys(lastSnapshot).filter(k => lastSnapshot[k] != null) : [],
    jsFile: JS_FILE,
    snapshotFile: SNAP_FILE,
    notesCount: readNotes().length,
    syncCount,
    rule: '服务器关闭时可直接双击软件目录里的 index.html 使用本机快照；服务恢复后自动把离线改动合并回在线版。'
  };
}

module.exports = {
  writeSnapshot, writeStandalone, buildWallpaperPack, sync, status, readNotes, addNote,
  getSnapshot: () => lastSnapshot,
  JS_FILE, SNAP_FILE, NOTES_FILE, STANDALONE_FILE, PACK_DIR, PACK_HTML, WP_DIR
};
