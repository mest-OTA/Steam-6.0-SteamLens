/**
 * SteamLens · 本地服务（只监听 127.0.0.1，零第三方依赖）
 * 面板：http://127.0.0.1:8787/
 */
'use strict';

// 关键稳定性修复：本沙箱环境把 reg.exe 列入黑名单，且拦截时会直接杀掉整个进程树。
// SteamLens 的注册表读取改为「PowerShell 注册表提供者」回退 + 常见安装路径扫描，
// 因此这里统一关闭 reg.exe 通道，避免任何请求（隐藏扫描 / 好友刷新 / 真实库识别）触发崩溃。
process.env.STEAMLENS_NO_REG = '1';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// 终极稳定性兜底：任何未捕获异常 / Promise 拒绝都只记录，绝不退出进程。
// 之前「网页又打不开」的根因就是某个后台定时器或请求抛出未捕获错误导致整进程被杀。
process.on('uncaughtException', err => console.error('[SteamLens 未捕获异常，已忽略]', err && err.stack || err));
process.on('unhandledRejection', (reason) => console.error('[SteamLens 未处理 Promise 拒绝，已忽略]', reason && reason.stack || reason));

const core = require('./steam-core');
const friends = require('./friends-core');
const account = require('./account-core');
const notify = require('./notify-core');
const mail = require('./mail-core');
const wishlist = require('./wishlist-core');
const settings = require('./settings-core');
const wechat = require('./wechat-core');
const qq = require('./qq-core');
const qqLogin = require('./qq-login-core');   // QQ 直接登录引擎（登录你自己的 QQ）
const gameDetail = require('./game-detail-core');   // 游戏详情弹窗（玩法 + 成就）
const gameMeta = require('./game-meta-core');      // 游戏名 / 封面永久缓存（扫描到的 AppID 补全）
const pcSpec = require('./pc-spec-core');          // 本机硬件配置自动探测
const friendAchievement = require('./friend-achievement-core'); // 好友成就（Steam 社区）+ 朋友的朋友
const updateCore = require('./update-core');          // 更新中心：分钟级自动更新 + 一键更新 + 秒级日志
const cacheManager = require('./cache-manager-core'); // 缓存管理：选择性删除
const watchlist = require('./watchlist-core');        // 愿望单监控：价格 / 折扣 / 上线提醒
const sms = require('./sms-core');                   // 手机号通知：短信网关 + 分类开关
const wallpaper = require('./wallpaper-core');       // 个性化：小红车动态壁纸 + 创意工坊
const personal = require('./personal-core');         // 个性化：我的照片壁纸 + 自定义开场视频
const valueLedger = require('./library-value-core'); // 库价值永久账本（提取一次永久保存 + 增减累计）
const browserScan = require('./browser-core');
const hidden = require('./hidden-core');
const offline = require('./offline-core');
const dingtalk = require('./dingtalk-core');
const friendProfile = require('./friend-profile-core');
const friendLibrary = require('./friend-library-core');   // 好友「库中的游戏」每秒直读
const steamClient = require('./steam-client-core');   // 直读 Steam 客户端好友列表
const accountLink = require('./account-link-core');   // Steam 账号自动连接与登录记录
const family = require('./family-core');            // 识别家庭（Steam Family 共享家庭）
const friendPlaytime = require('./friend-playtime-core'); // 朋友的朋友：游玩时长 + 什么时候玩了什么游戏

const ROOT = __dirname;
const PORT = Math.min(65535, Math.max(1024, Number(process.env.STEAMLENS_PORT || core.getConfig().port || 8787)));
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon'
};

let cache = { auto: null, manual: null };
let cacheAt = { auto: 0, manual: 0 };
const CACHE_TTL = 15000;
let currentMode = 'auto';

const estimateJob = {
  running: false, done: 0, total: 0, fetched: 0, failed: 0, skipped: 0,
  inflight: 0, activeIds: [], startedAt: 0, finishedAt: 0, error: null, trigger: '手动'
};
const ESTIMATE_HARD_MS = 6 * 60 * 1000;   // 单轮估价最长 6 分钟，超时自动收尾，绝不把 running 卡死
function estimateStatus() {
  const elapsedMs = estimateJob.startedAt ? Date.now() - estimateJob.startedAt : 0;
  return {
    ...estimateJob,
    elapsedMs,
    elapsedSec: Math.round(elapsedMs / 1000),
    hardLimitSec: Math.round(ESTIMATE_HARD_MS / 1000),
    stuck: !!estimateJob.running && elapsedMs > ESTIMATE_HARD_MS + 30000,
    serverNow: Date.now()
  };
}
function finishEstimate(reason) {
  estimateJob.running = false;
  estimateJob.done = estimateJob.total;
  estimateJob.inflight = 0;
  estimateJob.activeIds = [];
  estimateJob.finishedAt = Date.now();
  if (reason) estimateJob.error = reason;
  autoRefresh.value.running = false;
  autoRefresh.value.lastAt = Date.now();
  autoRefresh.value.result = reason || '估价任务结束';
  invalidate();
}

// 后台自动刷新状态（面板会显示「上次 / 下次」）
const autoRefresh = {
  value: { lastAt: 0, nextAt: 0, result: '等待首次运行', running: false },
  library: { lastAt: 0, nextAt: 0, result: '等待连接账号', running: false },
  wishlist: { lastAt: 0, nextAt: 0, result: '等待愿望单', running: false },
  friends: { lastAt: 0, nextAt: 0, result: '等待配置 API Key', running: false },
  hidden: { lastAt: 0, nextAt: 0, result: '等待首次扫描', running: false },
  // 总览每分钟：自动从本机 Steam 客户端重新提取时长 / 已安装清单 / 游戏库
  overview: { lastAt: 0, nextAt: 0, result: '等待首次提取', running: false, count: 0 },
  // 每小时一次强制全量重扫 Steam 客户端（比 15 秒缓存更彻底，会刷新快照）
  playtime: { lastAt: 0, nextAt: 0, result: '等待首次全量提取', running: false },
  // 库价值的「游戏清单」：每分钟合并 Steam 客户端 + 网页端采集结果
  valueGames: { lastAt: 0, nextAt: 0, result: '等待首次合并', running: false }
};
const hoursMs = h => Math.max(0.05, Math.min(720, Number(h) || 6)) * 3600 * 1000;

// 好友状态缓存：打开软件立即返回上次记录，Steam 更新放后台，绝不阻塞首屏
let friendsCache = null, friendsCacheAt = 0, friendsRefreshing = false;
const FRIENDS_TTL = 12000;
function refreshFriendsInBackground() {
  if (friendsRefreshing) return;
  friendsRefreshing = true;
  friends.refresh()
    .then(r => { friendsCache = r; friendsCacheAt = Date.now(); })
    .catch(e => console.error('[好友后台刷新]', e.message))
    .finally(() => { friendsRefreshing = false; });
}
async function getFriends(force = false) {
  /* 显式 refresh=1 / 首次启动：等一次本机读取（只读文件，很快） */
  if (force || !friendsCache) {
    friendsCache = await friends.refresh();
    friendsCacheAt = Date.now();
    return friendsCache;
  }
  /* 有记录就先给记录，过期了顺手触发后台更新，前端不用等 */
  if (Date.now() - friendsCacheAt > FRIENDS_TTL) refreshFriendsInBackground();
  return friendsCache;
}
/* 保留旧记录、只把时间戳清零：下一次读仍立即返回，后台自动更新 */
function invalidateFriends() { friendsCacheAt = 0; }

/** 本机好友名册（采集器用它去 Steam 社区逐个查在线状态，不含任何凭证） */
function friendRosterIds() {
  const meta = friends.getMeta();
  const hidden = friends.removedIds ? friends.removedIds() : new Set();
  return [...new Set([
    ...friends.scanLocalFriends().map(f => String(f.steamId64)),
    ...(meta.manual || []).map(m => String(m.steamId64 || ''))
  ])].filter(x => /^\d{17}$/.test(x) && !hidden.has(x)).slice(0, 200);
}

/** 游戏库：先读 Steam 客户端直读的「我的好友」缓存，读不到再读网页端自动扫到的
    朋友的朋友游戏库（单独存盘，不会被好友库每秒覆写冲掉）。 */
function libraryFor(id) {
  const s = String(id || '');
  return friendLibrary.library(s) || browserScan.getFofLibrary(s);
}

async function getState(mode, force = false) {
  const m = mode === 'manual' ? 'manual' : 'auto';
  currentMode = m;
  if (!force && cache[m] && Date.now() - cacheAt[m] < CACHE_TTL) return cache[m];
  const s = await core.buildState({ mode: m, forceSnapshot: force });
  cache[m] = s; cacheAt[m] = Date.now();
  return s;
}
function invalidate() { cache = { auto: null, manual: null }; cacheAt = { auto: 0, manual: 0 }; }

/* ---------------- 后台自动刷新任务 ---------------- */

/** 统一的估价任务：空任务不启动、并发查价、硬超时自愈、finally 一定释放 running */
function startEstimateJob(ids, trigger = '手动') {
  if (estimateJob.running) {
    if (estimateStatus().stuck) finishEstimate('上一轮估价超时，已自动结束');
    else return { started: false, reason: '已有估价任务在运行，刷新页面也能看到它的进度', job: estimateStatus() };
  }
  const uniq = [...new Set((ids || []).map(String))].slice(0, 150);
  if (!uniq.length) {
    autoRefresh.value = {
      lastAt: Date.now(), nextAt: Date.now() + hoursMs(core.getConfig().valueRefreshHours),
      result: '价格缓存均有效，无需查价', running: false
    };
    return { started: false, total: 0, reason: '价格缓存均有效，无需查价', job: estimateStatus() };
  }
  Object.assign(estimateJob, {
    running: true, done: 0, total: uniq.length, fetched: 0, failed: 0, skipped: 0,
    inflight: 0, activeIds: [], startedAt: Date.now(), finishedAt: 0, error: null, trigger
  });
  autoRefresh.value.running = true;
  autoRefresh.value.result = `正在补齐 ${uniq.length} 款价格…`;
  (async () => {
    try {
      const r = await core.estimatePrices(uniq, pr => {
        estimateJob.done = pr.done; estimateJob.fetched = pr.fetched;
        estimateJob.failed = pr.failed; estimateJob.skipped = pr.skipped;
        estimateJob.inflight = pr.inflight; estimateJob.activeIds = pr.activeIds;
        autoRefresh.value.result = `正在补齐 ${pr.done}/${pr.total} 款价格…`;
      }, { concurrency: 3, timeoutMs: 9000, maxDurationMs: ESTIMATE_HARD_MS });
      if (r.timedOut) estimateJob.error = '达到本轮最长运行时间，剩余游戏会在下次自动重试';
    } catch (e) { estimateJob.error = e.message; }
    finishEstimate(`成功 ${estimateJob.fetched} · 缓存命中 ${estimateJob.skipped} · 待重试 ${estimateJob.failed}`);
    autoRefresh.value.nextAt = Date.now() + hoursMs(core.getConfig().valueRefreshHours);
    await getState(currentMode, false).catch(() => {});
    console.log(`[SteamLens ${trigger}刷新] 库价值：成功 ${estimateJob.fetched} / ${estimateJob.total}`);
  })();
  return { started: true, total: uniq.length, trigger, job: estimateStatus() };
}

async function runValueRefresh(trigger = '自动') {
  const s = await getState(currentMode, false);
  const ids = new Set(core.missingPriceIds(s.games));
  /* 同时补全「游戏库里的游戏」（浏览器扫描提取的已拥有 AppID）的标价，
     这些游戏不一定在本机记录里，但价值应当只统计它们。 */
  try {
    const b = browserScan.status();
    (b.owned || []).forEach(g => {
      const id = String(g && g.appid || '').trim();
      if (/^\d{1,12}$/.test(id)) ids.add(id);
    });
  } catch { /* 浏览器扫描不可用时仅按本机游戏估价 */ }
  return startEstimateJob([...ids], trigger);
}

async function runLibrarySync() {
  const t = account.getTruth();
  if (!t.connected || !t.steamId64) {
    autoRefresh.library.result = '尚未连接 Steam 账号';
    return { ok: false, reason: autoRefresh.library.result };
  }
  autoRefresh.library.running = true;
  try {
    const r = await account.sync();
    invalidate();
    autoRefresh.library.result = r.message || '已同步';
    autoRefresh.library.lastAt = Date.now();
    return r;
  } catch (e) {
    autoRefresh.library.result = '同步失败：' + e.message;
    return { ok: false, error: e.message };
  } finally {
    autoRefresh.library.running = false;
    autoRefresh.library.nextAt = Date.now() + hoursMs(core.getConfig().librarySyncHours);
  }
}

async function runWishlistCheck() {
  const t = account.getTruth();
  if (!(t.wishlist || []).length) {
    autoRefresh.wishlist.result = '愿望单为空';
    return { ok: false, reason: autoRefresh.wishlist.result };
  }
  autoRefresh.wishlist.running = true;
  try {
    const r = await wishlist.checkPrices();
    invalidate();
    autoRefresh.wishlist.lastAt = Date.now();
    autoRefresh.wishlist.result = r.message;
    return r;
  } catch (e) {
    autoRefresh.wishlist.result = '检查失败：' + e.message;
    return { ok: false, error: e.message };
  } finally {
    autoRefresh.wishlist.running = false;
    autoRefresh.wishlist.nextAt = Date.now() + hoursMs(core.getConfig().wishlistCheckHours);
  }
}

/* ---------------- 总览：每分钟自动从本机 Steam 客户端重新提取 ---------------- */
/**
 * 重新读本机 Steam（localconfig.vdf 的时长 / appmanifest 已安装清单 / loginusers 账号），
 * 清掉 15 秒缓存让 /api/state 拿到最新值。全程不联网、不弹浏览器窗口。
 * 网页端采集器若已启动，由它自己的轮询负责同步，这里不强行打开网页。
 */
async function runOverviewExtract() {
  const job = autoRefresh.overview;
  if (job.running) return { ok: false, reason: '上一次提取还没结束' };
  job.running = true;
  try {
    invalidate();
    const s = await getState(currentMode, false);
    job.lastAt = Date.now();
    job.count = (job.count || 0) + 1;
    job.result = `已从 Steam 客户端提取 ${s?.games?.length || 0} 款游戏 · 累计 ${s?.totals?.totalHours ?? 0} 小时`;
    job.nextAt = Date.now() + Math.max(15, Number(core.getConfig().overviewRefreshSec) || 60) * 1000;
    // 同一次重扫顺带刷新「库价值游戏清单」（网页端 + 本机 Steam 客户端合并）
    const vs = s?.valueSources || {};
    const vg = autoRefresh.valueGames;
    vg.lastAt = Date.now();
    vg.nextAt = job.nextAt;
    vg.result = `网页端 ${vs.webOwned || 0} 款 + Steam 客户端 ${vs.steamClientOwned || 0} 款 · 去重后 ${vs.merged || 0} 款参与计价`;
    return { ok: true, games: s?.games?.length || 0, valueSources: vs, atIso: new Date().toISOString() };
  } catch (e) {
    job.result = '提取失败：' + e.message;
    return { ok: false, error: e.message };
  } finally { job.running = false; }
}

/** 每小时强制全量重扫一次并写快照，保证 Steam 游玩时长不停留在旧值 */
async function runPlaytimeRefresh() {
  const job = autoRefresh.playtime;
  if (job.running) return { ok: false, reason: '上一次全量提取还没结束' };
  job.running = true;
  try {
    invalidate();
    const s = await getState(currentMode, true);
    job.lastAt = Date.now();
    job.result = `已全量重提取：${s?.games?.length || 0} 款游戏 / ${s?.totals?.totalHours ?? 0} 小时`;
    job.nextAt = Date.now() + hoursMs(core.getConfig().playtimeRefreshHours || 1);
    return { ok: true, games: s?.games?.length || 0 };
  } catch (e) {
    job.result = '全量提取失败：' + e.message;
    return { ok: false, error: e.message };
  } finally { job.running = false; }
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    // HTTPS 页面回传本机时 Chrome 会做 Private Network Access 预检，缺这个头会被拦
    'Access-Control-Allow-Private-Network': 'true',
    'X-SteamLens': 'local-only'
  });
  res.end(body);
}
function json(res, code, obj) { send(res, code, JSON.stringify(obj)); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 6 * 1024 * 1024) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
/* 照片 / 开场视频走原始二进制上传：不转 base64、不塞进 JSON，原图字节原样落盘。
   前端直接 fetch(url, { method:'POST', body: File })，这里逐块收集即可。 */
function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, done = false;
    const fail = msg => { if (done) return; done = true; reject(new Error(msg)); try { req.destroy(); } catch {} };
    req.on('data', c => {
      if (done) return;
      size += c.length;
      if (size > limit) return fail('文件超过大小限制');
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', e => fail(String(e && e.message || e)));
  });
}

/* 本地封面：从 Steam 的 appcache/librarycache 读取，完全不联网 */
function coverFile(appid) {
  const roots = core.detectSteamRoots();
  for (const r of roots) {
    const dir = path.join(r.path, 'appcache', 'librarycache', String(appid));
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f)); } catch { continue; }
    if (!files.length) continue;
    const prefer = ['library_600x900', 'library_hero', 'header', 'capsule_616x353', 'capsule_231x87', 'logo'];
    for (const key of prefer) {
      const hit = files.find(f => f.toLowerCase().startsWith(key));
      if (hit) return path.join(dir, hit);
    }
    return path.join(dir, files[0]);
  }
  return null;
}

function serveStatic(res, rel) {
  const clean = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(ROOT, clean);
  if (!file.startsWith(ROOT)) { send(res, 403, 'Forbidden', 'text/plain'); return; }
  try {
    const buf = fs.readFileSync(file);
    send(res, 200, buf, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  } catch { send(res, 404, 'Not found', 'text/plain; charset=utf-8'); }
}

async function handleApi(req, res, u) {
  const p = u.pathname;
  const q = u.searchParams;
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') { send(res, 204, ''); return; }

  if (p === '/api/health') {
    json(res, 200, {
      ok: true, service: 'SteamLens', version: '2.0.0', host: HOST, port: PORT, root: ROOT,
      privacy: 'local-only',
      features: ['真实库', '自动价值刷新', '好友系统通知', 'QQ邮箱', '愿望单提醒',
        '设置永久保存', '浏览器扫描/好友码', 'Steam已购买识别', '微信推送', 'QQ通知',
        '隐藏游戏自动识别（每分钟）', '估价并发与进度自愈',
        '离线模式（本机全量快照 + 恢复自动同步）', '钉钉通知', '好友档案（时长与库价值）',
        '好友库中游戏（Steam 客户端直读 · 每秒更新）', '好友退出 Steam 推送',
        '上线时段分布（每秒）', '好友离开时长（逐秒精准计时）']
    });
    return;
  }

  /* ---------------- 界面设置：永久保存（重启 / 换浏览器都不丢） ---------------- */
  if (p === '/api/ui-settings') {
    if (method === 'GET') { json(res, 200, settings.status()); return; }
    if (method === 'POST') {
      const b = await readBody(req);
      json(res, 200, { ok: true, settings: settings.patch(b) });
      return;
    }
  }
  if (p === '/api/ui-settings/reset' && method === 'POST') {
    json(res, 200, { ok: true, settings: settings.reset() });
    return;
  }
  if (p === '/api/ui-settings/import' && method === 'POST') {
    const b = await readBody(req);
    try { json(res, 200, { ok: true, settings: settings.importAll(b) }); }
    catch (e) { json(res, 400, { ok: false, error: e.message }); }
    return;
  }

  /* ---------------- 微信推送（只发给自己，单向，不读聊天） ---------------- */
  if (p === '/api/wechat/status' && method === 'GET') { json(res, 200, wechat.status()); return; }
  if (p === '/api/wechat/connect' && method === 'POST') {
    const b = await readBody(req);
    try { json(res, 200, await wechat.connect(b)); }
    catch (e) { json(res, 400, { ok: false, error: e.message }); }
    return;
  }
  if (p === '/api/wechat/disconnect' && method === 'POST') { json(res, 200, wechat.disconnect()); return; }
  if (p === '/api/wechat/test' && method === 'POST') { json(res, 200, await wechat.test()); return; }
  if (p === '/api/wechat/config' && method === 'POST') {
    const b = await readBody(req);
    json(res, 200, { ok: true, applied: wechat.saveConfig(b), status: wechat.status() });
    return;
  }

  /* ---------------- QQ 通知（只发给自己，单向，不读聊天） ---------------- */
  if (p === '/api/qq/status' && method === 'GET') { json(res, 200, qq.status()); return; }
  if (p === '/api/qq/connect' && method === 'POST') {
    const b = await readBody(req);
    try { json(res, 200, await qq.connect(b)); }
    catch (e) { json(res, 400, { ok: false, error: e.message }); }
    return;
  }
  if (p === '/api/qq/disconnect' && method === 'POST') { json(res, 200, qq.disconnect()); return; }
  if (p === '/api/qq/test' && method === 'POST') { json(res, 200, await qq.test()); return; }
  if (p === '/api/qq/config' && method === 'POST') {
    const b = await readBody(req);
    json(res, 200, { ok: true, applied: qq.saveConfig(b), status: qq.status() });
    return;
  }

  /* ---------------- QQ 直接登录（登录你自己的 QQ，自己发给自己） ---------------- */
  if (p === '/api/qq/direct/status' && method === 'GET') { json(res, 200, qqLogin.status()); return; }
  if (p === '/api/qq/direct/qr' && method === 'POST') {
    const b = await readBody(req);
    try { json(res, 200, qqLogin.startQR(b.uin, !!b.force)); } catch (e) { json(res, 200, { ok: false, error: e.message }); } return;
  }
  /* 手机确认后手动补一次 login()（自动扫码轮询之外的兜底） */
  if (p === '/api/qq/direct/scan-done' && method === 'POST') {
    try { json(res, 200, qqLogin.finishScan()); } catch (e) { json(res, 200, { ok: false, error: e.message }); } return;
  }
  /* 回到 QQ 登录开始界面：停会话 + 清错误 + 清诊断 */
  if (p === '/api/qq/direct/reset' && method === 'POST') {
    try { json(res, 200, qqLogin.reset()); } catch (e) { json(res, 200, { ok: false, error: e.message }); } return;
  }
  if (p === '/api/qq/direct/password' && method === 'POST') {
    const b = await readBody(req);
    try { json(res, 200, qqLogin.startPassword(b.uin, b.pwd)); } catch (e) { json(res, 200, { ok: false, error: e.message }); } return;
  }
  if (p === '/api/qq/direct/slider' && method === 'POST') {
    const b = await readBody(req); json(res, 200, qqLogin.submitSlider(b.ticket)); return;
  }
  /* 腾讯验证页不显示 ticket：用户粘贴响应 JSON / 地址栏 URL / 任意文字，后端自动抠 ticket 并提交 */
  if (p === '/api/qq/direct/slider-paste' && method === 'POST') {
    const b = await readBody(req);
    try { json(res, 200, qqLogin.submitTicketPaste(b.raw || b.ticket || '')); }
    catch (e) { json(res, 200, { ok: false, error: e.message }); }
    return;
  }
  /* 验证已做完：直接重新 login()，腾讯放行就上线，不需要手动找 ticket */
  if (p === '/api/qq/direct/verify-done' && method === 'POST') {
    try { json(res, 200, qqLogin.finishVerify()); }
    catch (e) { json(res, 200, { ok: false, error: e.message }); }
    return;
  }
  /* 验证页里的自动抓取脚本回传 ticket：POST 用 fetch，GET 用 <img>（绕开部分浏览器的跨域限制） */
  if (p === '/api/qq/direct/ticket' && (method === 'GET' || method === 'POST')) {
    let ticket = '';
    if (method === 'GET') ticket = q.get('ticket') || q.get('raw') || '';
    else { const b = await readBody(req); ticket = b.ticket || b.raw || ''; }
    let r;
    try { r = qqLogin.receiveTicket(ticket); }
    catch (e) { r = { ok: false, error: e.message }; }
    if (method === 'GET') {
      const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
      res.writeHead(200, {
        'Content-Type': 'image/gif', 'Content-Length': gif.length,
        'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store'
      });
      res.end(gif);
      return;
    }
    json(res, 200, r); return;
  }
  /* 验证链接过期 / 服务重启后会话丢了：重新发起登录，让腾讯再下发一条滑块 URL */
  if (p === '/api/qq/direct/slider-refresh' && method === 'POST') {
    try { json(res, 200, qqLogin.refreshSlider()); } catch (e) { json(res, 200, { ok: false, error: e.message }); } return;
  }
  if (p === '/api/qq/direct/sms-send' && method === 'POST') {
    try { json(res, 200, qqLogin.sendSms()); } catch (e) { json(res, 200, { ok: false, error: e.message }); } return;
  }
  if (p === '/api/qq/direct/sms' && method === 'POST') {
    const b = await readBody(req); json(res, 200, qqLogin.submitSmsCode(b.code)); return;
  }
  if (p === '/api/qq/direct/confirm-device' && method === 'POST') { json(res, 200, qqLogin.confirmDevice()); return; }
  if (p === '/api/qq/direct/cancel' && method === 'POST') { json(res, 200, qqLogin.cancel()); return; }
  if (p === '/api/qq/direct/logout' && method === 'POST') { json(res, 200, qqLogin.logout()); return; }
  if (p === '/api/qq/direct/send' && method === 'POST') {
    const b = await readBody(req);
    try { json(res, 200, await qqLogin.sendToSelf(b.text || '')); } catch (e) { json(res, 200, { ok: false, error: e.message }); } return;
  }
  if (p === '/api/qq/direct/auto' && method === 'POST') {
    const b = await readBody(req); json(res, 200, qqLogin.setAutoLogin(b.enabled)); return;
  }

  /* ---------------- 愿望单监控：添加游戏 / 价格 / 折扣 / 上线提醒 ---------------- */
  if (p === '/api/watchlist/status' && method === 'GET') { json(res, 200, watchlist.status()); return; }
  if (p === '/api/watchlist/search' && method === 'GET') {
    const q = (new URL(req.url, 'http://x')).searchParams;
    try { json(res, 200, await watchlist.search(q.get('term'))); }
    catch (e) { json(res, 200, { ok: false, error: e.message, items: [] }); }
    return;
  }
  if (p === '/api/watchlist/add' && method === 'POST') {
    const b = await readBody(req);
    try {
      const r = watchlist.add(b.appid, b.name, b.source);
      if (r.ok) await watchlist.refreshOne(b.appid);   // 加进来就自动查一次价格
      json(res, 200, { ...r, status: watchlist.status() });
    } catch (e) { json(res, 200, { ok: false, error: e.message }); }
    return;
  }
  if (p === '/api/watchlist/remove' && method === 'POST') {
    const b = await readBody(req); json(res, 200, { ...watchlist.remove(b.appid), status: watchlist.status() }); return;
  }
  if (p === '/api/watchlist/mute' && method === 'POST') {
    const b = await readBody(req); json(res, 200, watchlist.mute(b.appid, b.muted)); return;
  }
  if (p === '/api/watchlist/rule' && method === 'POST') {
    const b = await readBody(req); json(res, 200, { ...watchlist.setRule(b.appid, b), status: watchlist.status() }); return;
  }
  if (p === '/api/watchlist/auto' && method === 'POST') {
    const b = await readBody(req); json(res, 200, watchlist.setAuto(b.enabled)); return;
  }
  if (p === '/api/watchlist/import-owned' && method === 'POST') {
    const b = await readBody(req);
    json(res, 200, { ...watchlist.importOwned(Math.min(60, Number(b.limit) || 30)), status: watchlist.status() }); return;
  }
  if (p === '/api/watchlist/refresh' && method === 'POST') {
    const b = await readBody(req);
    try { json(res, 200, { ...(await watchlist.refreshOne(b.appid)), status: watchlist.status() }); }
    catch (e) { json(res, 200, { ok: false, error: e.message }); }
    return;
  }
  if (p === '/api/watchlist/check' && method === 'POST') {
    try { json(res, 200, { ...(await watchlist.check({})), status: watchlist.status() }); }
    catch (e) { json(res, 200, { ok: false, error: e.message }); }
    return;
  }

  /* ---------------- 浏览器会话扫描 / 好友码 / 已购买清单 ---------------- */
  if (p === '/api/browser/status' && method === 'GET') { json(res, 200, browserScan.status()); return; }
  /* 浏览器实时标签探测（CDP）：打开 Steam 网页即「识别到」并自动导入数据 */
  if (p === '/api/browser/debug/launch' && method === 'POST') { json(res, 200, browserScan.launchSteamDebug()); return; }
  if (p === '/api/browser/debug/attach' && method === 'POST') {
    const b = await readBody(req); json(res, 200, browserScan.attachDebug(b.port)); return;
  }
  if (p === '/api/browser/debug/detach' && method === 'POST') { json(res, 200, browserScan.detachDebug()); return; }

  /* 游戏详情弹窗：点击游戏库 / 好友库中游戏时拉取玩法 + 成就 */
  if (p === '/api/game/detail' && method === 'GET') {
    const q = (new URL(req.url, 'http://x')).searchParams;
    const appid = q.get('appid');
    const opts = { name: q.get('name') || '', noNetwork: q.get('noNetwork') === '1' };
    try { json(res, 200, await gameDetail.getDetail(appid, opts)); }
    catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  /* 本机硬件配置：自动探测 OS / CPU / GPU / 内存 / 系统盘剩余；refresh=1 强制重新检测 */
  if (p === '/api/pc-specs' && method === 'GET') {
    try {
      const q = (new URL(req.url, 'http://x')).searchParams;
      const r = q.get('refresh') === '1' ? pcSpec.detect() : pcSpec.status();
      json(res, 200, r);
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  /* 系统需求 + 我的配置对比：把游戏要求、本机配置、对比结论一次给齐 */
  if (p === '/api/game/sysreq' && method === 'GET') {
    const q = (new URL(req.url, 'http://x')).searchParams;
    const appid = q.get('appid');
    const name = q.get('name') || '';
    try {
      const reqs = await gameDetail.getRequirements(appid, name);
      const pc = q.get('refresh') === '1' ? pcSpec.detect() : pcSpec.status();
      const comparison = reqs.parsed ? gameDetail.compareSpecs(pc, reqs.parsed) : null;
      json(res, 200, { appid, name, requirements: reqs, pcSpecs: pc, comparison });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }
  /* 识别家庭：返回已保存快照 + 通知设置 + 是否已配置 Key */
  if (p === '/api/family' && method === 'GET') {
    try { json(res, 200, family.status()); }
    catch (e) { json(res, 500, { error: e.message }); }
    return;
  }
  if (p === '/api/family/config' && method === 'GET') {
    try { json(res, 200, family.getConfig()); }
    catch (e) { json(res, 500, { error: e.message }); }
    return;
  }
  if (p === '/api/family/config' && method === 'POST') {
    try { const b = await readBody(req); json(res, 200, family.saveConfig(b || {})); }
    catch (e) { json(res, 500, { error: e.message }); }
    return;
  }
  if (p === '/api/family/scan' && method === 'POST') {
    try { const r = await family.scan(); json(res, 200, r); }
    catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return;
  }
  /* 本地封面：从 Steam librarycache 读取，不依赖外网 */
  if (p === '/api/game/cover' && method === 'GET') {
    const appid = String((new URL(req.url, 'http://x')).searchParams.get('appid') || '').trim();
    if (!/^\d{1,12}$/.test(appid)) { res.writeHead(400); res.end(); return; }
    const f = gameDetail.localCover(appid);
    if (!f || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    const ext = path.extname(f).toLowerCase();
    const ct = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    try {
      res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=86400' });
      res.end(fs.readFileSync(f));
    } catch { res.writeHead(404); res.end(); }
    return;
  }

  /* 游戏名 / 封面补全状态与手动重试（浏览器扫描到的愿望单经常只有 AppID） */
  if (p === '/api/game/meta/status' && method === 'GET') { json(res, 200, gameMeta.status()); return; }
  if (p === '/api/game/meta/refresh' && method === 'POST') { json(res, 200, gameMeta.refreshAll()); return; }

  /* 全部好友成就缓存：前端用来在好友列表/档案里直接显示「他有什么成就」 */
  if (p === '/api/friend/achievements/all' && method === 'GET') {
    json(res, 200, { ok: true, items: friendAchievement.snapshot() });
    return;
  }
  /* 按好友汇总：游戏分组 + 具体成就名称 / 解锁状态 / 解锁时间 */
  if (p === '/api/friend/achievements/summary' && method === 'GET') {
    const q = (new URL(req.url, 'http://x')).searchParams;
    json(res, 200, friendAchievement.friendSummary(q.get('steamId64')));
    return;
  }
  /* 好友成就：从 Steam 社区公开成就页读取「这个好友」的解锁记录 */
  if (p === '/api/friend/achievements' && method === 'GET') {
    const q = (new URL(req.url, 'http://x')).searchParams;
    try {
      json(res, 200, await friendAchievement.getFriendAchievements(
        q.get('steamId64'), q.get('appid'), q.get('name') || '',
        { refresh: q.get('refresh') === '1' }
      ));
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }
  /* 好友关系链：直接好友 + 朋友的朋友（Steam 社区好友列表） */
  if (p === '/api/friend/discover' && method === 'GET') {
    const q = (new URL(req.url, 'http://x')).searchParams;
    const id = q.get('steamId64') || core.getConfig().steamId64 || '';
    try {
      json(res, 200, await friendAchievement.discoverFriends(id, {
        depth: q.get('depth') === '0' ? 0 : 1,
        refresh: q.get('refresh') === '1'
      }));
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }
  /* 已发现的好友（离线/快速读取，不联网） */
  if (p === '/api/friend/discover/cached' && method === 'GET') {
    json(res, 200, friendAchievement.discovered() || { ok: false, direct: [], extended: [] });
    return;
  }

  /* ---------------- 点击好友的独立面板：他朋友的朋友 + 库中的东西 + Steam 徽章 ----------------
     一个聚合接口供前端每秒轮询：全程只读本机缓存，不联网、不触发 Steam 抓取，
     所以每秒一次也不会把 Steam 社区打爆。 */
  if (p === '/api/friend/network' && method === 'GET') {
    const q = (new URL(req.url, 'http://x')).searchParams;
    const id = String(q.get('steamId64') || '').trim();
    const d = friendAchievement.discovered() || { ok: false, direct: [], extended: [] };
    const related = (d.extended || []).filter(x => String(x.via || '') === id);
    const fof = related.slice(0, 40).map(x => {
      const lib = libraryFor(x.steamId64);
      const games = Array.isArray(lib?.games) ? lib.games : [];
      return {
        steamId64: String(x.steamId64 || ''), name: String(x.name || ''),
        avatar: String(x.avatar || ''), viaName: String(x.viaName || ''),
        profileUrl: String(x.profileUrl || x.url || ''),
        games: games.slice(0, 40), gameCount: games.length, hasLibrary: !!lib,
        librarySource: String(lib?.source || '')
      };
    });
    const own = friendLibrary.library(id);
    json(res, 200, {
      ok: true, steamId64: id, ts: Date.now(),
      /* 全局 note 是「整份关系链」的状态；这里按当前这位好友给出准确提示，
         免得 A 的私密页把 B 已采到的 43 人面板写成「没读到公开好友」。 */
      discoverOk: !!d.ok,
      discoverNote: related.length ? ''
        : '这位好友的朋友列表暂时没读到公开好友（可能设为私密，自动巡航会继续重试）',
      generatedAtIso: d.generatedAtIso || '',
      fofSource: browserScan.fofStatus(),
      autoScan: browserScan.autoStatus(),
      fofCount: related.length, fof,
      ownLibrary: own ? { games: (own.games || []).slice(0, 40), gameCount: (own.games || []).length } : null,
      badges: browserScan.getBadges(id)
    });
    return;
  }
  if (p === '/api/friend/badges' && method === 'GET') {
    const q = (new URL(req.url, 'http://x')).searchParams;
    json(res, 200, browserScan.getBadges(q.get('steamId64') || ''));
    return;
  }
  /* 一键打开这位好友的徽章页：采集器注入后会自动把徽章回传本机 */
  if (p === '/api/friend/badges/open' && method === 'POST') {
    const b = await readBody(req);
    const id = String(b.steamId64 || '').trim();
    if (!/^7656119\d{10}$/.test(id)) { json(res, 400, { ok: false, error: 'SteamID64 格式不正确' }); return; }
    const url = `https://steamcommunity.com/profiles/${id}/badges`;
    const r = await browserScan.openBadgeTab(url);
    json(res, 200, { ok: true, url, ...r });
    return;
  }
  /* 一键打开这位好友的 Steam 好友列表页：采集器 / CDP 会自动回传「朋友的朋友」。
     服务端直连 /friends 不带浏览器登录 Cookie 读不到，必须走已登录的浏览器标签。 */
  if (p === '/api/friend/fof/open' && method === 'POST') {
    const b = await readBody(req);
    const id = String(b.steamId64 || '').trim();
    if (!/^7656119\d{10}$/.test(id)) { json(res, 400, { ok: false, error: 'SteamID64 格式不正确' }); return; }
    const url = `https://steamcommunity.com/profiles/${id}/friends/`;
    const r = await browserScan.openSteamTab(url);
    json(res, 200, { ok: true, url, ...r });
    return;
  }
  /* 朋友的朋友自动扫描：查询状态 / 开关 / 立即优先扫某位好友 / 重扫一轮。
     开启后后端会自动在已登录 Steam 的浏览器里依次打开好友列表页和游戏库页。 */
  if (p === '/api/friend/fof/auto' && method === 'GET') {
    json(res, 200, browserScan.autoStatus()); return;
  }
  if (p === '/api/friend/fof/auto' && method === 'POST') {
    const b = await readBody(req);
    json(res, 200, browserScan.autoControl(b || {})); return;
  }

  /* ---------------- 好友档案聚合：库中游戏 / 玩了多久 / 什么时候玩了什么 / 朋友的朋友 / 徽章。
     全部只读本机文件：不联网、不等 Steam Web API Key、也不依赖浏览器登录态，
     所以「看明细」能秒开；前端每秒刷新也不会卡。 */
  if (p === '/api/friend/dossier' && method === 'GET') {
    const q = (new URL(req.url, 'http://x')).searchParams;
    const id = String(q.get('steamId64') || '').trim();
    if (!/^\d{17}$/.test(id)) { json(res, 400, { ok: false, error: 'SteamID64 格式不正确' }); return; }
    const lib = friendLibrary.library(id);
    const games = Array.isArray(lib?.games) ? lib.games.slice(0, 80) : [];
    const events = (friends.loadEvents() || []).filter(e => String(e?.steamId64 || '') === id);
    const timeline = events.slice(-120).reverse().map(e => ({
      atIso: e.iso || new Date(Number(e.ts) || Date.now()).toISOString(),
      atLabel: new Date(Number(e.ts) || Date.now()).toLocaleString('zh-CN', { hour12: false }),
      name: e.game || e.name || '', text: e.text || '', type: e.type || '',
      source: e.game ? '本机上线记录 · 正在玩' : '本机上线记录'
    }));
    const statDays = friends.loadStats() || {};
    let totalMin = 0;
    for (const day of Object.values(statDays)) {
      const r = day && day[id];
      if (r) totalMin += Number(r.onlineMinutes || 0);
    }
    const pt = (friendPlaytime.summary()?.people || []).find(x => String(x.steamId64) === id) || null;
    const d = friendAchievement.discovered() || {};
    const related = (d.extended || []).filter(x => String(x.via || '') === id).slice(0, 40).map(x => {
      const foLib = libraryFor(x.steamId64);
      return {
        steamId64: String(x.steamId64 || ''), name: String(x.name || ''),
        avatar: String(x.avatar || ''), viaName: String(x.viaName || ''),
        profileUrl: String(x.profileUrl || x.url || ''),
        games: (Array.isArray(foLib?.games) ? foLib.games : []).slice(0, 20),
        gameCount: Array.isArray(foLib?.games) ? foLib.games.length : 0,
        hasLibrary: !!foLib, librarySource: String(foLib?.source || '')
      };
    });
    json(res, 200, {
      ok: true, steamId64: id, ts: Date.now(),
      name: String(lib?.name || ''), games, gameCount: games.length, hasLibrary: !!lib,
      totalMin: Math.round(totalMin * 10) / 10,
      totalHours: Math.round(totalMin / 6) / 10,
      steamPlaytime: pt ? { totalHours: pt.totalHours || 0, recent2wHours: pt.recent2wHours || 0, playedGames: pt.playedGames || 0, private: !!pt.private } : null,
      timeline, eventCount: events.length,
      fofCount: related.length, fof: related,
      badges: browserScan.getBadges(id),
      discoverAt: d.generatedAtIso || '',
      fofSource: browserScan.fofStatus(), autoScan: browserScan.autoStatus()
    });
    return;
  }

  /* 把 Steam 社区发现的人加入好友名册 */
  if (p === '/api/friend/discover/add' && method === 'POST') {
    const b = await readBody(req);
    const id = String(b.steamId64 || '').trim();
    if (!/^7656119\d{10}$/.test(id)) { json(res, 400, { error: 'SteamID64 格式不正确' }); return; }
    friends.addManual(id, b.name || '');
    invalidateFriends();
    json(res, 200, { ok: true, state: await getFriends(true) });
    return;
  }

  /* ---------------- 朋友的朋友：游玩时长 / 什么时候玩了什么游戏 ---------------- */
  // 汇总（不联网，直接读本机缓存）
  if (p === '/api/friend/playtime' && method === 'GET') {
    json(res, 200, friendPlaytime.summary());
    return;
  }
  // 单人明细（refresh=1 时现抓 Steam）
  if (p === '/api/friend/playtime/detail' && method === 'GET') {
    const q = (new URL(req.url, 'http://x')).searchParams;
    const id = q.get('steamId64') || '';
    try { json(res, 200, await friendPlaytime.detail(id, { refresh: q.get('refresh') === '1' })); }
    catch (e) { json(res, 500, { error: e.message }); }
    return;
  }
  // 批量扫描（限量 + 并发，结果永久落盘）
  if (p === '/api/friend/playtime/scan' && method === 'POST') {
    const b = await readBody(req);
    try {
      json(res, 200, await friendPlaytime.scan({
        limit: Number(b.limit) || 40,
        refresh: !!b.refresh,
        onlyExtended: !!b.onlyExtended
      }));
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }
  if (p === '/api/friend/playtime/status' && method === 'GET') { json(res, 200, friendPlaytime.status()); return; }
  if (p === '/api/friend/playtime/clear' && method === 'POST') { json(res, 200, friendPlaytime.clear()); return; }

  /* 更新中心：秒级日志 / 一键更新 */
  if (p === '/api/update/log' && method === 'GET') { json(res, 200, updateCore.status()); return; }
  if (p === '/api/update/run' && method === 'POST') {
    try {
      const rec = await updateCore.runUpdate('manual');
      json(res, 200, { ok: !rec.skipped, record: rec, status: updateCore.status() });
    } catch (e) { json(res, 500, { error: e.message, status: updateCore.status() }); }
    return;
  }

  /* 缓存管理：列出分块 / 只删除勾选的块（绝不一键全删） */
  if (p === '/api/cache/blocks' && method === 'GET') { json(res, 200, cacheManager.list()); return; }
  if (p === '/api/cache/delete' && method === 'POST') {
    const b = await readBody(req);
    const ids = Array.isArray(b.blocks) ? b.blocks.map(String) : [];
    const appids = Array.isArray(b.appids) ? b.appids.map(String) : [];
    if (!ids.length) { json(res, 400, { error: '请至少勾选一块缓存' }); return; }
    try { json(res, 200, cacheManager.remove(ids, appids)); }
    catch (e) { json(res, 500, { error: e.message }); }
    return;
  }
  /* 手动写入 / 修正某款游戏的玩法（写入后永久生效） */
  if (p === '/api/game/gameplay' && method === 'POST') {
    const b = await readBody(req);
    try { json(res, 200, { ok: true, entry: gameDetail.setGameplay(b.appid, b.gameplay, b.source) }); }
    catch (e) { json(res, 500, { error: e.message }); }
    return;
  }
  if (p === '/api/browser/ingest' && method === 'POST') {
    const b = await readBody(req);
    try {
      const r = browserScan.ingest(b);
      json(res, 200, r);
      // ★ 好友状态一上报就立刻重算，上线事件与通知不必等下一次后台轮询
      if (r && r.friendStates > 0) {
        invalidateFriends();
        setImmediate(() => getFriends(true).catch(e => console.error('[SteamLens 好友会话刷新]', e.message)));
      }
    } catch (e) { json(res, 400, { ok: false, error: e.message }); }
    return;
  }
  if (p === '/api/browser/friend-ids' && method === 'GET') {
    const ids = friendRosterIds();
    json(res, 200, { ok: true, ids, count: ids.length });
    return;
  }
  if (p === '/api/browser/clear' && method === 'POST') { json(res, 200, browserScan.clear()); return; }
  if (p === '/api/browser/friend-code' && method === 'POST') {
    const b = await readBody(req);
    try { json(res, 200, browserScan.setFriendCode(b.code || b.friendCode || '')); }
    catch (e) { json(res, 400, { ok: false, error: e.message }); }
    return;
  }
  if (p === '/api/browser/collector' && method === 'GET') {
    send(res, 200, browserScan.collectorScript(friendRosterIds()), 'text/javascript; charset=utf-8');
    return;
  }

  /* ---------------- Steam 隐藏游戏：自动识别 / 每分钟同步 ---------------- */
  if (p === '/api/hidden/status' && method === 'GET') { json(res, 200, hidden.status()); return; }
  if (p === '/api/hidden/scan' && method === 'POST') {
    const r = hidden.scan('手动立即扫描');
    invalidate();
    autoRefresh.hidden = {
      lastAt: Date.now(), nextAt: Date.now() + hidden.cfg().intervalSec * 1000,
      result: `识别 ${r.total} 款隐藏游戏（新增 ${r.added.length} / 移除 ${r.removed.length}）`, running: false
    };
    json(res, 200, { ok: true, ...r, status: hidden.status() });
    return;
  }
  if (p === '/api/hidden/config' && method === 'POST') {
    const b = await readBody(req);
    const st = hidden.saveConfig(b);
    autoRefresh.hidden.nextAt = st.nextAt;
    autoRefresh.hidden.result = st.enabled ? '自动同步已开启' : '自动同步已关闭';
    json(res, 200, { ok: true, status: st });
    return;
  }
  if (p === '/api/hidden/remove' && method === 'POST') {
    const b = await readBody(req);
    if (!b.appid) { json(res, 400, { error: '缺少 appid' }); return; }
    invalidate();
    json(res, 200, { ok: true, status: hidden.remove(b.appid) });
    return;
  }
  if (p === '/api/hidden/restore' && method === 'POST') {
    const r = hidden.restore();
    invalidate();
    json(res, 200, { ok: true, result: r, status: hidden.status() });
    return;
  }

  /* ---------------- 官方 Steam 客户端登录（密码只输入在 Steam 自己的窗口里） ---- */
  function steamExeInfo() {
    const roots = core.detectSteamRoots();
    const exe = roots.map(r => path.join(r.path, 'steam.exe')).find(f => fs.existsSync(f)) || '';
    let accounts = [];
    if (roots.length) {
      try {
        const lu = core.vdfFile(path.join(roots[0].path, 'config', 'loginusers.vdf'))?.users || {};
        accounts = Object.entries(lu).filter(([, u]) => u && typeof u === 'object')
          .map(([id, u]) => ({ steamId64: id, accountName: u.AccountName || '', personaName: u.PersonaName || '' }));
      } catch { /* 忽略 */ }
    }
    return { exe, root: roots[0]?.path || '', roots: roots.slice(0, 3), accounts };
  }
  if (p === '/api/steam/info' && method === 'GET') {
    const i = steamExeInfo();
    json(res, 200, { ok: true, found: !!i.exe, exe: i.exe, root: i.root, roots: i.roots, accounts: i.accounts });
    return;
  }
  if (p === '/api/steam/launch' && method === 'POST') {
    const i = steamExeInfo();
    if (!i.exe) { json(res, 404, { ok: false, error: '未找到 steam.exe，请在「连接与配对」手动指定 Steam 根目录' }); return; }
    try {
      const child = spawn(i.exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      json(res, 200, {
        ok: true, exe: i.exe,
        message: '已打开 Steam 官方客户端，请在它自己的窗口里输入账号密码登录；登录后回到面板点「立即重新同步」即可',
        security: 'SteamLens 不接触、不保存你的 Steam 账号密码'
      });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return;
  }

  /* ---------------- 自动刷新 ---------------- */
  if (p === '/api/autorefresh' && method === 'GET') {
    const c = core.getConfig();
    json(res, 200, {
      jobs: autoRefresh,
      config: {
        autoEstimateValue: c.autoEstimateValue !== false,
        valueRefreshHours: Number(c.valueRefreshHours || 24),
        playtimeRefreshHours: Number(c.playtimeRefreshHours || 1),
        overviewRefreshSec: Number(c.overviewRefreshSec || 60),
        librarySyncHours: Number(c.librarySyncHours || 12),
        wishlistCheckHours: Number(c.wishlistCheckHours || 6),
        friendPollSec: Number(c.friendPollSec || 60),
        hiddenAutoSync: c.hiddenAutoSync !== false,
        hiddenSyncSec: Number(c.hiddenSyncSec || 60)
      },
      estimate: estimateStatus()
    });
    return;
  }
  if (p === '/api/refresh/value' && method === 'POST') {
    json(res, 200, await runValueRefresh('手动'));
    return;
  }
  /* 手动触发：总览每分钟提取 / Steam 时长每小时全量提取 */
  if (p === '/api/refresh/overview' && method === 'POST') { json(res, 200, await runOverviewExtract()); return; }
  if (p === '/api/refresh/playtime' && method === 'POST') { json(res, 200, await runPlaytimeRefresh()); return; }
  /* 库价值永久账本：查看保存的价格与增减记录 / 清空重来 */
  if (p === '/api/value/ledger' && method === 'GET') { json(res, 200, valueLedger.status()); return; }
  if (p === '/api/value/ledger/reset' && method === 'POST') { json(res, 200, valueLedger.reset()); return; }
  if (p === '/api/refresh/all' && method === 'POST') {
    const out = { value: await runValueRefresh('手动'), library: null, wishlist: null };
    if (account.getTruth().connected) out.library = await runLibrarySync();
    if ((account.getTruth().wishlist || []).length) out.wishlist = await runWishlistCheck();
    json(res, 200, out);
    return;
  }

  /* ---------------- Steam 账号连接（只读授权，绝不收账号密码） ---------------- */
  if (p === '/api/account' && method === 'GET') {
    const t = account.getTruth();
    json(res, 200, {
      ...account.publicView(t),
      profile: t.profile,
      apiKeySet: !!core.getConfig().apiKey,
      owned: (t.owned || []).slice(0, 300),
      wishlist: (t.wishlist || []).slice(0, 300),
      refunded: t.refunded || [], reinstated: t.reinstated || [],
      apiKeyPage: account.API_KEY_PAGE,
      message: account.summarize(t)
    });
    return;
  }
  if (p === '/api/account/links' && method === 'GET') {
    const c = core.getConfig();
    const id = account.getTruth().steamId64 || c.steamId64 || '';
    const key = c.apiKey || '';
    json(res, 200, {
      steamId64: id, apiKeySet: !!key,
      ownedGames: key && id ? account.ownedUrl(key, id) : '',
      wishlist: id ? account.wishlistUrl(id, 0) : '',
      apiKeyPage: account.API_KEY_PAGE
    });
    return;
  }
  if (p === '/api/account/connect' && method === 'POST') {
    const b = await readBody(req);
    try {
      const r = await account.connect(b);
      invalidate();
      await getState(currentMode, false).catch(() => {});
      autoRefresh.library.lastAt = Date.now();
      autoRefresh.library.result = r.message;
      json(res, 200, r);
    } catch (e) { json(res, 400, { ok: false, error: e.message }); }
    return;
  }
  if (p === '/api/account/sync' && method === 'POST') {
    try {
      const r = await runLibrarySync();
      invalidate();
      json(res, 200, { ok: true, ...r });
    } catch (e) { json(res, 400, { ok: false, error: e.message }); }
    return;
  }
  if (p === '/api/account/disconnect' && method === 'POST') {
    account.disconnect(); invalidate();
    json(res, 200, { ok: true, account: account.publicView() });
    return;
  }
  if (p === '/api/account/refund' && method === 'POST') {
    const b = await readBody(req);
    if (!b.appid) { json(res, 400, { error: '缺少 appid' }); return; }
    if (b.reinstate !== undefined) account.markReinstated(String(b.appid), !!b.reinstate);
    else account.markRefund(String(b.appid), b.refunded !== false);
    invalidate();
    const s = await getState(currentMode, false);
    json(res, 200, { ok: true, totals: s.totals });
    return;
  }
  if (p === '/api/account/wishlist' && method === 'POST') {
    const b = await readBody(req);
    try {
      const t = account.setWishlistFromJson(b.json || '');
      invalidate();
      json(res, 200, { ok: true, count: (t.wishlist || []).length });
    } catch (e) { json(res, 400, { ok: false, error: e.message }); }
    return;
  }

  /* ---------------- 上线通知 ---------------- */
  if (p === '/api/notify/status' && method === 'GET') {
    json(res, 200, {
      config: notify.cfg(), history: notify.getHistory(),
      mail: mail.status(), wechat: wechat.status(), qq: qq.status(), dingtalk: dingtalk.status()
    });
    return;
  }
  if (p === '/api/notify/config' && method === 'POST') {
    const b = await readBody(req);
    const allowed = ['friendNotify', 'friendNotifyOffline', 'notifyDesktop', 'notifySound',
      'notifyScope', 'notifyWebhookUrl', 'notifyWebhookType', 'notifyMinIntervalSec',
      'mailOnOnline', 'mailOnOffline', 'mailOnGame',
      'mailMinIntervalSec', 'mailQuiet', 'mailSubjectPrefix'];
    const patch = {};
    for (const k of allowed) if (b[k] !== undefined) patch[k] = b[k];
    core.saveConfig(patch);
    json(res, 200, { ok: true, config: notify.cfg(), mail: mail.status() });
    return;
  }
  if (p === '/api/notify/test' && method === 'POST') {
    // type=offline 用来验证「好友退出 Steam」那条通知（只弹本机窗口，不打扰邮箱 / 微信 / QQ / 钉钉）
    const b = await readBody(req).catch(() => ({}));
    const type = String(b?.type || 'online').toLowerCase() === 'offline' ? 'offline' : 'online';
    json(res, 200, await notify.testNotification(type));
    return;
  }

  /* ---------------- QQ 邮箱：登录 / 退出（授权码长期保存） ---------------- */
  if (p === '/api/mail/status' && method === 'GET') {
    const s = mail.status();
    json(res, 200, { ...s, connected: !!(s.enabled && s.ready && s.authCodeValid), qr: 'assets/qq-mail-qr.png' });
    return;
  }
  if (p === '/api/mail/connect' && method === 'POST') {
    const b = await readBody(req);
    const user = String(b.user || '').trim() || String(core.getConfig().mailUser || '').trim();
    const typed = String(b.authCode || '').trim();
    // 已保存过授权码时，留空 = 沿用原来的（重进点「登录」不该被要求重填）
    const code = typed || String(core.getConfig().mailAuthCode || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(user)) { json(res, 400, { ok: false, error: '请填写正确的邮箱地址' }); return; }
    // 授权码格式不合法时绝不保存、更不显示「已登录」：以前 9 位错误码被当成已连接，发信必被 535 拒绝
    const host = String(b.host || core.getConfig().mailHost || 'smtp.qq.com').trim();
    const issue = mail.authCodeIssue({ authCode: code, host });
    if (issue) {
      json(res, 400, {
        ok: false, connected: false, error: issue,
        hint: 'QQ 邮箱 → 设置 → 账号 → 安全设置 → 开启 IMAP/SMTP 服务 → 生成 16 位授权码（不是 QQ 密码）'
      });
      return;
    }
    const patch = {
      mailUser: user, mailAuthCode: code,
      mailTo: String(b.to || user).trim(), mailEnabled: true
    };
    if (b.host) patch.mailHost = String(b.host).trim();
    if (b.port) patch.mailPort = Number(b.port);
    core.saveConfig(patch);
    let verify = null;
    if (b.verify !== false) {
      try { verify = await mail.test(); } catch (e) { verify = { sent: false, reason: e.message }; }
    }
    const s = mail.status();
    json(res, 200, {
      ok: true, connected: !!(s.enabled && s.ready && s.authCodeValid), verify,
      status: s, message: verify?.sent
        ? '登录成功，测试邮件已发出；凭证长期保存在本机，服务重启后自动恢复'
        : (verify ? `凭证已保存，但测试邮件未发出：${verify.reason}` : '凭证已保存（未发送测试邮件）')
    });
    return;
  }
  if (p === '/api/mail/logout' && method === 'POST') {
    core.saveConfig({ mailEnabled: false, mailUser: '', mailAuthCode: '', mailTo: '' });
    json(res, 200, { ok: true, connected: false, message: '已退出账号，本机保存的授权码已清除' });
    return;
  }
  if (p === '/api/mail/test' && method === 'POST') {
    try { json(res, 200, await mail.test()); }
    catch (e) { json(res, 400, { ok: false, sent: false, error: e.message }); }
    return;
  }
  if (p === '/api/mail/config' && method === 'POST') {
    const b = await readBody(req);
    const allowed = ['mailEnabled', 'mailOnOnline', 'mailOnOffline', 'mailOnGame',
      'mailMinIntervalSec', 'mailQuiet', 'mailSubjectPrefix', 'mailTo',
      'mailUser', 'mailHost', 'mailPort'];
    const patch = {};
    for (const k of allowed) if (b[k] !== undefined) patch[k] = b[k];
    core.saveConfig(patch);
    json(res, 200, { ok: true, status: mail.status() });
    return;
  }

  /* ---------------- 愿望单降价 / 回涨 ---------------- */
  if (p === '/api/wishlist' && method === 'GET') {
    json(res, 200, wishlist.status());
    return;
  }
  if (p === '/api/wishlist/check' && method === 'POST') {
    try {
      const r = await runWishlistCheck();
      invalidate();
      json(res, 200, r);
    } catch (e) { json(res, 400, { ok: false, error: e.message }); }
    return;
  }
  if (p === '/api/wishlist/config' && method === 'POST') {
    const b = await readBody(req);
    const patch = {};
    if (b.thresholdYuan !== undefined) patch.wishlistThresholdYuan = Math.max(1, Math.min(9999, Number(b.thresholdYuan) || 30));
    if (b.enabled !== undefined) patch.wishlistNotifyEnabled = !!b.enabled;
    if (b.checkHours !== undefined) patch.wishlistCheckHours = Math.max(1, Math.min(168, Number(b.checkHours) || 6));
    core.saveConfig(patch);
    json(res, 200, { ok: true, status: wishlist.status() });
    return;
  }
  /* 愿望单降价 / 回涨：某款游戏「不再提醒」+ 删掉它的提醒记录 */
  if (p === '/api/wishlist/mute' && method === 'POST') {
    const b = await readBody(req);
    json(res, 200, wishlist.setMuted(b.appid, b.muted !== false));
    return;
  }
  if (p === '/api/wishlist/alert-delete' && method === 'POST') {
    const b = await readBody(req);
    json(res, 200, wishlist.deleteAlert(b.ts));
    return;
  }

  /* ---------------- 手机号通知（短信） ---------------- */
  if (p === '/api/sms/status' && method === 'GET') { json(res, 200, sms.status()); return; }
  if (p === '/api/sms/config' && method === 'POST') {
    const b = await readBody(req); json(res, 200, sms.saveConfig(b)); return;
  }
  if (p === '/api/sms/toggle' && method === 'POST') {
    const b = await readBody(req); json(res, 200, sms.setEvent(b.event, b.enabled)); return;
  }
  if (p === '/api/sms/all' && method === 'POST') {
    const b = await readBody(req); json(res, 200, sms.setAll(b.enabled)); return;
  }
  if (p === '/api/sms/test' && method === 'POST') {
    try { json(res, 200, await sms.test()); } catch (e) { json(res, 200, { ok: false, reason: e.message }); }
    return;
  }

  /* ---------------- 个性化 / 动态壁纸（小红车 431960） ---------------- */
  if (p === '/api/wallpaper/status' && method === 'GET') {
    try { json(res, 200, wallpaper.status()); } catch (e) { json(res, 200, { ok: false, error: e.message, items: [] }); }
    return;
  }
  if (p === '/api/wallpaper/scan' && method === 'POST') { json(res, 200, wallpaper.rescan()); return; }
  if (p === '/api/wallpaper/config' && method === 'POST') {
    const b = await readBody(req); json(res, 200, wallpaper.setConfig(b)); return;
  }
  if (p === '/api/wallpaper/reset' && method === 'POST') { json(res, 200, { ok: true, status: wallpaper.reset() }); return; }
  /* 软件内删除壁纸：只从列表隐藏，不碰小红车目录里的文件；重新扫描会恢复 */
  if (p === '/api/wallpaper/hide' && method === 'POST') {
    const b = await readBody(req);
    json(res, 200, wallpaper.hideWallpaper(b.id, b.src));
    return;
  }
  if ((p === '/api/wallpaper/preview' || p === '/api/wallpaper/media') && method === 'GET') {
    const which = p === '/api/wallpaper/preview' ? 'preview' : 'media';
    wallpaper.serveFile(req, res, wallpaper.fileFor(u.searchParams.get('id'), u.searchParams.get('src'), which));
    return;
  }
  /* 网页壁纸：/api/wallpaper/html/<id>/<src>/<相对路径>，相对资源能正常解析 */
  if (p.startsWith('/api/wallpaper/html/')) {
    const parts = p.slice('/api/wallpaper/html/'.length).split('/');
    const id = decodeURIComponent(parts.shift() || '');
    const src = parts.shift() || 'local';
    let rel = '';
    try { rel = parts.map(decodeURIComponent).join('/'); } catch { rel = ''; }
    wallpaper.serveFile(req, res, wallpaper.fileFor(id, src, 'asset', rel));
    return;
  }
  if (p === '/api/wallpaper/workshop' && method === 'GET') {
    try { json(res, 200, { ok: true, items: await wallpaper.workshopDetails(u.searchParams.get('id') || '') }); }
    catch (e) { json(res, 200, { ok: false, error: e.message, items: [] }); }
    return;
  }
  if (p === '/api/wallpaper/workshop/download' && method === 'POST') {
    const b = await readBody(req);
    try { json(res, 200, await wallpaper.downloadWorkshop(b.id || b.url || '')); }
    catch (e) { json(res, 200, { ok: false, error: e.message }); }
    return;
  }

  /* ---------------- 个性化：我的照片壁纸（小红车 project.json）+ 自定义开场视频 ----------------
     上传走原始二进制，原图字节原样落盘；照片不重编码、不缩放，避免像素化。 */
  if (p === '/api/personal/status' && method === 'GET') { json(res, 200, personal.status()); return; }
  if (p === '/api/personal/upload' && method === 'POST') {
    const kind = String(q.get('kind') || '');
    const ext = String(q.get('ext') || '');
    if (kind !== 'photo' && kind !== 'video') { json(res, 400, { ok: false, error: 'kind 只能是 photo 或 video' }); return; }
    try {
      const buf = await readRawBody(req, kind === 'video' ? personal.VIDEO_LIMIT : personal.PHOTO_LIMIT);
      if (!buf.length) { json(res, 400, { ok: false, error: '文件是空的' }); return; }
      json(res, 200, kind === 'photo' ? personal.savePhoto(buf, ext) : personal.saveVideo(buf, ext));
    } catch (e) { json(res, 400, { ok: false, error: e.message }); }
    return;
  }
  if (p === '/api/personal/remove' && method === 'POST') {
    const b = await readBody(req);
    json(res, 200, personal.remove(String(b.kind || '')));
    return;
  }
  if (p === '/api/personal/video' && method === 'GET') { wallpaper.serveFile(req, res, personal.videoFile()); return; }
  if (p === '/api/personal/photo' && method === 'GET') { wallpaper.serveFile(req, res, personal.photoFile()); return; }

  /* ---------------- Steam 客户端好友直读（全自动，无需 API Key） ---------------- */
  if (p === '/api/steam-client/status' && method === 'GET') { json(res, 200, steamClient.status()); return; }
  if (p === '/api/steam-client/poll' && method === 'POST') {
    const r = await steamClient.poll({ forceDiscover: q.get('force') === '1' });
    if (r.ok && r.changed) { invalidateFriends(); await getFriends(true).catch(() => {}); }
    json(res, 200, r);
    return;
  }

  /* ---------------- 好友上线系统 ---------------- */
  if (p === '/api/friends/diagnosis' && method === 'GET') {
    const c = core.getConfig();
    const f = await getFriends(false);
    const bs = browserScan.status().friendSession;
    const sc = friends.steamClientSummary();
    const sources = [];
    if (sc.active) sources.push('Steam 客户端好友列表（直读）');
    if (c.apiKey) sources.push('Steam Web API Key');
    if (friends.hasBrowserStates()) sources.push('浏览器已登录会话');
    if (c.friendPastedSummaries) sources.push('粘贴的 JSON');
    const steps = [];
    if (!sources.length) {
      steps.push('① 打开 Steam 客户端，点右下角「好友与聊天」（窗口可以最小化）');
      steps.push('② SteamLens 会每 3 秒直接读取 Steam 自己显示的好友在线状态，无需 API Key');
      steps.push('③ 好友上线时，面板和上线动态会自动更新，并按你设置的通道通知');
    } else if (!f.hasBaseline) {
      steps.push('状态源已就绪，正在建立第一份基线；好友下一次上线起就会记录事件。');
    } else {
      steps.push('状态源正常，Steam 客户端每 3 秒同步一次，上线 / 退出 Steam / 开始玩游戏都会自动记录。');
    }
    steps.push(c.friendNotifyOffline === false
      ? '「好友退出 Steam 推送」当前已关闭，可在「通知与邮箱」页重新打开。'
      : '好友退出 Steam 时会额外推送一条「XXX 退出 Steam 了」，通道与上线通知一致。');
    json(res, 200, {
      ok: true, serverNow: Date.now(),
      apiKeySet: !!c.apiKey, pastedSet: !!c.friendPastedSummaries,
      browserSession: bs, browserStatesValid: friends.hasBrowserStates(),
      steamClient: sc, steamClientRaw: steamClient.status(),
      sources, dataMode: f.dataMode, dataModeLabel: f.dataModeLabel,
      sourceNote: f.sourceNote || '', totals: f.totals,
      hasBaseline: f.hasBaseline, events: f.stats?.totalEvents || 0,
      poll: autoRefresh.friends,
      friendPollSec: Number(c.friendPollSec || 60), friendNotify: c.friendNotify !== false,
      friendNotifyOffline: c.friendNotifyOffline !== false,
      offlinePush: {
        enabled: c.friendNotifyOffline !== false,
        mail: mail.cfg().onOffline, wechat: wechat.cfg().onOffline,
        qq: qq.cfg().onOffline, dingtalk: dingtalk.cfg().onOffline
      },
      warnings: f.warnings || [], steps,
      rootCause: sources.length ? '' : '没有任何在线状态来源：之前后台轮询被跳过，只能显示本机缓存名册、状态未知，也不会产生上线事件。现已改为直读 Steam 客户端好友列表。'
    });
    return;
  }
  if (p === '/api/friends' && method === 'GET') {
    const f = await getFriends(q.get('refresh') === '1');
    json(res, 200, { ...f, friends: friendProfile.attachToList(f.friends), profiles: friendProfile.list() });
    return;
  }
  /* 上线时段分布 / 好友离开时长：每秒轻量视图，只读本机事件 / 状态，不联网、不写盘 */
  if (p === '/api/friends/hourly' && method === 'GET') {
    json(res, 200, friends.hourly(q.get('range') || '1d')); return;
  }
  if (p === '/api/friends/away' && method === 'GET') { json(res, 200, friends.away()); return; }
  if (p === '/api/friends/refresh' && method === 'POST') {
    const f = await getFriends(true);
    json(res, 200, { ok: true, state: { ...f, friends: friendProfile.attachToList(f.friends) } });
    return;
  }
  if (p === '/api/friends/events' && method === 'GET') {
    const all = friends.loadEvents();
    json(res, 200, { events: all.slice(-Number(q.get('limit') || 200)).reverse(), total: all.length });
    return;
  }
  if (p === '/api/friends/star' && method === 'POST') {
    const b = await readBody(req);
    if (!b.steamId64) { json(res, 400, { error: '缺少 steamId64' }); return; }
    friends.setStar(b.steamId64, !!b.starred);
    invalidateFriends();
    json(res, 200, { ok: true });
    return;
  }
  if (p === '/api/friends/add' && method === 'POST') {
    const b = await readBody(req);
    const id = String(b.steamId64 || '').trim();
    if (!/^7656119\d{10}$/.test(id)) { json(res, 400, { error: 'SteamID64 格式不正确（应为 17 位，7656119 开头）' }); return; }
    friends.addManual(id, b.name || '');
    invalidateFriends();
    json(res, 200, { ok: true, state: await getFriends(true) });
    return;
  }
  if (p === '/api/friends/remove' && method === 'POST') {
    const b = await readBody(req);
    friends.removeManual(b.steamId64);
    invalidateFriends();
    json(res, 200, { ok: true, state: await getFriends(true) });
    return;
  }
  if (p === '/api/friends/config' && method === 'POST') {
    const b = await readBody(req);
    const allowed = ['apiKey', 'steamId64', 'friendPollSec', 'friendNotify', 'friendNotifyOffline', 'friendLoadRemoteAvatars',
      'friendPastedSummaries', 'friendNotifyScope', 'notifyDesktop', 'notifySound', 'notifyScope',
      'notifyWebhookUrl', 'notifyWebhookType', 'notifyMinIntervalSec'];
    const patch = {};
    for (const k of allowed) if (b[k] !== undefined) patch[k] = b[k];
    core.saveConfig(patch);
    invalidateFriends();
    json(res, 200, { ok: true, state: await getFriends(true) });
    return;
  }
  if (p === '/api/friends/clear-events' && method === 'POST') {
    friends.clearEvents();
    invalidateFriends();
    json(res, 200, { ok: true });
    return;
  }
  /* ---------------- 只删软件上的好友（Steam 好友关系一律不动） ---------------- */
  if (p === '/api/friends/clean/analyze' && method === 'GET') {
    json(res, 200, friends.analyzeFriends()); return;
  }
  if (p === '/api/friends/clean/remove' && method === 'POST') {
    const b = await readBody(req);
    const r = friends.removeFriends(b || {});
    if (r.ok) invalidateFriends();
    json(res, 200, r); return;
  }
  if (p === '/api/friends/clean/restore' && method === 'POST') {
    const b = await readBody(req);
    const r = friends.restoreFriends(b?.ids);
    invalidateFriends();
    json(res, 200, r); return;
  }
  /* 关闭软件时用 sendBeacon 把好友记录落盘；下次打开先显示缓存，再去 Steam 更新 */
  if (p === '/api/friends/cache' && method === 'POST') {
    const b = await readBody(req);
    const r = friends.saveListCache(b || {});
    /* 同时刷新离线快照：下次导出的离线单文件也带这份好友记录 */
    try {
      if (r.ok && Array.isArray(b.friends)) {
        offline.writeSnapshot({ friendListCache: b, friends: b });
      }
    } catch {}
    json(res, 200, r); return;
  }
  if (p === '/api/friends/cache' && method === 'GET') {
    json(res, 200, { ok: true, cache: friends.listCache() }); return;
  }
  if (p.startsWith('/api/friend-avatar/')) {
    const id = p.slice('/api/friend-avatar/'.length).replace(/[^\d]/g, '');
    const f = friends.avatarFileFor(id);
    if (!f) { send(res, 404, '', 'image/png'); return; }
    try {
      const buf = fs.readFileSync(f);
      const ext = path.extname(f).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
      res.end(buf);
    } catch { send(res, 404, '', 'image/png'); }
    return;
  }

  if (p === '/api/state' && method === 'GET') {
    const s = await getState(q.get('mode') || 'auto', q.get('force') === '1');
    json(res, 200, s);
    return;
  }

  if (p === '/api/rescan' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    hidden.scan('强制重扫');
    invalidate();
    const s = await getState(body.mode || currentMode, true);
    json(res, 200, { ok: true, state: s });
    return;
  }

  if (p === '/api/config') {
    if (method === 'GET') {
      const c = core.getConfig();
      json(res, 200, { ...c, apiKeySet: !!c.apiKey, pastedJsonSet: !!c.pastedOwnedGames, detectedRoots: core.detectSteamRoots() });
    } else {
      const body = await readBody(req);
      const c = core.saveConfig(body);
      invalidate();
      json(res, 200, { ok: true, config: { ...c, apiKeySet: !!c.apiKey } });
    }
    return;
  }

  if (p === '/api/override' && method === 'POST') {
    const body = await readBody(req);
    if (!body.appid) { json(res, 400, { error: '缺少 appid' }); return; }
    const allowed = ['name', 'playtimeMin', 'priceCents', 'markedPrivate', 'hiddenBySteam', 'targetHours'];
    const patch = {};
    for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
    core.saveOverride(String(body.appid), patch);
    // 手动改「Steam 隐藏标记」时同步自动识别名册：取消后不会被下一轮自动加回
    if (patch.hiddenBySteam === false) hidden.remove(String(body.appid));
    else if (patch.hiddenBySteam === true) hidden.addManual(String(body.appid));
    invalidate();
    const s = await getState(currentMode, true);
    json(res, 200, { ok: true, totals: s.totals });
    return;
  }

  if (p === '/api/estimate' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const s = await getState(body.mode || currentMode);
    let ids;
    if (body.appids && Array.isArray(body.appids)) ids = body.appids.map(String);
    else if (body.refreshAll) ids = s.games.map(g => String(g.appid));
    else ids = core.missingPriceIds(s.games); // 失败结果短 TTL 自动重试
    const r = startEstimateJob(ids, '手动');
    json(res, 200, { ...r, notice: '将向 store.steampowered.com 并发查询商店标价，仅用于估价。' });
    return;
  }

  if (p === '/api/estimate/status' && method === 'GET') { json(res, 200, estimateStatus()); return; }

  if (p === '/api/snapshots' && method === 'GET') {
    json(res, 200, { snapshots: core.getSnapshots() });
    return;
  }

  if (p === '/api/export' && method === 'GET') {
    const s = await getState(q.get('mode') || currentMode);
    const mask = q.get('mask') !== '0';
    const fmt = (q.get('format') || 'md').toLowerCase();
    if (fmt === 'csv') {
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="steamlens-games.csv"', 'Cache-Control': 'no-store' });
      res.end(core.exportCSV(s, mask)); return;
    }
    if (fmt === 'json') { json(res, 200, s); return; }
    send(res, 200, core.exportMarkdown(s, mask), 'text/markdown; charset=utf-8');
    return;
  }

  if (p === '/api/context' && method === 'GET') {
    const s = await getState(q.get('mode') || currentMode);
    send(res, 200, core.exportMarkdown(s, q.get('mask') !== '0'), 'text/markdown; charset=utf-8');
    return;
  }

  if (p.startsWith('/api/cover/')) {
    const appid = p.slice('/api/cover/'.length).replace(/[^\d]/g, '');
    const f = coverFile(appid);
    if (!f) { send(res, 404, '', 'image/png'); return; }
    try {
      const buf = fs.readFileSync(f);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
      res.end(buf);
    } catch { send(res, 404, '', 'image/png'); }
    return;
  }

  /* ---------------- 离线模式：本机快照 / 变更回传合并 ---------------- */
  if (p === '/api/offline/status' && method === 'GET') { json(res, 200, offline.status()); return; }
  if (p === '/api/offline/snapshot' && method === 'GET') {
    const snap = offline.getSnapshot() || offline.writeSnapshot({});
    json(res, 200, snap);
    return;
  }
  if (p === '/api/offline/refresh' && method === 'POST') {
    const truth = account.getTruth();
    const parts = {
      state: await getState(currentMode, false).catch(() => null),
      friends: await getFriends(false).catch(() => null),
      account: { ...account.publicView(truth), profile: truth.profile, owned: (truth.owned || []).slice(0, 300) },
      notify: { config: notify.cfg(), history: notify.getHistory() },
      mail: mail.status(),
      wishlist: wishlist.status(),
      browser: browserScan.status(),
      hidden: hidden.status(),
      wechat: wechat.status(),
      qq: qq.status(),
      dingtalk: dingtalk.status(),
      autorefresh: autoRefresh,
      friendProfiles: friendProfile.list()
    };
    invalidate();
    json(res, 200, { ok: true, generatedAt: offline.writeSnapshot(parts).generatedAt });
    return;
  }
  if (p === '/api/offline/sync' && method === 'POST') {
    const b = await readBody(req);
    try { invalidate(); json(res, 200, offline.sync(b)); }
    catch (e) { json(res, 400, { ok: false, error: e.message }); }
    return;
  }
  if (p === '/api/offline/notes' && method === 'GET') { json(res, 200, { ok: true, notes: offline.readNotes().slice(-50).reverse() }); return; }
  if (p === '/api/offline/notes' && method === 'POST') {
    const b = await readBody(req);
    if (!b.text) { json(res, 400, { error: '缺少 text' }); return; }
    json(res, 200, { ok: true, notes: offline.addNote(b.text, b.source || '离线记录') });
    return;
  }
  if (p === '/api/offline/export' && method === 'GET') {
    const snap = offline.getSnapshot() || offline.writeSnapshot({});
    send(res, 200, JSON.stringify(snap, null, 2), 'application/json; charset=utf-8');
    return;
  }
  /* 把在线版的动态壁纸文件复制进离线包文件夹（相对路径引用，可整个文件夹拷走） */
  if (p === '/api/offline/wallpaper-pack' && method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    try { json(res, 200, offline.buildWallpaperPack({ full: b.full === true || b.full === 1 || b.full === '1', budgetMB: Number(b.budgetMB) || 0 })); }
    catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  /* 打开离线包文件夹（壁纸已复制进去，整个文件夹可拷到别的电脑双击用） */
  if (p === '/api/offline/reveal' && method === 'POST') {
    try {
      const dir = offline.PACK_DIR;
      fs.mkdirSync(dir, { recursive: true });
      if (process.platform === 'win32') {
        require('node:child_process').spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
      }
      json(res, 200, { ok: true, dir });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return;
  }

  /* 把当前全部内容打包进单文件离线版并下载：先重新固化快照（顺带重建 HTML） */
  if (p === '/api/offline/standalone' && method === 'GET') {
    try {
      const truth = account.getTruth();
      const parts = {
        state: await getState(currentMode, false).catch(() => null),
        friends: await getFriends(false).catch(() => null),
        account: { ...account.publicView(truth), profile: truth.profile, owned: (truth.owned || []).slice(0, 300) },
        notify: { config: notify.cfg(), history: notify.getHistory() },
        mail: mail.status(),
        wishlist: wishlist.status(),
        browser: browserScan.status(),
        hidden: hidden.status(),
        wechat: wechat.status(),
        qq: qq.status(),
        dingtalk: dingtalk.status(),
        autorefresh: autoRefresh,
        friendProfiles: friendProfile.list()
      };
      offline.writeSnapshot(parts);
      offline.buildWallpaperPack();   // 顺带把动态壁纸文件复制进离线包并重建两份 HTML
      const f = offline.STANDALONE_FILE;
      if (!fs.existsSync(f)) { json(res, 404, { error: '离线文件尚未生成' }); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': 'attachment; filename="SteamLens-Offline.html"' });
      fs.createReadStream(f).pipe(res);
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  /* ---------------- 钉钉通知（群机器人 Webhook，只发给自己） ---------------- */
  if (p === '/api/dingtalk/status' && method === 'GET') { json(res, 200, dingtalk.status()); return; }
  if (p === '/api/dingtalk/connect' && method === 'POST') {
    const b = await readBody(req);
    try { json(res, 200, await dingtalk.connect(b)); }
    catch (e) { json(res, 400, { ok: false, error: e.message }); }
    return;
  }
  if (p === '/api/dingtalk/disconnect' && method === 'POST') { json(res, 200, dingtalk.disconnect()); return; }
  if (p === '/api/dingtalk/test' && method === 'POST') { json(res, 200, await dingtalk.test()); return; }
  if (p === '/api/dingtalk/config' && method === 'POST') {
    const b = await readBody(req);
    json(res, 200, { ok: true, applied: dingtalk.saveConfig(b), status: dingtalk.status() });
    return;
  }

  /* ---------------- 好友档案：游戏时长 / 库价值 ---------------- */
  if (p === '/api/friend-profile' && method === 'GET') {
    const id = String(q.get('steamId64') || '').trim();
    if (!id) { json(res, 400, { error: '缺少 steamId64' }); return; }
    // live=1：每秒轻量视图，只读本机，不联网、不写盘
    if (q.get('live') === '1') {
      json(res, 200, { ...friendProfile.live(id), libraryStatus: friendLibrary.status() });
      return;
    }
    try { json(res, 200, await friendProfile.profile(id, { refresh: q.get('refresh') === '1' })); }
    catch (e) { json(res, 400, { ok: false, error: e.message }); }
    return;
  }
  if (p === '/api/friend-profile' && method === 'POST') {
    const b = await readBody(req);
    try { json(res, 200, await friendProfile.profile(String(b.steamId64 || ''), { refresh: b.refresh !== false, pasted: b.pasted || '' })); }
    catch (e) { json(res, 400, { ok: false, error: e.message }); }
    return;
  }
  if (p === '/api/friend-profiles' && method === 'GET') { json(res, 200, friendProfile.list()); return; }

  /* ---------------- 好友「库中的游戏」：Steam 客户端直读 · 每秒更新 ---------------- */
  if (p === '/api/friend-library/status' && method === 'GET') { json(res, 200, friendLibrary.status()); return; }
  /* Steam 账号自动连接 + 登录记录 */
  if (p === '/api/account/link' && method === 'GET') { json(res, 200, accountLink.status()); return; }
  if (p === '/api/account/link' && method === 'POST') {
    try { const b = await readBody(req); json(res, 200, accountLink.setAutoLink(b.enabled !== false)); }
    catch (e) { json(res, 400, { ok: false, error: e.message }); }
    return;
  }
  if (p === '/api/account/logins' && method === 'GET') { json(res, 200, accountLink.logins()); return; }
  if (p === '/api/account/detect' && method === 'GET') {
    json(res, 200, { ok: true, accounts: accountLink.detectAllAccounts() });
    return;
  }
  if (p === '/api/friends/prune' && method === 'POST') {
    const b = await readBody(req);
    json(res, 200, friends.pruneNonFriends(!!b.apply));
    return;
  }
  if (p === '/api/friends/prune-preview' && method === 'GET') {
    json(res, 200, friends.pruneNonFriends(false));
    return;
  }
  if (p === '/api/friend-library/list' && method === 'GET') {
    json(res, 200, { ...friendLibrary.list(), friends: friendLibrary.snapshot()?.friends || {} });
    return;
  }
  if (p === '/api/friend-library/games' && method === 'GET') {
    const id = String(q.get('steamId64') || '').trim();
    if (!id) { json(res, 400, { error: '缺少 steamId64' }); return; }
    const lib = friendLibrary.library(id);
    json(res, 200, lib
      ? { ok: true, ...lib, status: friendLibrary.status() }
      : { ok: false, reason: '本机还没有这位好友的游戏库记录', status: friendLibrary.status() });
    return;
  }
  if (p === '/api/friend-library/refresh' && method === 'POST') {
    const b = await readBody(req);
    try {
      const r = await friendLibrary.refresh(String(b.steamId64 || ''));
      json(res, 200, { ok: true, friendCount: r?.friendCount ?? 0, totalApps: r?.totalApps ?? 0, status: friendLibrary.status() });
    } catch (e) { json(res, 400, { ok: false, error: e.message }); }
    return;
  }

  json(res, 404, { error: 'unknown endpoint', path: p });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${HOST}:${PORT}`);
    if (u.pathname.startsWith('/api/')) { await handleApi(req, res, u); return; }
    if (u.pathname === '/' || u.pathname === '/index.html') { serveStatic(res, 'index.html'); return; }
    if (u.pathname === '/favicon.ico') { send(res, 204, ''); return; }
    serveStatic(res, u.pathname.replace(/^\//, ''));
  } catch (e) {
    json(res, 500, { error: e.message, stack: String(e.stack || '').split('\n').slice(0, 4) });
  }
});

/* ---------------- 后台持续运行（面板关着也全部生效） ---------------- */

/* ★ 直接从 Steam 客户端「好友与聊天」窗口读在线状态：每 3 秒一次。
   状态一变就刷新好友缓存 → 生成上线事件 → 触发通知，不需要浏览器、不需要 API Key。 */
let steamClientPolling = false;
async function steamClientTick() {
  if (steamClientPolling) return;
  steamClientPolling = true;
  try {
    const r = await steamClient.poll();
    autoRefresh.friends.clientSource = r.ok ? 'Steam 客户端直读' : (r.error || '等待 Steam 好友窗口');
    if (r.ok && r.changed) {
      invalidateFriends();
      await getFriends(true);
      autoRefresh.friends.lastAt = Date.now();
      autoRefresh.friends.result = 'Steam 客户端状态变化 · 已自动更新';
    }
  } catch (e) { /* status() 会记录错误，绝不让定时器把服务拖挂 */ }
  finally { steamClientPolling = false; }
}
setInterval(steamClientTick, 3000).unref();
setTimeout(steamClientTick, 1200).unref();

/* ★ 好友「库中的游戏」：每秒从 Steam 客户端本机直读一次。
   一次 CDP 求值只有几毫秒，不联网、不写凭证；面板关着也持续更新。
   好友库为空时会按 30 秒节流请 Steam 客户端自己刷新缓存。 */
let libraryTicking = false;
async function friendLibraryTick() {
  if (libraryTicking) return;
  libraryTicking = true;
  try { await friendLibrary.tick(); }
  catch (e) { /* status() 会记录错误，绝不让定时器把服务拖挂 */ }
  finally { libraryTicking = false; }
}
setInterval(friendLibraryTick, 1000).unref();
setTimeout(friendLibraryTick, 700).unref();

/* ★ Steam 账号自动连接：每 5 秒检测本机登录账号，自动填入配置，并记录登录 / 退出 / 切换
   （地点 = 本机设备名，时间精确到秒，并推通知）。 */
let accountLinkTicking = false;
async function accountLinkTick() {
  if (accountLinkTicking) return;
  accountLinkTicking = true;
  try { accountLink.autoLink(); accountLink.watchLogin(); }
  catch (e) { /* 永不拖挂 */ }
  finally { accountLinkTicking = false; }
}
setInterval(accountLinkTick, 5000).unref();
setTimeout(accountLinkTick, 1500).unref();

/* 「QQ 登录 · 自己发自己」已移除：服务启动不再尝试自动重连 QQ 协议客户端 */

// 浏览器实时标签探测（CDP）：每秒监听「是否打开了 Steam 网页」，打开即识别并自动导入
try { browserScan.startCdpPolling(); } catch (e) { /* 不阻塞启动 */ }

// 好友状态轮询：上线事件会直接触发 Windows 弹窗 / Webhook / QQ 邮箱
let lastFriendPoll = 0;
setInterval(() => {
  const c = core.getConfig();
  const sec = Math.min(3600, Math.max(15, Number(c.friendPollSec) || 60));
  if (Number(c.friendPollSec) === 0) {
    autoRefresh.friends.result = '后台监控已暂停';
    return;
  }
  /* ★ 不再因为「没有 API Key」直接跳过轮询：浏览器已登录会话同样是合法状态源。
     无源时仍按间隔检查名册（不写基线），一旦采集器上报就能立刻产生上线事件。 */
  const sources = [];
  if (friends.hasSteamClientStates()) sources.push('Steam 客户端');
  if (c.apiKey) sources.push('Web API Key');
  if (c.friendPastedSummaries) sources.push('粘贴 JSON');
  if (friends.hasBrowserStates()) sources.push('浏览器会话');
  const sourceLabel = sources.length ? sources.join(' + ') : '等待状态来源（填 Key 或运行采集器）';
  autoRefresh.friends.nextAt = lastFriendPoll + sec * 1000;
  if (Date.now() - lastFriendPoll < sec * 1000) {
    if (!autoRefresh.friends.running) autoRefresh.friends.result = sourceLabel;
    return;
  }
  lastFriendPoll = Date.now();
  autoRefresh.friends.running = true;
  getFriends(true).then(() => {
    autoRefresh.friends.lastAt = Date.now();
    autoRefresh.friends.result = '状态已更新 · ' + sourceLabel;
    autoRefresh.friends.running = false;
  }).catch(e => {
    autoRefresh.friends.result = '轮询失败：' + e.message;
    autoRefresh.friends.running = false;
    console.error('[SteamLens 好友轮询]', e.message);
  });
}, 5000).unref();

// ★ Steam 隐藏游戏：默认每 60 秒自动识别一次，结果自动填入「隐私与隐藏」
setInterval(() => {
  try {
    const r = hidden.tick();
    const st = hidden.status();
    autoRefresh.hidden.lastAt = st.lastScanAt;
    autoRefresh.hidden.nextAt = st.nextAt;
    if (!r.skipped) {
      autoRefresh.hidden.result = `已识别 ${st.count} 款隐藏游戏（新增 ${r.added.length} / 移除 ${r.removed.length}）`;
      if (r.changed) invalidate();   // 让 /api/state 立刻带上最新隐藏清单
    }
    autoRefresh.hidden.running = false;
  } catch (e) { console.error('[SteamLens 隐藏识别]', e.message); }
}, 5000).unref();

// 价值 / 账号真实库 / 愿望单价格 / 总览每分钟提取 / 时长每小时全量提取
let lastValueRun = 0, lastLibraryRun = 0, lastWishlistRun = 0, lastOverviewRun = 0, lastPlaytimeRun = 0;
const due = (last, hours) => !last || Date.now() - last > hoursMs(hours);
setInterval(() => {
  const c = core.getConfig();
  // 卡死自愈：running 不可能永远不释放，否则 6 小时自动刷新会被一直挡住
  if (estimateJob.running && estimateStatus().stuck) {
    finishEstimate('估价任务超时，已自动结束并释放自动刷新');
    console.warn('[SteamLens 价值刷新] 检测到卡住的估价任务，已自动释放');
  }
  if (c.autoEstimateValue !== false && !estimateJob.running && !autoRefresh.value.running && due(lastValueRun, c.valueRefreshHours)) {
    lastValueRun = Date.now();
    runValueRefresh('定时').catch(e => console.error('[SteamLens 价值刷新]', e.message));
  }
  if (account.getTruth().connected && !autoRefresh.library.running && due(lastLibraryRun, c.librarySyncHours)) {
    lastLibraryRun = Date.now();
    runLibrarySync().catch(e => console.error('[SteamLens 账号同步]', e.message));
  }
  if ((account.getTruth().wishlist || []).length && !autoRefresh.wishlist.running && due(lastWishlistRun, c.wishlistCheckHours)) {
    lastWishlistRun = Date.now();
    runWishlistCheck().catch(e => console.error('[SteamLens 愿望单]', e.message));
  }
  // 总览：每分钟自动从本机 Steam 客户端重新提取（用户要求「总览一分钟更新一次」）
  const ovSec = Math.max(15, Number(c.overviewRefreshSec) || 60);
  if (!autoRefresh.overview.running && (!lastOverviewRun || Date.now() - lastOverviewRun >= ovSec * 1000)) {
    lastOverviewRun = Date.now();
    runOverviewExtract().catch(e => console.error('[SteamLens 总览提取]', e.message));
  }
  // Steam 游玩时长：每小时强制全量重扫一次（用户要求「一小时更新一次」）
  if (!autoRefresh.playtime.running && due(lastPlaytimeRun, Number(c.playtimeRefreshHours) || 1)) {
    lastPlaytimeRun = Date.now();
    runPlaytimeRefresh().catch(e => console.error('[SteamLens 时长提取]', e.message));
  }
}, 30000).unref();

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.log(`  端口 ${PORT} 已被占用：SteamLens 服务应该已经在运行。`);
    console.log(`  直接打开 http://${HOST}:${PORT}/ 即可。`);
    process.exit(0);
  }
  console.error('[SteamLens] 服务启动失败：', e.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════════════════════╗');
  console.log('  ║   SteamLens · Steam 透镜   本地服务已启动              ║');
  console.log('  ╚═══════════════════════════════════════════════════════╝');
  console.log(`   面板地址   http://${HOST}:${PORT}/`);
  console.log(`   项目目录   ${ROOT}`);
  console.log('   仅监听本机回环地址，数据不会上传到外部服务。');
  console.log('   自动刷新：库价值（每天）/ 账号真实库 / 愿望单价格 / 好友上线（含桌面与邮件通知）');
  console.log('   每 1 分钟：总览自动从本机 Steam 客户端重新提取时长与游戏库');
  console.log('   每 1 小时：Steam 游玩时长强制全量重扫并写快照');
  console.log('   每 60 秒：Steam 隐藏游戏自动识别并填入「隐私与隐藏」');
  console.log('   每秒：浏览器扫描状态同步（采集器运行时）');
  console.log('   24 小时常驻：由 keeper.js 守护，关窗口 / 退出本工具都不会停服务。');
  console.log('');

  // 启动即按本机真实好友名单清理「不是我好友」的人（无真实来源时自动跳过，避免误删）
  try {
    const fc = friends.friendConfig();
    if (fc.autoPruneNonFriends) {
      const r = friends.pruneNonFriends(true);
      if (r.applied) console.log(`   [启动清理] 已移除非好友 ${r.removedCount} 人，剩余 ${r.remainingCount} 人。`);
      else if (r.skipped) console.log('   [启动清理] 跳过：' + r.reason);
    }
  } catch (e) { console.error('   [启动清理] 失败：', e.message); }

  // 后台补全浏览器扫描到的 AppID 的中文名与封面（永久缓存，不阻塞面板）
  try { gameMeta.start(); } catch (e) { console.error('[SteamLens 游戏元数据]', e.message); }

  // 启动即扫描一次，打开面板就能看到 Steam 里已隐藏的游戏
  setTimeout(() => {
    try { const r = hidden.scan('服务启动'); console.log(`[SteamLens 隐藏识别] 启动完成：${r.total} 款`); }
    catch (e) { console.error('[SteamLens 隐藏识别]', e.message); }
  }, 1200).unref?.();

  // ★ 离线模式：启动后把全量数据固化到本机文件，之后每 2 分钟刷一次。
  //   服务器关掉时，直接双击 index.html 仍能读到这份真实数据。
  async function buildSnapshotParts() {
    const truth = account.getTruth();
    return {
      state: await getState(currentMode, false).catch(() => null),
      friends: await getFriends(false).catch(() => null),
      account: { ...account.publicView(truth), profile: truth.profile },
      notify: { config: notify.cfg(), history: notify.getHistory() },
      mail: mail.status(), wishlist: wishlist.status(), browser: browserScan.status(),
      hidden: hidden.status(), wechat: wechat.status(), qq: qq.status(),
      dingtalk: dingtalk.status(), autorefresh: autoRefresh, sms: sms.status(),
      wallpaper: wallpaper.status(),
      friendProfiles: friendProfile.list(), friendLibraries: friendLibrary.snapshot(),
      accountLink: accountLink.status(), accountLogins: accountLink.logins().logins,
      /* 「QQ 登录 · 自己发自己」已移除：离线快照不再固化任何 QQ 直登状态 */
      watchStatus: watchlist.snapshot(),
      steamClient: steamClient.status(), uiSettings: settings.get()
    };
  }
  async function solidifyOffline() {
    // 抛给调用方，好让「更新中心」能把失败记进日志
    return offline.writeSnapshot(await buildSnapshotParts());
  }
  const snapLog = e => console.error('[SteamLens 离线快照]', e.message);
  setTimeout(() => solidifyOffline().catch(snapLog), 3500).unref?.();
  setInterval(() => solidifyOffline().catch(snapLog), 120000).unref?.();

  /* 更新中心：每 60 秒自动跑一轮，失败时用户可点「一键更新」重跑同一批步骤 */
  updateCore.configure([
    {
      name: '好友与上线状态',
      run: async () => {
        const f = await getFriends(true);
        return `${f?.totals?.friends ?? 0} 位好友 · ${f?.totals?.online ?? 0} 位在线`;
      }
    },
    {
      name: 'Steam 账号连接',
      run: async () => {
        accountLink.autoLink(); accountLink.watchLogin();
        const s = accountLink.status();
        return s?.detected?.personaName
          ? `已连接 ${s.detected.personaName}（${s.detected.steamId64}）`
          : '等待 Steam 客户端登录';
      }
    },
    {
      name: '游戏库与本机数据',
      run: async () => {
        const s = await getState(currentMode, false);
        return `${s?.games?.length ?? 0} 款游戏`;
      }
    },
    {
      name: '愿望单价格 / 上线监控',
      run: async () => {
        const r = await watchlist.check({ auto: true });
        return r.message || `已检查 ${r.checked || 0} 款`;
      }
    },
    {
      name: '好友成就缓存',
      run: async () => {
        const n = Object.keys(friendAchievement.snapshot()).length;
        const d = friendAchievement.discovered();
        return `已保存 ${n} 份好友成就 · 关系链 ${d?.direct?.length ?? 0} 位好友`;
      }
    },
    {
      name: '离线快照与单文件',
      run: async () => {
        const snap = await solidifyOffline();
        const size = fs.existsSync(path.join(__dirname, 'SteamLens-Offline.html'))
          ? fs.statSync(path.join(__dirname, 'SteamLens-Offline.html')).size : 0;
        return `已固化 ${Object.keys(snap || {}).length} 类数据 · 离线单文件 ${(size / 1024).toFixed(0)} KB`;
      }
    }
  ]);
  // 每条更新日志写盘后重刷离线快照，离线版也能看到最新的秒级日志
  updateCore.setAfterLog(() => solidifyOffline().catch(() => {}));
  updateCore.start();

  /* 启动即修复：浏览器扫描已拿到 Steam 商店权威清单但账号真实库被清空时，
     立刻补回去，避免首次估价时所有游戏被判成「未验证」而显示 0。 */
  try {
    const repaired = browserScan.repairTruthFromBrowser();
    if (repaired && repaired.ok) { invalidate(); console.log(`[SteamLens 真实库修复] 已补回 ${repaired.owned} 款已购买游戏`); }
  } catch (e) { console.warn('[SteamLens 真实库修复]', e.message); }

  // 启动后自动补齐缺失价格，让「打开就有价值」而不是要手点
  setTimeout(() => {
    if (core.getConfig().autoEstimateValue === false) return;
    lastValueRun = Date.now();
    runValueRefresh('启动').catch(e => console.error('[SteamLens 启动估价]', e.message));
  }, 6000).unref?.();

  // 已有愿望单时，启动后错峰做一次价格基线 / 跨阈值检查
  setTimeout(() => {
    if (!(account.getTruth().wishlist || []).length) return;
    lastWishlistRun = Date.now();
    runWishlistCheck().catch(e => console.error('[SteamLens 启动愿望单]', e.message));
  }, 60000).unref?.();

  /* ----------------------------------------------------------------
   * 双向守护：常驻守护负责在服务挂掉时重拉服务；这里反过来，
   * 万一守护自己被结束，由服务把它拉回来。两者互相保活，
   * 只要有一个活着，24 小时在线就能自愈。
   * 锁端口 8788 只用于探测，不对外提供数据。
   * ---------------------------------------------------------------- */
  try {
    const net = require('node:net');
    setInterval(() => {
      const probe = net.connect(8788, '127.0.0.1');
      probe.setTimeout(1200);
      probe.on('connect', () => probe.destroy());
      probe.on('timeout', () => probe.destroy());
      probe.on('error', () => {
        try {
          const c = spawn(process.execPath, [path.join(__dirname, 'keeper.js'), '--loop'], {
            cwd: __dirname, detached: true, windowsHide: true, stdio: 'ignore',
            env: Object.assign({}, process.env, { STEAMLENS_NO_REG: '1' })
          });
          c.unref();
          console.log('[SteamLens 双向守护] 守护进程不在，已重新拉起');
        } catch (e) { /* 下一轮再试 */ }
      });
    }, 20000).unref?.();
  } catch (e) { /* 不影响服务主体 */ }
});

process.on('uncaughtException', e => console.error('[SteamLens]', e.message));
