/* SteamLens · 面板逻辑（纯原生 JS，无外部依赖） */
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const PALETTE = ['#2f6df6', '#7a63f5', '#10b39c', '#e29437', '#e05c6e', '#4aa3ff', '#9b7bf0', '#63c9a4'];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isDark = () => document.documentElement.dataset.theme === 'dark';
const inkColor = () => isDark() ? '#e9eefb' : '#17213a';
const subColor = () => isDark() ? '#8fa0c0' : '#7b8aa6';
const gridColor = () => isDark() ? 'rgba(255,255,255,.09)' : 'rgba(28,48,88,.09)';
const h = m => Math.round((m || 0) / 60 * 10) / 10;
const money = c => '¥' + (Number(c || 0) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shortMoney = c => '¥' + Math.round(Number(c || 0) / 100).toLocaleString('zh-CN');
const dateStr = ts => ts ? new Date(ts * 1000).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '—';
const timeStr = iso => iso ? new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

let S = null, DEMO = false, MODE = localStorage.getItem('sl-mode') || 'auto';
let MASK = localStorage.getItem('sl-mask') !== '0';
let FILTER = 'all', SORT = 'playtime', SEARCH = '';
let F = null, FFILTER = 'all', FSEARCH = '', savedPollSec = 60;
/* 长列表默认只显示 5 条，点「显示更多」才展开。状态放全局，避免每秒自动刷新把展开又收回去 */
let SL_MORE = { friends: false, discover: false, ptPeople: false, ptTimeline: false, ptGames: false, fpChips: false };
let lastEventTs = Number(localStorage.getItem('sl-last-event') || 0);

/* ==================================================================== */
/*  好友记录启动缓存：关闭软件时保存，打开时先显示记录，再去 Steam 更新      */
/* ==================================================================== */
const FRIEND_CACHE_KEY = 'sl-friend-cache-v1';
function friendCacheSlim() {
  if (!F || !Array.isArray(F.friends)) return null;
  try {
    return {
      ...F,
      friends: F.friends.slice(0, 400),
      events: (F.events || []).slice(0, 40),
      warnings: (F.warnings || []).slice(0, 6),
      slMore: { ...SL_MORE },
      savedAt: Date.now()
    };
  } catch { return null; }
}
function friendCacheSave(toServer = false) {
  const slim = friendCacheSlim(); if (!slim) return;
  try { localStorage.setItem(FRIEND_CACHE_KEY, JSON.stringify(slim)); } catch {}
  /* 关闭软件时用 sendBeacon 再写一份到服务端，离线单文件生成时也能带上最新好友记录 */
  if (toServer && !DEMO && typeof navigator !== 'undefined' && navigator.sendBeacon) {
    try {
      navigator.sendBeacon('/api/friends/cache',
        new Blob([JSON.stringify(slim)], { type: 'application/json' }));
    } catch {}
  }
}
function friendCacheRead() {
  try {
    const raw = localStorage.getItem(FRIEND_CACHE_KEY);
    if (raw) {
      const j = JSON.parse(raw);
      if (j && Array.isArray(j.friends) && j.friends.length &&
          Date.now() - Number(j.savedAt || 0) <= 30 * 86400000) return j;
    }
  } catch {}
  /* 离线单文件没有运行过在线版、localStorage 为空时，用打包时写进快照的好友记录，
     这样离线版一打开也能立刻看到好友，而不是先转圈。 */
  try {
    const j = window.SL_OFFLINE_DATA?.friendListCache;
    if (j && Array.isArray(j.friends) && j.friends.length) return j;
  } catch {}
  return null;
}
/** 打开软件的第一件事：不等 /api/friends，先把上次保存的好友渲染出来 */
function friendCacheHydrate() {
  const c = friendCacheRead(); if (!c) return false;
  try {
    F = { ...c, _fromCache: true };
    if (c.slMore && typeof c.slMore === 'object') Object.assign(SL_MORE, c.slMore);
    renderFriends();
    const tag = $('#friendsModeTag'); if (tag) tag.textContent = '本机缓存 · 正在从 Steam 更新…';
    const note = $('#friendCacheNote');
    if (note) note.textContent = `已显示上次关闭时保存的 ${F.friends.length} 位好友（${timeStr(c.savedAt)}）；正在后台从 Steam 客户端更新，记录不会被清空。`;
    return true;
  } catch { return false; }
}
window.addEventListener('pagehide', () => friendCacheSave(true));
window.addEventListener('beforeunload', () => friendCacheSave(true));
let editId = null, estTimer = null, SERVER_ROOT = 'D:\\SteamLens';
let A = null, N = null, W = null, AR = null, MAIL = null, SI = null, SMS = null, WP = null;   // 账号 / 通知 / 愿望单 / 自动刷新 / 邮箱 / 官方客户端 / 短信 / 壁纸
let UI = null, WECHAT = null, B = null, QQ = null;   // 服务端界面设置 / 微信 / 浏览器扫描 / QQ
let H = null;                              // Steam 隐藏游戏自动识别状态
let DT = null, FP = null, FL = null;       // 钉钉通知 / 好友档案列表 / 好友库中游戏快照
let ACCLINK = null, ACCLOGINS = [];        // Steam 账号自动连接状态 / 登录记录
let FRIEND_ACH = null;                     // 全部好友的成就缓存（在线 API / 离线快照）
let FA_SEL = { id: '', name: '' };          // 当前展开「他有什么成就」的那位好友
let WATCH = null, WATCH_RESULTS = [];       // 愿望单监控清单 / 搜索结果
let FDIAG = null;                          // 好友上线监控诊断（状态来源 / 根因）
let OFFLINE_BADGE_TIMER = null;
let estimatePolling = false;              // 是否正在跟踪服务端估价任务
let RESTORING = false;                     // 回填期间不触发自动保存
let FILTER_FIX_AVAILABLE = true;          // 只允许在「恢复旧设置后的首次渲染」自动回退一次
let FILTER_USER_SET = false;              // 用户手动点过筛选后，永远不再自动回退

const PAGE_META = {
  overview: ['总览', '你的 Steam 全景视图'],
  games: ['游戏库', '每款游戏的时长、安装状态与数据来源'],
  friends: ['好友上线', '谁在线、谁刚上线、谁在玩什么'],
  private: ['隐私与隐藏', '计入统计，但展示可脱敏'],
  value: ['库价值', '整体游戏库估值与投入产出比'],
  watch: ['愿望单', '价格 / 折扣 / 上线自动提醒'],
  syscheck: ['系统对比', '搜 Steam 游戏 · 设备需求 vs 我的电脑'],
  family: ['识别家庭', 'Steam 共享家庭：成员 / 各自库 / 家庭库总价值 + 动态通知'],
  progress: ['进度与快照', '每次扫描自动保存，追踪时间增量'],
  export: ['导出 / 交给 AI', '把数据交给 DeepSeek 分析'],
  account: ['Steam 账号', '只读授权 · 真实库 · 退款与愿望单识别'],
  notify: ['通知与邮箱', '上线弹窗 · QQ 邮箱 · 微信 · 愿望单降价提醒'],
  browser: ['浏览器扫描', '已购买清单 · 愿望单 · 购物车 · 每秒同步'],
  settings: ['设置保存', '所有改动自动落盘，重启不丢'],
  wallpaper: ['个性化 · 动态壁纸', '小红车壁纸 / Steam 创意工坊 · 把壁纸变成软件背景'],
  updates: ['更新', '每分钟自动更新 · 一键更新 · 秒级更新日志'],
  connect: ['连接与配对', '自动 / 手动模式与 MCP 接入']
};

/* ------------------------------ 演示数据（离线预览用） ------------------------------ */
function demoState() {
  const now = Date.now();
  const raw = [
    ['Counter-Strike 2', 3691, 226, 3, 0, false],
    ['Baldur\'s Gate 3', 1331, 0, 98, 0, false],
    ['Dota 2', 704, 12, 0, 1, false],
    ['Elden Ring', 613, 0, 248, 0, false],
    ['Stardew Valley', 486, 69, 48, 0, false],
    ['Wallpaper Engine', 306, 10, 22, 0, false],
    ['Cyberpunk 2077', 269, 0, 298, 0, false],
    ['Hades', 213, 0, 98, 0, false],
    ['Terraria', 163, 0, 36, 0, false],
    ['Portal 2', 104, 0, 68, 0, false],
    ['某款私密游戏 A', 152, 33, 88, 0, true],
    ['某款私密游戏 B', 61, 0, 42, 0, true]
  ];
  const games = raw.map((r, i) => {
    const [name, min, w2, yuan, free, priv] = r;
    const appid = String(730 + i * 1117);
    return {
      appid, name, playtimeMin: min, playtimeHours: h(min), playtime2wksMin: w2, playtime2wksHours: h(w2),
      lastPlayed: Math.floor(now / 1000) - i * 86400 * 3, installed: i % 3 !== 2, sizeGB: 4 + i * 3.2,
      priceCents: yuan * 100, priceStatus: yuan ? 'estimated' : 'free', priceCurrency: 'CNY',
      priceSource: yuan ? 'Steam 商店当前标价（原价，非实际购入价）' : '', isFree: !yuan,
      hiddenBySteam: priv && i === 10, markedPrivate: priv, effectivePrivate: priv,
      hourlyCost: yuan && min ? Math.round(yuan / (min / 60) * 100) / 100 : null,
      sources: { playtime: 'localconfig.vdf (本地·不受隐私设置影响)', name: 'appmanifest' },
      cover: `/api/cover/${appid}`
    };
  });
  const totalMinutes = games.reduce((a, g) => a + g.playtimeMin, 0);
  const valueCents = games.reduce((a, g) => a + (g.priceCents || 0), 0);
  const snapshots = Array.from({ length: 9 }, (_, i) => ({
    ts: now - (8 - i) * 86400000 * 2, iso: new Date(now - (8 - i) * 86400000 * 2).toISOString(),
    totalMinutes: Math.round(totalMinutes - (8 - i) * 46), totalValueCents: valueCents, mode: 'auto'
  }));
  return {
    generatedAt: new Date().toISOString(), mode: MODE,
    connection: {
      type: MODE === 'auto' ? '离线演示 · 自动连接' : '离线演示 · 手动连接',
      account: { personaName: '演示账号', accountName: 'demo_user', steamId64: '76561198000000000', avatar: null },
      steamRoot: '（未连接本地服务）', steamRootSource: '', libraries: [], localFiles: [],
      userdataAccounts: [], usedApi: false, usedPastedJson: false, apiGameCount: 0, localRecordCount: 12,
      warnings: ['当前为离线演示数据：请先双击「启动 SteamLens.bat」启动本地服务，即可读取真实数据。']
    },
    totals: {
      games: games.length, installed: games.filter(g => g.installed).length, playedGames: games.length,
      totalMinutes, totalHours: h(totalMinutes), last14Minutes: games.reduce((a, g) => a + g.playtime2wksMin, 0),
      last14Hours: h(games.reduce((a, g) => a + g.playtime2wksMin, 0)),
      totalSizeGB: games.reduce((a, g) => a + g.sizeGB, 0), totalValueCents: valueCents,
      totalValueYuan: Math.round(valueCents / 100), valuedGames: games.filter(g => g.priceCents > 0).length,
      freeGames: 2, hiddenGames: 1, privateGames: 2, privateMinutes: 213,
      avgCostPerHour: Math.round(valueCents / 100 / (totalMinutes / 60) * 100) / 100
    },
    games, snapshots,
    deltas: { hasBaseline: true, since: snapshots[7].iso, minutes: 46, top: [{ appid: games[0].appid, name: games[0].name, minutes: 31 }] },
    privacy: {
      localOnly: true,
      statement: '时长、隐藏游戏、账号信息全部来自本机文件；除「估算库价值」外不向任何服务器发送数据。',
      priceBasis: '库价值按 Steam 商店当前人民币原价估算，不等于实际购入价，不含历史折扣、区服差异、DLC 与内购。',
      privateRule: '标记为隐私的游戏名称可脱敏显示，但时长与价值始终计入总量统计。'
    }
  };
}

/* ------------------------------ 演示好友数据 ------------------------------ */
function demoFriends() {
  const now = Date.now();
  const mk = (id, name, st, game, star, src) => ({
    steamId64: id, name, personastate: st, stateLabel: ({ 0: '离线', 1: '在线', 2: '忙碌', 3: '离开' })[st],
    tone: ({ 0: 'off', 1: 'on', 2: 'busy', 3: 'away' })[st], game: game || '', lastLogoff: Math.floor(now / 1000) - 3600,
    starred: star, source: src || '本机缓存名册', live: true, avatar: '', localAvatar: false, profileUrl: ''
  });
  const friends = [
    mk('76561198000000000', '示例好友', 1, 'Counter-Strike 2', true),
    mk('76561198000000001', '阿泽', 1, '', false),
    mk('76561198000000002', '小鱼干', 2, 'Baldur\'s Gate 3', true),
    mk('76561198000000003', 'Kira', 0, '', false),
    mk('76561198000000004', '老王', 3, '', false),
    mk('76561198000000005', 'Neko', 0, '', false, 'GetFriendList')
  ];
  const ev = [
    { ts: now - 6 * 60000, iso: new Date(now - 6 * 60000).toISOString(), name: '示例好友', type: 'online', text: '示例好友 上线了' },
    { ts: now - 22 * 60000, iso: new Date(now - 22 * 60000).toISOString(), name: '小鱼干', type: 'game', text: '小鱼干 开始玩 Baldur\'s Gate 3' },
    { ts: now - 58 * 60000, iso: new Date(now - 58 * 60000).toISOString(), name: 'Kira', type: 'offline', text: 'Kira 下线了' }
  ];
  return {
    generatedAt: new Date(now).toISOString(), dataMode: 'roster',
    dataModeLabel: '离线演示 · 仅本机名册', mySteamId: '',
    warnings: ['当前为离线演示数据：启动本地服务后可读取本机好友名册；填入 Web API Key 即可实时监控上线。'],
    config: { friendPollSec: 60, friendNotify: true, friendLoadRemoteAvatars: false, hasApiKey: false, mySteamId: '' },
    hasBaseline: true,
    totals: { friends: 6, online: 3, ingame: 2, busy: 1, away: 1, offline: 2, unknown: 0, starred: 2, localCached: 5 },
    friends, events: ev,
    stats: { todayLogins: 4, todayOnlineMinutes: 186.5, totalEvents: 3,
      topFriends: [{ name: '示例好友', onlineMinutes: 96, logins: 2 }, { name: '小鱼干', onlineMinutes: 62, logins: 1 }],
      hourBuckets: [0, 0, 0, 0, 0, 0, 0, 1, 0, 2, 1, 0, 0, 1, 0, 2, 0, 1, 0, 2, 3, 1, 0, 0] },
    privacy: { statement: '好友名册来自本机 Steam 缓存；实时状态需你主动填入 Web API Key 才会查询。所有记录只写入本机 data/ 目录，不上传第三方。', caveat: '上线事件由轮询对比得出，精度取决于轮询间隔。' }
  };
}

/* ------------------------------ 请求 ------------------------------ */
const OFF = window.SLOffline || null;
const API_ORIGIN = window.SL_API_ORIGIN || '';
const absUrl = p => (/^https?:\/\//i.test(p) ? p : API_ORIGIN + p);
/* 单文件离线版把二维码内联为 data URI；在线 / 普通 file:// 时退回原来的相对路径 */
const INLINE_IMAGES = window.SL_INLINE_IMAGES || {};
const assetUrl = p => {
  const key = String(p || '').replace(/^\.?\//, '');
  if (INLINE_IMAGES[key]) return INLINE_IMAGES[key];
  return API_ORIGIN ? API_ORIGIN + '/' + key : key;
};

async function api(p, opts) {
  const r = await fetch(absUrl(p), Object.assign({ cache: 'no-store' }, opts || {}));
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const ct = r.headers.get('content-type') || '';
  return ct.includes('application/json') ? r.json() : r.text();
}
/* 离线时写操作不报错：排队存到本机，服务器恢复后由 offline.js 自动合并回在线版 */
function post(p, body) {
  if (OFF && !OFF.online) {
    OFF.queueChange(p, body || {});
    return Promise.resolve({ ok: true, offlineQueued: true, queued: OFF.pendingCount() });
  }
  return api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    .catch(e => {
      if (!OFF) throw e;
      OFF.markOffline();
      OFF.queueChange(p, body || {});
      return { ok: true, offlineQueued: true, queued: OFF.pendingCount(), error: e.message };
    });
}
function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast-item'; el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = '.3s'; setTimeout(() => el.remove(), 320); }, 2800);
}

async function load(force = false) {
  const btn = $('#btnRefresh'); if (btn) btn.classList.add('spin');
  try {
    // 离线版（file:// 双击打开）：绝不联网「提取在线版」，直接用本机固化快照渲染
    if (OFF && !OFF.online) await loadFromSnapshot();
    else await loadFromServer(force);
  } finally { if (btn) btn.classList.remove('spin'); }
  checkFriendNotifications();
  renderAll();
  syncEstimateUi();
  renderOffline();
  loadFriendDiagnosis();     // 异步，不阻塞首屏渲染
}

/* 在线：照常拉服务端全量数据，并固化到浏览器本机，服务关掉后离线版仍能看到 */
async function loadFromServer(force) {
  try {
    S = await api(`/api/state?mode=${MODE}${force ? '&force=1' : ''}`);
  } catch (e) {
    // 单点状态拉取失败不能让整个界面卡死：退回到本机快照 / 演示数据继续渲染
    const snap = OFF?.snapshot()?.state;
    S = snap || demoState();
    if (!snap) DEMO = true;
    console.warn('[SteamLens] /api/state 拉取失败，已退回本机快照：', e?.message || e);
  }
  DEMO = false;
  try { SERVER_ROOT = (await api('/api/health')).root || SERVER_ROOT; } catch {}
  const snap = OFF?.snapshot();
  const [a, n, w, ar, m, si, wx, bs, qq, hid, dt, fp, fl, sm, wp] = await Promise.all([
    api('/api/account').catch(() => null),
    api('/api/notify/status').catch(() => null),
    api('/api/wishlist').catch(() => null),
    api('/api/autorefresh').catch(() => null),
    api('/api/mail/status').catch(() => null),
    api('/api/steam/info').catch(() => null),
    api('/api/wechat/status').catch(() => null),
    api('/api/browser/status').catch(() => null),
    api('/api/qq/status').catch(() => null),
    api('/api/hidden/status').catch(() => null),
    api('/api/dingtalk/status').catch(() => null),
    api('/api/friend-profiles').catch(() => null),
    api('/api/friend-library/list').catch(() => null),
    api('/api/sms/status').catch(() => null),
    api('/api/wallpaper/status').catch(() => null)
  ]);
  A = a || snap?.account || null;
  N = n || snap?.notify || null;
  W = w || snap?.wishlist || null;
  AR = ar || snap?.autorefresh || null;
  MAIL = m || snap?.mail || null;
  SI = si || snap?.steamInfo || null;
  WECHAT = wx || snap?.wechat || null;
  B = bs || snap?.browser || null;
  QQ = qq || snap?.qq || null;
  H = hid || snap?.hidden || null;
  DT = dt || snap?.dingtalk || null;
  FP = fp || snap?.friendProfiles || null;
  FL = fl || snap?.friendLibraries || null;
  SMS = sm || snap?.sms || null;
  WP = wp || snap?.wallpaper || null;
  /* 好友单独异步拉一次：故意不进上面的 Promise.all。
     Steam 客户端冷启动时 /api/friends 可能要几十秒，塞进 Promise.all 会
     把整个首屏拖死；这里回来后立刻补渲染，好友卡片（含「朋友的朋友」入口）
     就能在首屏出现，不用干等 15 秒的轮询。 */
  if (!DEMO) {
    api('/api/friends').then(f => {
      if (!f || !Array.isArray(f.friends)) return;
      /* 缓存里先显示的是上次关闭时的记录；Steam 数据回来后覆盖显示并回写缓存。
         若这次一个好友都没读到，就保留缓存记录，绝不把界面清空。 */
      if (!f.friends.length && F?._fromCache) return;
      F = f;
      friendCacheSave(true);
      checkFriendNotifications();
      renderFriends();
      renderHeader();
    }).catch(() => {});
  }
  if (OFF) {
    OFF.markOnline();
    OFF.saveSnapshot({
      state: S, friends: F, account: A, notify: N, wishlist: W, autorefresh: AR,
      mail: MAIL, steamInfo: SI, wechat: WECHAT, browser: B, qq: QQ, hidden: H,
      dingtalk: DT, friendProfiles: FP, friendLibraries: FL
    });
  }
}

/* 离线版：全部来自本机快照，不发起任何在线请求 */
async function loadFromSnapshot() {
  const snap = OFF?.snapshot() || {};
  DEMO = !snap.state;
  OFF?.markOffline();
  S = snap.state || demoState();
  /* 离线打开同样先显示上次保存的好友记录，再依次用服务端缓存 / 快照兜底 */
  F = friendCacheRead() || snap.friendListCache?.data || snap.friends || demoFriends();
  A = snap.account || null; N = snap.notify || null; W = snap.wishlist || null;
  AR = snap.autorefresh || null; MAIL = snap.mail || null; SI = snap.steamInfo || null;
  WECHAT = snap.wechat || null; B = snap.browser || null; QQ = snap.qq || null;
  H = snap.hidden || null; DT = snap.dingtalk || null; FP = snap.friendProfiles || null;
  FL = snap.friendLibraries || null;   SMS = snap.sms || null;
  WP = snap.wallpaper || null;
  if (WP) {
    /* 离线版自己调过的壁纸设置优先于快照，刷新后仍然生效 */
    WP._offlineAllItems = Array.isArray(WP.items) ? WP.items.slice() : [];
    const lc = wpLocalConfig();
    if (lc) WP.config = Object.assign({}, WP.config || {}, lc);
    const hidden = new Set((WP.config && WP.config.hiddenIds) || []);
    if (hidden.size) WP.items = WP._offlineAllItems.filter(x => !hidden.has(String(x.id) + ':' + (x.src || 'local')));
  }
}

/* ------------------------------ 通用渲染件 ------------------------------ */
function kpi(label, value, unit, sub, color, ico) {
  return `<div class="kpi glass" style="--kc:${color}">
    <div class="k-label"><i>${ico}</i>${esc(label)}</div>
    <div class="k-value num">${value}${unit ? `<small>${unit}</small>` : ''}</div>
    <div class="k-sub">${esc(sub)}</div>
  </div>`;
}
/** 封面加载失败时依次回退：Steam CDN ↔ 本机 librarycache，最后保留占位框，绝不显示破图 */
function slCoverFallback(img) {
  const stage = Number(img.getAttribute('data-stage') || 0);
  /* 新版：按 data-fallbacks 里的地址逐个尝试（用 | 分隔） */
  const list = String(img.getAttribute('data-fallbacks') || '').split('|').filter(Boolean);
  if (stage < list.length) {
    const next = list[stage];
    img.setAttribute('data-stage', String(stage + 1));
    if (next && img.getAttribute('src') !== next) { img.src = next; return; }
    img.style.visibility = 'hidden';
    return;
  }
  /* 兼容旧的 data-local 单级回退 */
  if (!stage) {
    const local = img.getAttribute('data-local') || '';
    if (local && img.getAttribute('src') !== local) {
      img.setAttribute('data-stage', '1');
      img.src = local;
      return;
    }
  }
  img.style.visibility = 'hidden';
}
const steamCdn = appid => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`;
function coverHTML(g, size) {
  const id = String(g.appid || '');
  const off = DEMO || (OFF && !OFF.online);
  const cdn = steamCdn(id);
  const img = off
    ? `<img src="${esc(g.cover || cdn)}" loading="lazy" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" onerror="this.remove()">`
    : `<img src="${esc(g.cover || `/api/cover/${id}`)}" data-local="${esc(cdn)}" loading="lazy" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" onerror="slCoverFallback(this)">`;
  return `<div class="g-cover" style="position:relative;${size ? `width:${size}px;height:${size * 1.3}px` : ''}"><span style="font-size:11px;color:var(--ink3)">▦</span>${img}</div>`;
}
/** 浏览器扫描卡片里的横向小封面：CDN 优先，失败退回本机 Steam 封面文件 */
function blThumb(x) {
  const id = String(x.appid || '');
  const off = DEMO || (OFF && !OFF.online);
  const cdn = String(x.cover || steamCdn(id));
  /* 在线：商店精确封面 → 本机 Steam 封面文件 → 通用 Steam CDN 封面，逐级回退，
     这样愿望单 / 购物车里没下载的游戏也不会只剩一个空框 */
  const backups = [`/api/game/cover?appid=${id}`, steamCdn(id)]
    .filter(u => u !== cdn).join('|');
  const img = off
    ? `<img src="${esc(cdn)}" loading="lazy" onerror="this.remove()">`
    : `<img src="${esc(cdn)}" data-fallbacks="${esc(backups)}" loading="lazy" onerror="slCoverFallback(this)">`;
  return `<div class="bl-cover"><span>▦</span>${img}</div>`;
}
function dispNameRaw(g) {
  return (MASK && g.effectivePrivate) ? `隐私游戏 #${String(g.appid).slice(-4)}` : (g.name || '');
}
function dispName(g) { return esc(dispNameRaw(g)); }
function barsHTML(items, fmt) {
  if (!items.length) return '<div class="empty">暂无数据</div>';
  const max = Math.max(...items.map(x => x.value), 0.0001);
  return `<div class="bars">${items.map((x, i) => `<div class="bar-row">
    <div class="b-name" title="${esc(x.name)}${x.badge ? ' · ' + esc(x.badge) : ''}"><span class="b-txt">${esc(x.name)}</span>${x.badge ? `<span class="bar-src ${esc(x.badgeCls || '')}" title="${esc(x.badgeTitle || x.badge)}">${esc(x.badge)}</span>` : ''}</div>
    <div class="b-track"><div class="b-fill" style="width:${Math.max(2, x.value / max * 100)}%;background:linear-gradient(90deg,${PALETTE[i % PALETTE.length]},${PALETTE[(i + 2) % PALETTE.length]})"></div></div>
    <div class="b-val num">${fmt(x.value)}</div></div>`).join('')}</div>`;
}

/* 库价值统一口径：只认「Steam 客户端 + 网页端」合并后的真实游戏库。
   优先用后端生成的逐款清单（含网页端买了但本机没装的游戏）；老快照 / 离线演示数据
   没有该字段时退回按 appids 过滤本机记录；连 appids 都没有才用全量，避免空白页。 */
function valueLib() {
  const vs = S?.valueSources || {};
  const ids = new Set((vs.appids || []).map(String));
  const all = Array.isArray(S?.games) ? S.games : [];
  if (Array.isArray(vs.games) && vs.games.length) {
    return { games: vs.games.slice(), ids, strict: true,
      dropped: Math.max(0, all.length - vs.games.length),
      web: new Set((vs.webAppids || []).map(String)),
      client: new Set((vs.clientAppids || []).map(String)) };
  }
  if (ids.size) {
    return { games: all.filter(g => ids.has(String(g.appid))), ids, strict: true,
      dropped: all.filter(g => !ids.has(String(g.appid))).length,
      web: new Set((vs.webAppids || []).map(String)),
      client: new Set((vs.clientAppids || []).map(String)) };
  }
  return { games: all.slice(), ids, strict: false, dropped: 0, web: new Set(), client: new Set() };
}
function valueSrcLabel(g, lib) {
  if (g.sourceLabel) return g.sourceLabel;
  const id = String(g.appid || ''), a = lib.web.has(id), b = lib.client.has(id);
  return a && b ? '双端' : (a ? '网页端' : (b ? '客户端' : '真实库'));
}

/* ------------------------------ 各页面 ------------------------------ */
function renderHeader() {
  const a = S.connection.account;
  $('#avatar').innerHTML = a?.avatar ? `<img src="${esc(a.avatar)}" onerror="this.remove()">` : esc((a?.personaName || 'S').slice(0, 1).toUpperCase());
  $('#accountName').textContent = a?.personaName || a?.accountName || '未识别账号';
  $('#accountId').textContent = a?.steamId64 ? 'ID ' + a.steamId64 : '本机 Steam 账号';
  $('#navGames').textContent = S.totals.games;
  $('#navFriends').textContent = F?.totals?.online ?? 0;
  $('#navPrivate').textContent = S.totals.privateGames;
  if ($('#navAccount')) $('#navAccount').textContent = A?.connected ? '已连接' : '未连接';
  if ($('#navMail')) $('#navMail').textContent = MAIL?.connected ? '已登录' : '—';
  $$('#modeSwitch button').forEach(b => b.classList.toggle('active', b.dataset.mode === MODE));
  const badge = $('#statusBadge');
  if (DEMO) { badge.innerHTML = '<span class="dot warn"></span><span>离线演示数据</span>'; }
  else if (S.connection.warnings?.length) { badge.innerHTML = '<span class="dot warn"></span><span>本地就绪 · 有提示</span>'; }
  else { badge.innerHTML = `<span class="dot"></span><span>${MODE === 'auto' ? '本机已连接' : '手动连接就绪'}</span>`; }
  $('#cfgModeTag').textContent = MODE.toUpperCase();
}

/* 游戏总数 = 浏览器扫描实际提取到的「已拥有」游戏款数（按 AppID 去重）。
   浏览器提出多少就是多少：不再与本机游戏库做并集，也不额外补未下载的游戏。
   只有完全没拿到浏览器清单时，才回退到本机游戏库数量。
   注：/api/browser/status 为了性能只回传最近 300 条明细，totals.owned 是完整款数，
       因此以两者较大值作为「浏览器提取到的款数」。 */
function slLibraryCounts() {
  const t = S?.totals || {};
  const local = Array.isArray(S?.games) ? S.games : [];
  const localIds = new Set(local.map(g => String(g.appid)).filter(Boolean));
  const installedIds = new Set(local.filter(g => g.installed).map(g => String(g.appid)).filter(Boolean));
  const bl = Array.isArray(B?.owned) ? B.owned : [];
  const browserIds = new Set(bl.map(x => String(x && x.appid)).filter(Boolean));
  const reported = Math.max(0, Number(B?.totals?.owned) || 0);
  const browserTotal = Math.max(browserIds.size, reported);
  const hasBrowser = browserTotal > 0;
  const total = hasBrowser ? browserTotal : (Number(t.games) || localIds.size);
  // 已下载数只是附带说明：本机已安装且同时出现在浏览器清单里的款数，不参与总数计算
  const downloaded = hasBrowser
    ? [...installedIds].filter(id => browserIds.has(id)).length
    : (Number(t.installed) || installedIds.size);
  return {
    total, downloaded, notDownloaded: Math.max(0, total - downloaded),
    browser: browserTotal, local: localIds.size,
    listed: browserIds.size, hasBrowser
  };
}

function overviewKpiHTML() {
  const t = S?.totals || {};
  const lib = slLibraryCounts();
  return kpi('累计使用时长', (t.totalHours || 0).toLocaleString('zh-CN'), '小时', `${(t.totalMinutes || 0).toLocaleString('zh-CN')} 分钟 · ${t.playedGames || 0} 款有记录`, 'rgba(47,109,246,.16)', '◷') +
    kpi('游戏总数', lib.total, '款', lib.hasBrowser
      ? `浏览器扫描提取 ${lib.total} 款已拥有游戏 · 提取多少就是多少（不叠加本机未下载游戏）`
      : `已安装 ${t.installed || 0} · 占用 ${t.totalSizeGB || 0} GB（等待浏览器扫描）`, 'rgba(122,99,245,.16)', '▤') +
    kpi('库价值估算', shortMoney(t.totalValueCents || 0), '', `已估价 ${t.valuedGames || 0} 款 · 免费 ${t.freeGames || 0} 款`, 'rgba(16,179,156,.16)', '¥') +
    kpi('近 14 天', (t.last14Hours || 0).toLocaleString('zh-CN'), '小时', `平均每小时成本 ${t.avgCostPerHour === null || t.avgCostPerHour === undefined ? '—' : '¥' + t.avgCostPerHour}`, 'rgba(226,148,55,.16)', '↗');
}

function renderOverview() {
  const t = S.totals;
  $('#kpiGrid').innerHTML = overviewKpiHTML();

  // ★ 时长构成 / 排行只显示「Steam 客户端 + 网页端真实游戏库」里确实存在的游戏：
  //   本机历史记录里已经不在库里的（已删 / 退款 / Demo / 仅在愿望单）一律剔除。
  const realIds = new Set((S.valueSources?.appids || []).map(String));
  const allPlayed = S.games.filter(g => g.playtimeMin > 0);
  const played = (realIds.size ? allPlayed.filter(g => realIds.has(String(g.appid))) : allPlayed)
    .sort((a, b) => b.playtimeMin - a.playtimeMin);
  const droppedCount = allPlayed.length - played.length;
  const top = played.slice(0, 5).map(g => ({ name: dispName(g), value: g.playtimeMin }));
  const rest = played.slice(5).reduce((a, g) => a + g.playtimeMin, 0);
  if (rest > 0) top.push({ name: '其他 ' + (played.length - 5) + ' 款', value: rest });
  const total = top.reduce((a, x) => a + x.value, 0) || 1;
  const R = 62, C = 2 * Math.PI * R;
  let acc = 0;
  const arcs = top.map((x, i) => {
    const len = x.value / total * C;
    const s = `<circle cx="85" cy="85" r="${R}" fill="none" stroke="${PALETTE[i % PALETTE.length]}" stroke-width="18" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}" transform="rotate(-90 85 85)"/>`;
    acc += len; return s;
  }).join('');
  $('#donut').innerHTML = `<svg viewBox="0 0 170 170" width="170" height="170" role="img">
    <circle cx="85" cy="85" r="${R}" fill="none" stroke="${gridColor()}" stroke-width="18"/>
    ${arcs}
    <text x="85" y="80" text-anchor="middle" fill="${inkColor()}" font-size="22" font-weight="700" style="letter-spacing:-1px">${t.totalHours}</text>
    <text x="85" y="99" text-anchor="middle" fill="${subColor()}" font-size="10">累计小时</text></svg>`;
  $('#donutLegend').innerHTML = top.map((x, i) => `<div class="legend-row">
    <span class="swatch" style="background:${PALETTE[i % PALETTE.length]}"></span>
    <span class="lg-name">${esc(x.name)}</span>
    <span class="lg-val num">${h(x.value)}h · ${Math.round(x.value / total * 100)}%</span></div>`).join('') || '<div class="empty">暂无游玩记录</div>';
  $('#donutTag').textContent = `TOP ${Math.min(5, played.length)}${realIds.size ? ' · 真实库' : ''}`;

  $('#topBars').innerHTML = barsHTML(played.slice(0, 8).map(g => ({ name: dispNameRaw(g), value: g.playtimeHours })), v => v + ' h');

  const recent = (realIds.size ? S.games.filter(g => realIds.has(String(g.appid))) : [...S.games])
    .filter(g => g.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, 6);
  $('#recentList').innerHTML = recent.map(g => `<div class="recent-item">
    <div class="r-ico">▸</div><div class="r-main"><b>${dispName(g)}</b><small>${dateStr(g.lastPlayed)} · ${g.playtimeHours} 小时累计</small></div>
    <div class="r-val">${g.playtime2wksHours > 0 ? '+' + g.playtime2wksHours + 'h' : '—'}</div></div>`).join('') || '<div class="empty">暂无最近游玩记录</div>';
  $('#deltaTag').textContent = S.deltas?.hasBaseline ? `较上次 +${h(S.deltas.minutes)}h` : '等待第二次快照';

  const c = S.connection;
  const sources = [
    ['本机时长记录', `${c.localRecordCount} 条 · userdata/*/config/localconfig.vdf（含私密/隐藏游戏）`],
    ['时长构成口径', `Steam 客户端 + 网页端真实游戏库 ${realIds.size} 款 · 已剔除 ${droppedCount} 款不在库里的历史记录`],
    ['已安装清单', `${t.installed} 款 · steamapps/appmanifest_*.acf`],
    ['账号识别', c.account?.steamId64 ? `loginusers.vdf · ${c.account.steamId64}` : '未读取到 loginusers.vdf'],
    ['Web API', c.usedApi ? `GetOwnedGames · ${c.apiGameCount} 款` : (c.usedPastedJson ? '手动粘贴的 JSON' : '未使用（自动模式无需联网）')],
    ['库价值', 'Steam 商店当前标价 · 结果缓存在本机 data/prices.json'],
    ...c.warnings.map(w => ['提示', w])
  ];
  $('#sourceList').innerHTML = sources.map(([a, b]) => `<div class="source-item"><span class="s-ico">✓</span><div><b>${esc(a)}</b><small>${esc(b)}</small></div></div>`).join('');
  renderPlaytimeAll();
}

/* 「更多」→ 我所有游戏各自的游玩时长（整页滚动，不套小滚动框） */
function renderPlaytimeAll() {
  const box = $('#playtimeAllList'); if (!box) return;
  const q = String($('#playtimeSearch')?.value || '').trim().toLowerCase();
  const onlyPlayed = $('#playtimeOnlyPlayed')?.checked !== false;
  // 与「时长构成 / 排行」同一口径：只列 Steam 客户端 + 网页端真实库里存在的游戏
  const realIds = new Set((S.valueSources?.appids || []).map(String));
  const all = realIds.size
    ? (S.games || []).filter(g => realIds.has(String(g.appid)))
    : [...(S.games || [])];
  let games = onlyPlayed ? all.filter(g => Number(g.playtimeMin) > 0) : all.slice();
  if (q) games = games.filter(g => String(g.name || '').toLowerCase().includes(q) || String(g.appid || '').includes(q));
  games.sort((a, b) => (Number(b.playtimeMin) || 0) - (Number(a.playtimeMin) || 0));
  const totalMin = all.reduce((s, g) => s + (Number(g.playtimeMin) || 0), 0);
  if ($('#playtimeAllHint')) $('#playtimeAllHint').textContent =
    `显示 ${games.length} 款 / 真实库 ${all.length} 款 · 累计 ${h(totalMin)} 小时 · 按累计时长从高到低 · 已剔除不在 Steam 客户端 / 网页端库里的历史记录`;
  box.innerHTML = games.length ? games.map(g => `<div class="mini-item">
      <div class="mi-main"><b>${esc(dispName(g))}</b><small>AppID ${esc(g.appid || '')}${g.lastPlayed ? ' · 最近 ' + esc(dateStr(g.lastPlayed)) : ''}${Number(g.playtime2wksHours) > 0 ? ' · 近两周 +' + g.playtime2wksHours + ' h' : ''}</small></div>
      <span class="mi-val num">${(Number(g.playtimeHours) || 0)} h</span></div>`).join('')
    : '<div class="mini-empty">没有符合条件的游戏。可关掉「只看玩过的」或清空搜索。</div>';
  const ov = AR?.jobs?.overview, pt = AR?.jobs?.playtime;
  const sec = AR?.config?.overviewRefreshSec || 60, hrs = AR?.config?.playtimeRefreshHours || 1;
  if ($('#playtimeSyncNote')) $('#playtimeSyncNote').textContent =
    `Steam 客户端 + 网页端真实库 ${realIds.size} 款参与时长构成/排行 · 总览每 ${sec} 秒自动刷新 · 时长每 ${hrs} 小时全量重提取一次`
    + (ov?.lastAt ? ` · 上次提取 ${timeStr(new Date(ov.lastAt).toISOString())}（${esc(ov.result || '')}）` : '')
    + (pt?.lastAt ? ` · 上次全量 ${timeStr(new Date(pt.lastAt).toISOString())}` : '');
}
$('#btnPlaytimeMore')?.addEventListener('click', () => {
  const box = $('#playtimeAll'), b = $('#btnPlaytimeMore');
  if (!box) return;
  box.hidden = !box.hidden;
  if (b) b.textContent = box.hidden ? '更多 › 全部游戏时长' : '收起 ‹ 全部游戏时长';
  if (!box.hidden) renderPlaytimeAll();
});
$('#playtimeSearch')?.addEventListener('input', renderPlaytimeAll);
$('#playtimeOnlyPlayed')?.addEventListener('change', renderPlaytimeAll);

function renderGames() {
  let list = [...S.games];
  if (FILTER === 'played') list = list.filter(g => g.playtimeMin > 0);
  if (FILTER === 'installed') list = list.filter(g => g.installed);
  if (FILTER === 'private') list = list.filter(g => g.effectivePrivate);
  if (SEARCH) { const q = SEARCH.toLowerCase(); list = list.filter(g => g.name.toLowerCase().includes(q) || g.appid.includes(q)); }
  list.sort((a, b) => SORT === 'recent' ? b.lastPlayed - a.lastPlayed
    : SORT === 'value' ? (b.priceCents || 0) - (a.priceCents || 0)
    : SORT === 'name' ? a.name.localeCompare(b.name) : b.playtimeMin - a.playtimeMin);

  $('#gamesBody').innerHTML = list.map(g => `<tr data-appid="${g.appid}" data-name="${esc(g.name || '')}">
    <td><div class="g-cell">${coverHTML(g)}<div class="g-name"><b>${dispName(g)}${g.effectivePrivate ? '<span class="mini-tag">隐私</span>' : ''}</b><small>AppID ${g.appid}${g.library ? ' · ' + esc(g.library.split(/[\\/]/).filter(Boolean).slice(-1)[0]) : ''}</small></div></div></td>
    <td class="num"><b>${g.playtimeHours}</b> <small style="color:var(--ink3)">h</small></td>
    <td class="num">${g.playtime2wksHours ? `<b style="color:var(--up)">+${g.playtime2wksHours}</b> h` : '<span style="color:var(--ink3)">—</span>'}</td>
    <td>${dateStr(g.lastPlayed)}</td>
    <td>${g.installed ? `<span style="color:var(--teal)">● 已安装 ${g.sizeGB} GB</span>` : '<span style="color:var(--ink3)">○ 未安装</span>'}</td>
    <td class="num">${g.priceCents > 0 ? money(g.priceCents) : (g.isFree ? '免费' : '<span style="color:var(--ink3)">未估价</span>')}</td>
    <td><span class="src-pill" title="${esc(g.sources?.playtime || '')}">${esc((g.sources?.playtime || '未知').split(' (')[0])}</span></td>
    <td><button class="link-btn" data-edit="${g.appid}">编辑</button></td></tr>`).join('') || '<tr><td colspan="8"><div class="empty">没有匹配的游戏</div></td></tr>';
  $('#gamesCount').textContent = `显示 ${list.length} / ${S.games.length} 款`;
}

function renderPrivate() {
  const t = S.totals;
  const priv = S.games.filter(g => g.effectivePrivate);
  const autoCount = priv.filter(g => g.autoHidden).length;
  $('#privateKpi').innerHTML =
    kpi('隐私 / 隐藏游戏', t.privateGames, '款', `Steam 隐藏 ${t.hiddenGames} 款 · 自动识别 ${autoCount} 款`, 'rgba(224,92,110,.16)', '◐') +
    kpi('它们的使用时长', h(t.privateMinutes), '小时', '已完整计入总时长与库价值', 'rgba(122,99,245,.16)', '◷') +
    kpi('占总时长比例', t.totalMinutes ? Math.round(t.privateMinutes / t.totalMinutes * 100) : 0, '%', '名称可脱敏，统计不受影响', 'rgba(16,179,156,.16)', '◈');
  $('#maskToggle').checked = MASK;
  $('#privateList').innerHTML = priv.map(g => {
    const auto = !!g.autoHidden;
    const detail = MASK ? `AppID ${g.appid} · 名称已脱敏` : `AppID ${g.appid} · ${esc(g.name)}`;
    const src = auto
      ? `Steam 隐藏 · 自动识别${g.hiddenSources?.length ? ' · ' + esc(String(g.hiddenSources[0]).split('（')[0]) : ''}`
      : '手动标记为隐私';
    return `<div class="private-item">
      <div class="p-ico">◐</div>
      <div class="p-main"><b>${dispName(g)}${auto ? '<span class="auto-pill">自动</span>' : ''}</b><small>${detail} · ${src}</small></div>
      <div class="p-val num">${g.playtimeHours} h</div>
      <button class="link-btn" data-edit="${g.appid}">编辑</button>
      ${auto ? `<button class="link-btn" data-hidden-remove="${g.appid}">移除自动识别</button>` : ''}
    </div>`;
  }).join('') || '<div class="empty">当前没有隐私或隐藏游戏。开启上方「每分钟自动同步」，Steam 里隐藏的游戏会自动出现在这里；也可在「游戏库」里手动标记。</div>';
}

/* ---------------- Steam 隐藏游戏自动识别面板 ---------------- */
function renderHidden() {
  if (!$('#hiddenSyncCard')) return;
  const s = H || {};
  const enabled = s.enabled !== false;
  const secs = s.nextAt ? Math.max(0, Math.round((s.nextAt - Date.now()) / 1000)) : (s.intervalSec || 60);
  if ($('#hiddenAutoToggle')) $('#hiddenAutoToggle').checked = enabled;
  if ($('#hiddenSyncTag')) $('#hiddenSyncTag').textContent = enabled ? `每 ${s.intervalSec || 60} 秒自动同步` : '自动同步已关闭';
  if ($('#hiddenCountdown')) $('#hiddenCountdown').textContent = enabled
    ? `${secs} 秒后自动重新识别`
    : '已暂停自动同步（已识别的仍保留）';
  if ($('#hiddenSyncBar')) {
    $('#hiddenSyncBar').innerHTML =
      `<span class="rb-dot ${enabled ? 'busy' : ''}"></span>
       <span class="rb-title">已识别 ${s.count || 0} 款 Steam 隐藏游戏</span>
       <span class="rb-meta">${s.lastScanAt ? '上次扫描 ' + timeStr(new Date(s.lastScanAt).toISOString()) + ' · ' : ''}累计 ${s.scanCount || 0} 轮${s.stale ? ' · Steam 客户端未运行，暂时保留上次结果' : ''}${s.manualRemovedCount ? ' · 手动移除 ' + s.manualRemovedCount + ' 款' : ''}</span>`;
  }
  const src = s.sources || {};
  if ($('#hiddenSources')) {
    const rows = Object.entries(src).map(([k, v]) =>
      `<div class="source-item"><span class="hidden-src-chip"><b>${esc(v)}</b> 款</span><span>${esc(k)}</span></div>`).join('');
    $('#hiddenSources').innerHTML = rows || '<div class="mini-empty">还没扫到隐藏游戏。确认 Steam 客户端已登录过、或在「浏览器扫描」里运行一次采集脚本。</div>';
  }
}

$('#hiddenAutoToggle')?.addEventListener('change', async e => {
  try {
    const r = await post('/api/hidden/config', { enabled: e.target.checked, intervalSec: 60 });
    H = r.status; renderHidden();
    toast(e.target.checked ? '已开启：每分钟自动识别 Steam 隐藏游戏（永久保存）' : '已暂停自动同步');
  } catch (err) { toast('保存失败：' + err.message); e.target.checked = !e.target.checked; }
});
$('#btnHiddenScan')?.addEventListener('click', async () => {
  if (DEMO) return;
  const btn = $('#btnHiddenScan'); btn.disabled = true; btn.textContent = '正在扫描…';
  try {
    const r = await post('/api/hidden/scan');
    H = r.status; await load(true); renderHidden();
    toast(`扫描完成：识别 ${r.total} 款隐藏游戏（新增 ${r.added.length} / 移除 ${r.removed.length}）`);
  } catch (err) { toast('扫描失败：' + err.message); }
  finally { btn.disabled = false; btn.textContent = '↻ 立即扫描 Steam'; }
});
$('#btnHiddenRestore')?.addEventListener('click', async () => {
  if (DEMO) return;
  try {
    const r = await post('/api/hidden/restore');
    H = r.status; await load(true); renderHidden(); toast('已清除手动移除记录，重新全量识别');
  } catch (err) { toast('恢复失败：' + err.message); }
});
$('#privateList')?.addEventListener('click', async e => {
  const b = e.target.closest('[data-hidden-remove]'); if (!b) return;
  try {
    const r = await post('/api/hidden/remove', { appid: b.dataset.hiddenRemove });
    H = r.status; await load(true); renderHidden(); toast('已移除该项，后续自动同步不会再把它加回来');
  } catch (err) { toast('移除失败：' + err.message); }
});

function renderValue() {
  const t = S.totals;
  const vs = S.valueSources || {};
  const lib = valueLib();
  const realCount = lib.ids.size || lib.games.length;
  const realHours = Number(vs.realHours) > 0
    ? Number(vs.realHours)
    : Math.round(lib.games.reduce((n, g) => n + (Number(g.playtimeHours) || 0), 0) * 10) / 10;
  /* 以前用「全部 174 款 / 690 小时」算平均每小时成本，混进了不在库里的历史游戏。
     现在统一按真实库时长，和「最值钱的游戏 / 每小时成本」用同一口径。 */
  const avgReal = (realHours > 0 && Number(t.totalValueCents) > 0)
    ? Math.round(Number(t.totalValueCents) / 100 / realHours * 100) / 100 : null;
  $('#valueKpi').innerHTML =
    kpi('整体库价值', shortMoney(t.totalValueCents), '', `真实库 ${realCount} 款 · 已估价 ${t.valuedGames} 款`, 'rgba(47,109,246,.16)', '¥') +
    kpi('平均每小时成本', avgReal === null ? '—' : '¥' + avgReal, '', `真实库 ${realHours} h · 价值 ÷ 库内游玩小时`, 'rgba(226,148,55,.16)', '÷') +
    kpi('免费 / 不可估价', t.freeGames, '款', '已下架或区域受限可手动填价', 'rgba(16,179,156,.16)', '◌');
  $('#priceBasis').innerHTML = `<b>口径：</b>${esc(S.privacy.priceBasis)} <b>当前：</b>${esc(t.valueScope || '按本机记录统计')}`;
  $('#priceTag').textContent = `${t.valuedGames} 款已估价 · 排除 ${t.excludedFromValue || 0} 款`;
  const vl = t.valueLedger;
  if ($('#valueLedgerHint')) {
    if (!vl) $('#valueLedgerHint').textContent = '价值账本：等待首次估价…';
    else {
      const money2 = c => '¥' + (Number(c || 0) / 100).toFixed(2);
      const d = Number(vl.deltaCents || 0);
      const parts = [];
      if ((vl.added || []).length) parts.push(`新增 ${vl.added.length} 款 +${money2(vl.addedCents)}`);
      if ((vl.removed || []).length) parts.push(`移除 ${vl.removed.length} 款 −${money2(vl.removedCents)}`);
      $('#valueLedgerHint').innerHTML = `<b>💾 价值永久保存：</b>已把 <b>${vl.savedPrices}</b> 款游戏的标价永久记在本机（首次 ${esc(vl.firstIso || '—')}）。`
        + (parts.length ? `这次${parts.join('、')}，净变化 ${d >= 0 ? '+' : '−'}${money2(Math.abs(d))}。` : '这次清单没有增减。')
        + (vl.frozen ? ' <b style="color:var(--amber)">本次读取异常，已保留上次确认的价值，不会清零。</b>' : ' 账号同步失败、价格缓存丢失都不会把价值打回 0。');
    }
  }

  const job = AR?.jobs?.value, est = AR?.estimate;
  $('#valueRefreshBar').innerHTML =
    `<span class="rb-dot ${est?.running ? 'busy' : ''}"></span>
     <span class="rb-title">${est?.running ? `正在自动补齐 ${est.done}/${est.total} 款价格…` : '库价值 · 每天自动重算一次'}</span>
     <span class="rb-meta">${job?.result ? esc(job.result) + ' · ' : ''}每 ${AR?.config?.valueRefreshHours || 24} 小时（一天）自动重算一次${job?.lastAt ? ' · 上次 ' + timeStr(new Date(job.lastAt).toISOString()) : ''}${job?.nextAt ? ' · 下次 ' + timeStr(new Date(job.nextAt).toISOString()) : ''}；价格失败只短暂缓存，会自动重试</span>
     <button class="btn ghost tiny" data-act="refresh-value">↻ 立即刷新价值</button>`;

  const ex = S.excluded || [];
  $('#excludedTag').textContent = `${ex.length} 款 / ¥${t.excludedValueYuan || 0}`;
  $('#excludedList').innerHTML = ex.length ? ex.slice(0, 50).map(x => `<div class="mini-item">
      <div class="mi-main"><b>${esc(x.name)}</b><small>${esc(x.excludeReason || x.ownershipLabel || '')} · ${x.playtimeHours} h</small></div>
      <span class="cat-chip cat-${esc(x.ownership)}">${esc(x.ownershipLabel || x.ownership)}</span>
      <span class="mi-val">${x.priceCents ? money(x.priceCents) : '—'}</span></div>`).join('')
    : '<div class="mini-empty">暂无排除项。连接 Steam 账号后，已退款和愿望单会自动出现在这里。</div>';

  const wl = S.wishlist || [];
  $('#wishlistTag').textContent = `${wl.length} 款`;
  $('#wishlistList').innerHTML = wl.length ? wl.slice(0, 50).map(x => `<div class="mini-item">
      <div class="mi-main"><b>${esc(x.name)}</b><small>AppID ${esc(x.appid)} · 未购买，不计入库价值</small></div>
      ${wishSpecHTML(x.appid, x.name)}
      <span class="cat-chip cat-wishlist">愿望单</span>
      <span class="mi-val">${x.priceCents ? money(x.priceCents) : (x.isFree ? '免费' : '—')}</span></div>`).join('')
    : '<div class="mini-empty">还没读到愿望单。可在「Steam 账号」页连接账号或粘贴 wishlistdata JSON。</div>';
  /* ★「最值钱的游戏 / 每小时成本」只按 Steam 客户端 + 网页端合并的真实库显示：
       真实库里没有的游戏删掉，有的就显示（含网页端买了但本机未安装的）。 */
  const scopeTag = lib.strict
    ? `真实库 ${lib.games.length} 款 · 剔除 ${lib.dropped} 款`
    : '暂按本机记录';
  const scopeNote = lib.strict
    ? `按 <b>Steam 客户端 + 网页端</b>合并的真实游戏库显示：网页端 ${vs.webOwned ?? 0} 款、客户端 ${vs.steamClientOwned ?? 0} 款，去重后 <b>${vs.merged || lib.games.length} 款</b>；不在库里的 ${lib.dropped} 款历史记录已删除。每行末尾标出数据来源。`
    : '还没拿到 Steam 客户端 / 网页端的真实库清单，暂时按本机记录显示；打开 Steam 商店页面或启动浏览器扫描后会自动收窄。';
  if ($('#valueRankTag')) $('#valueRankTag').textContent = scopeTag;
  if ($('#costRankTag')) $('#costRankTag').textContent = scopeTag;
  if ($('#valueRankNote')) $('#valueRankNote').innerHTML = scopeNote + ' 按标价从高到低。';
  if ($('#costRankNote')) $('#costRankNote').innerHTML = scopeNote + ' 每小时成本越低越回本。';
  const row = (g, value) => {
    const src = valueSrcLabel(g, lib);
    return {
      name: dispNameRaw(g), value,
      badge: src,
      badgeCls: src === '双端' ? 'both' : (src === '网页端' ? 'web' : (src === '客户端' ? 'client' : '')),
      badgeTitle: `数据来源：${src} · AppID ${g.appid || ''} · ${Number(g.playtimeHours) || 0} h 游玩`
    };
  };
  const byValue = lib.games.filter(g => Number(g.priceCents) > 0)
    .sort((a, b) => Number(b.priceCents) - Number(a.priceCents)).slice(0, 8)
    .map(g => row(g, Number(g.priceCents) / 100));
  $('#valueRank').innerHTML = byValue.length
    ? barsHTML(byValue, v => '¥' + Math.round(v))
    : '<div class="empty">真实库里还没有已估价的游戏，点上方「获取商店标价并估算」即可补齐。</div>';
  const byCost = lib.games.filter(g => Number(g.hourlyCost) > 0)
    .sort((a, b) => Number(a.hourlyCost) - Number(b.hourlyCost)).slice(0, 8)
    .map(g => row(g, Number(g.hourlyCost)));
  $('#costRank').innerHTML = byCost.length
    ? barsHTML(byCost, v => '¥' + v.toFixed(2) + '/h')
    : '<div class="empty">真实库里还没有「有标价且玩过」的游戏，暂时算不出每小时成本。</div>';
  renderValueAll();
  setTimeout(() => { try { applyWishlistSpecBadges(); } catch {} }, 120);
}

/* 库价值：逐款列出「每款游戏各值多少钱」 */
function renderValueAll() {
  const box = $('#valueAllList'); if (!box) return;
  const vs = S.valueSources || {}, vg = AR?.jobs?.valueGames;
  const lib = valueLib();
  if ($('#valueAllNote')) $('#valueAllNote').innerHTML =
    `逐款列出真实游戏库里每款游戏的标价与合计。<b>游戏清单每分钟更新一次</b>：网页端采集 ${vs.webOwned || 0} 款 + 本机 Steam 客户端 ${vs.steamClientOwned || 0} 款，去重后 <b>${vs.merged || lib.games.length} 款</b>参与计价`
    + (lib.strict ? `；不在库里的 <b>${lib.dropped} 款</b>历史记录已删除，不会显示在这里。` : '；暂时按本机记录显示。')
    + (vg?.lastAt ? ` 上次合并 ${timeStr(new Date(vg.lastAt).toISOString())}。` : '')
    + `<b>价格每 ${AR?.config?.valueRefreshHours || 24} 小时（一天）自动重算一次</b>。退款 / 愿望单 / Demo 不计价。`;
  const q = String($('#valueAllSearch')?.value || '').trim().toLowerCase();
  const onlyPriced = $('#valueAllOnlyPriced')?.checked !== false;
  const all = lib.games.slice();
  let games = onlyPriced ? all.filter(g => Number(g.priceCents) > 0) : all.slice();
  if (q) games = games.filter(g => String(g.name || '').toLowerCase().includes(q) || String(g.appid || '').includes(q));
  games.sort((a, b) => (Number(b.priceCents) || 0) - (Number(a.priceCents) || 0));
  const sum = games.reduce((s, g) => s + (Number(g.priceCents) || 0), 0);
  if ($('#valueAllTag')) $('#valueAllTag').textContent = `${games.length} 款 / ${money(sum)}`;
  if ($('#valueAllHint')) $('#valueAllHint').textContent =
    `显示 ${games.length} 款 / 真实库 ${all.length} 款${lib.strict ? `（已剔除 ${lib.dropped} 款库外记录）` : ''} · 当前合计 ${money(sum)} · 按标价从高到低 · 每 ${AR?.config?.valueRefreshHours || 24} 小时自动重算一次`;
  box.innerHTML = games.length ? games.map(g => `<div class="mini-item">
      <div class="mi-main"><b>${esc(dispNameRaw(g))}</b><small>AppID ${esc(g.appid || '')} · ${(Number(g.playtimeHours) || 0)} h 游玩${g.hourlyCost ? ' · 每小时 ¥' + g.hourlyCost : ''} · 来源 ${esc(valueSrcLabel(g, lib))}</small></div>
      <span class="mi-val num">${Number(g.priceCents) > 0 ? money(g.priceCents) : (g.isFree ? '免费' : '未估价')}</span></div>`).join('')
    : '<div class="mini-empty">没有符合条件的游戏。可关掉「只看已估价的」或清空搜索。</div>';
}
$('#valueAllSearch')?.addEventListener('input', renderValueAll);
$('#valueAllOnlyPriced')?.addEventListener('change', renderValueAll);

/* ---------------- 愿望单：电脑配置够不够玩 ---------------- */
/* 复用「系统对比」的 /api/game/sysreq + 本机配置对比结果，异步批量给每行补一个徽标。
   结果按 AppID 缓存在内存里，页面重绘/每分钟刷新都不会重复联网。 */
const SPEC_BADGES = new Map();
const SPEC_INFLIGHT = new Set();
function wishSpecHTML(appid, name) {
  return `<span class="spec-badge unknown" data-spec-appid="${esc(String(appid || ''))}" data-spec-name="${esc(name || '')}" title="正在对照你的电脑配置检查">⌛ 检查配置…</span>`;
}
function paintSpecBadge(id, v) {
  document.querySelectorAll(`.spec-badge[data-spec-appid="${id}"]`).forEach(el => {
    el.className = 'spec-badge ' + v.cls;
    el.textContent = v.text;
    el.title = v.title || '';
  });
}
async function applyWishlistSpecBadges() {
  const nodes = [...document.querySelectorAll('.spec-badge[data-spec-appid]')];
  if (!nodes.length) return;
  for (const el of nodes) {
    const hit = SPEC_BADGES.get(el.dataset.specAppid);
    if (hit) paintSpecBadge(el.dataset.specAppid, hit);
  }
  const todo = nodes.filter(el => !SPEC_BADGES.has(el.dataset.specAppid) && !SPEC_INFLIGHT.has(el.dataset.specAppid)).slice(0, 40);
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const el = todo[i++];
      const id = el.dataset.specAppid, name = el.dataset.specName || '';
      SPEC_INFLIGHT.add(id);
      try {
        const r = await api(`/api/game/sysreq?appid=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`);
        const c = r.comparison;
        const detail = (c && c.verdictText) || 'Steam 未提供配置对比';
        let v;
        if (!c || !c.verdict || c.verdict === 'unknown') v = { cls: 'unknown', text: '❔ 无配置数据', title: 'Steam 没有公开这款游戏的配置要求' };
        else if (c.verdict === 'fail') v = { cls: 'fail', text: '⚠️ 配置不够', title: detail + ' · 你的电脑达不到最低要求' };
        else if (c.verdict === 'warn' || c.verdict === 'min') v = { cls: 'warn', text: '⚠️ 配置勉强', title: detail + ' · 部分项目只能勉强达标' };
        else v = { cls: 'ok', text: '✅ 配置够', title: detail };
        SPEC_BADGES.set(id, v);
        paintSpecBadge(id, v);
      } catch (e) {
        const v = { cls: 'unknown', text: '❔ 检查失败', title: e.message };
        SPEC_BADGES.set(id, v);
        paintSpecBadge(id, v);
      } finally { SPEC_INFLIGHT.delete(id); }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}
// 浏览器扫描页等地方会自行重绘列表，定时补一次新出现的徽标（缓存命中不再联网）
setInterval(() => { try { applyWishlistSpecBadges(); } catch {} }, 5000);

function renderProgress() {
  const t = S.totals, snaps = S.snapshots || [], d = S.deltas || {};
  $('#progressKpi').innerHTML =
    kpi('快照数量', snaps.length, '条', '每次扫描自动写入 data/snapshots.json', 'rgba(47,109,246,.16)', '◷') +
    kpi('较上次新增', d.hasBaseline ? '+' + h(d.minutes) : '—', d.hasBaseline ? '小时' : '', d.hasBaseline ? '自 ' + timeStr(d.since) : '再扫描一次即可生成对比', 'rgba(226,148,55,.16)', '↗') +
    kpi('累计时长', t.totalHours.toLocaleString('zh-CN'), '小时', '历史快照持续累积', 'rgba(16,179,156,.16)', '◈');

  // 折线趋势
  const data = snaps.length >= 2 ? snaps : [];
  if (!data.length) { $('#trendChart').innerHTML = '<div class="empty">还没有足够的快照，点击右上角刷新可立即生成一条。</div>'; }
  else {
    const W = 720, H = 220, P = 34;
    const vals = data.map(s => s.totalMinutes / 60);
    const min = Math.min(...vals), max = Math.max(...vals), span = (max - min) || 1;
    const pts = vals.map((v, i) => [P + i * (W - P * 2) / (data.length - 1 || 1), H - P - (v - min) / span * (H - P * 2)]);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${H - P} L${pts[0][0].toFixed(1)},${H - P} Z`;
    const gl = [0, .5, 1].map(k => `<line x1="${P}" y1="${P + k * (H - P * 2)}" x2="${W - P}" y2="${P + k * (H - P * 2)}" stroke="${gridColor()}" stroke-width="1"/>`).join('');
    $('#trendChart').innerHTML = `<div class="trend-wrap"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">
      <defs><linearGradient id="fillg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f6df6" stop-opacity=".28"/><stop offset="1" stop-color="#2f6df6" stop-opacity="0"/></linearGradient>
      <linearGradient id="lineg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2f6df6"/><stop offset="1" stop-color="#10b39c"/></linearGradient></defs>
      ${gl}<path d="${area}" fill="url(#fillg)"/><path d="${line}" fill="none" stroke="url(#lineg)" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>
      ${pts.map(p => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3" fill="#ffffff" stroke="#2f6df6" stroke-width="2"/>`).join('')}
      <text x="${P}" y="16" fill="${subColor()}" font-size="10">${max.toFixed(1)} h</text>
      <text x="${P}" y="${H - 8}" fill="${subColor()}" font-size="10">${min.toFixed(1)} h</text>
      <text x="${W - P}" y="${H - 8}" text-anchor="end" fill="${subColor()}" font-size="10">${timeStr(data[data.length - 1].iso)}</text></svg></div>`;
  }

  $('#deltaSince').textContent = d.hasBaseline ? '自 ' + timeStr(d.since) : '等待基线';
  $('#deltaList').innerHTML = d.top?.length ? d.top.map(x => `<div class="recent-item"><div class="r-ico">↗</div><div class="r-main"><b>${esc(x.name)}</b><small>新增游玩时长</small></div><div class="r-val" style="color:var(--up)">+${h(x.minutes)}h</div></div>`).join('') : '<div class="empty">两次快照之间暂无新增时长。</div>';
  $('#snapCount').textContent = snaps.length + ' 条';
  $('#snapList').innerHTML = [...snaps].reverse().slice(0, 12).map(s => `<div class="recent-item"><div class="r-ico">◷</div><div class="r-main"><b>${timeStr(s.iso)}</b><small>${esc(s.mode || 'auto')} 模式 · ${s.totalValueCents ? shortMoney(s.totalValueCents) : '未估价'}</small></div><div class="r-val num">${h(s.totalMinutes)} h</div></div>`).join('') || '<div class="empty">暂无快照</div>';
}

function localMarkdown() {
  const t = S.totals;
  const lib = slLibraryCounts();
  const lines = ['# SteamLens · Steam 使用报告', '', `- 生成时间：${new Date(S.generatedAt).toLocaleString('zh-CN')}`,
    `- 连接模式：${S.connection.type}`,
    lib.hasBrowser
      ? `- 游戏总数：${lib.total}（浏览器扫描实际提取到的已拥有游戏款数；提取多少就是多少，不与本机库合并、不补未下载游戏）`
      : `- 游戏总数：${t.games}（已安装 ${t.installed} / 有游玩记录 ${t.playedGames}；等待浏览器扫描）`,
    `- 累计时长：${t.totalHours} 小时`, `- 近 14 天：${t.last14Hours} 小时`,
    `- 库价值估算：¥${t.totalValueYuan}（已估价 ${t.valuedGames} 款）`,
    `- 隐私/隐藏游戏：${t.privateGames} 款，合计 ${h(t.privateMinutes)} 小时（已计入总量）`, '',
    '## 时长排行（前 20）', '', '| # | 游戏 | 时长(h) | 近14天(h) | 状态 | 估价(¥) |',
    '|---|------|--------:|----------:|------|--------:|'];
  S.games.slice(0, 20).forEach((g, i) => lines.push(`| ${i + 1} | ${(MASK && g.effectivePrivate) ? '隐私游戏 #' + String(g.appid).slice(-4) : g.name} | ${g.playtimeHours} | ${g.playtime2wksHours} | ${g.installed ? '已安装' : '未安装'} | ${g.priceCents ? (g.priceCents / 100).toFixed(2) : '—'} |`));
  lines.push('', '> 口径说明：' + S.privacy.priceBasis, '', '> ' + S.privacy.statement, '', '## 请帮我分析', '', '基于以上数据，请分析我的游戏时间分布、投入产出比、最近游玩趋势，并给出 3 条可执行建议。');
  return lines.join('\n');
}
/* 导出页只保留「交给 DeepSeek 的上下文包」：三个下载入口（JSON / CSV / Markdown）已移除 */
function renderExport() {
  $('#mdPreview').textContent = localMarkdown();
}

function renderConnect() {
  $('#autoCard').style.outline = MODE === 'auto' ? '2px solid rgba(47,109,246,.35)' : 'none';
  $('#manualCard').style.outline = MODE === 'manual' ? '2px solid rgba(47,109,246,.35)' : 'none';
  const args = SERVER_ROOT.replace(/[\\/]$/, '') + '\\mcp-bridge.js';
  const cfg = { mcpServers: { 'steam-lens': { command: 'node', args: [args], env: {} } } };
  $('#mcpCode').textContent = JSON.stringify(cfg, null, 2);
  $('#mcpTools').innerHTML = ['steam_overview', 'steam_games', 'steam_private_games', 'steam_value_report', 'steam_progress', 'steam_context', 'steam_rescan', 'steam_connection', 'steam_friends', 'steam_friend_events', 'steam_friend_refresh', 'steam_account', 'steam_wishlist', 'steam_excluded_games', 'steam_refresh_value', 'steam_notification_status', 'steam_wishlist_check', 'steam_hidden_games', 'steam_hidden_scan',
  'steam_offline_status', 'steam_dingtalk_status', 'steam_friend_profile']
    .map(t => `<span class="tool-chip mono">${t}</span>`).join('');
  const p = `http://127.0.0.1:${$('#cfgPort').value || 8787}`;
  $('#apiList').innerHTML = [
    ['GET', '/api/state?mode=auto|manual 完整统计'],
    ['POST', '/api/rescan 强制重扫并写快照'],
    ['GET', '/api/context 给 AI 的 Markdown 报告'],
    ['GET', '/api/export?format=json|csv|md 导出'],
    ['POST', '/api/override 手动修正游戏数据'],
    ['POST', '/api/estimate 联网估算库价值'],
    ['GET', '/api/snapshots 快照历史'],
    ['GET', '/api/friends 好友在线状态'],
    ['POST', '/api/friends/refresh 立即刷新好友'],
    ['GET', '/api/friends/events 上线事件'],
    ['GET', '/api/account 账号连接与真实库'],
    ['POST', '/api/account/connect 登录并扫描'],
    ['GET', '/api/mail/status 邮箱登录状态'],
    ['POST', '/api/mail/connect 登录 QQ 邮箱'],
    ['POST', '/api/mail/logout 退出账号'],
    ['GET', '/api/wishlist 愿望单价格状态'],
    ['POST', '/api/wishlist/check 立即查价'],
    ['GET', '/api/autorefresh 自动刷新状态'],
    ['GET', '/api/estimate/status 估价进度（含并发/超时）'],
    ['GET', '/api/offline/status 离线模式与本机快照'],
    ['POST', '/api/offline/sync 离线改动合并回在线版'],
    ['GET', '/api/dingtalk/status 钉钉通知状态'],
    ['GET', '/api/friend-profile 好友档案（时长/库价值）'],
    ['GET', '/api/hidden/status 隐藏游戏识别状态'],
    ['POST', '/api/hidden/scan 立即扫描 Steam 隐藏'],
    ['POST', '/api/hidden/config 自动同步开关（每分钟）'],
    ['GET', '/api/cover/:appid 本地封面图']
  ].map(([m, t]) => `<div class="api-row"><b>${m}</b><span class="mono">${esc(t)}</span></div>`).join('') + `<div class="api-row"><b>BASE</b><span class="mono">${esc(p)} · 仅本机可访问</span></div>`;
  $('#privacyStatement').innerHTML = `${esc(S.privacy.statement)}<br><br><b>价值口径：</b>${esc(S.privacy.priceBasis)}<br><br><b>隐私游戏：</b>${esc(S.privacy.privateRule)}`;
  $('#detectedRoots').innerHTML = (S.connection.steamRoot ? `<span class="root-chip">根目录：${esc(S.connection.steamRoot)}</span>` : '') +
    (S.connection.libraries || []).map(l => `<span class="root-chip">库 ${esc(l.index)}：${esc(l.root)} ${l.available ? '' : '(不可访问)'}</span>`).join('') +
    (S.connection.warnings || []).map(w => `<span class="root-chip" style="color:var(--amber)">${esc(w)}</span>`).join('');
}

async function fillConfig() {
  try {
    const c = await api('/api/config');
    $('#cfgSteamPath').value = c.steamPath || '';
    $('#cfgSteamId').value = c.steamId64 || '';
    $('#cfgApiKey').value = c.apiKey || '';
    $('#cfgPort').value = c.port || 8787;
    $('#cfgPasted').value = c.pastedOwnedGames || '';
    $('#cfgHint').textContent = c.apiKeySet ? 'API Key 已保存' : 'API Key 未填写（自动模式不需要）';
    $('#detectedRoots').innerHTML = (c.detectedRoots || []).slice(0, 4).map(r => `<span class="root-chip">探测到：${esc(r.path)} · ${esc(r.source)}</span>`).join('');
  } catch { $('#cfgHint').textContent = '离线演示：启动本地服务后可保存配置'; }
}

/* ------------------------------ 好友上线页 ------------------------------ */
function checkFriendNotifications() {
  if (!F || DEMO) return;
  const evs = (F.events || []).filter(e => e.ts > lastEventTs);
  const newest = evs.length ? Math.max(lastEventTs, ...evs.map(e => e.ts)) : lastEventTs;
  if (lastEventTs > 0 && F.config?.friendNotify) {
    const starred = new Set((F.friends || []).filter(f => f.starred).map(f => f.steamId64));
    for (const e of evs.filter(x => x.type === 'online' && starred.has(x.steamId64)).slice(0, 3)) {
      const msg = `${e.name} 上线了${e.game ? '，正在玩 ' + e.game : ''}`;
      toast('★ ' + msg);
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try { new Notification('SteamLens · 好友上线', { body: msg }); } catch {}
      }
    }
  }
  if (newest > lastEventTs) { lastEventTs = newest; localStorage.setItem('sl-last-event', String(newest)); }
}

function fillFriendConfig() {
  if (!F || !F.config) return;
  const c = F.config;
  savedPollSec = Number(c.friendPollSec) || 60;
  $('#fApiKey').value = '';
  $('#fApiKey').placeholder = c.hasApiKey ? '已保存 API Key · 留空表示不修改' : '填入后即可实时监控好友上线';
  $('#fPoll').value = savedPollSec;
  $('#fPasted').value = '';
  $('#fPasted').placeholder = c.friendPastedSummaries ? '已保存粘贴的 JSON · 留空表示不修改' : '{"response":{"players":[...]}}';
  $('#fNotify').checked = c.friendNotify !== false;
  $('#fRemoteAvatar').checked = !!c.friendLoadRemoteAvatars;
  $('#friendAuto').checked = savedPollSec !== 0;
  $('#friendApiTag').textContent = c.hasApiKey ? 'API Key 已配置' : '未配置 Key';
}

/* ---------------- 上线时段分布：一天 / 14 天 / 月 三个范围 ---------------- */
const HOUR_RANGE_LABEL = { '1d': '一天上线（今天）', '14d': '14 天上线', '30d': '月上线（近 30 天）' };
let HOUR_RANGE = '1d';
try { HOUR_RANGE = localStorage.getItem('sl-hour-range') || '1d'; } catch {}
if (!HOUR_RANGE_LABEL[HOUR_RANGE]) HOUR_RANGE = '1d';

function renderHourRangeBar() {
  document.querySelectorAll('[data-hour-range]').forEach(b => {
    const active = b.getAttribute('data-hour-range') === HOUR_RANGE;
    b.classList.toggle('is-active', active);
    b.classList.toggle('primary', active);
    b.classList.toggle('ghost', !active);
  });
  if ($('#hourRangeNote')) {
    $('#hourRangeNote').textContent = HOUR_RANGE === '1d'
      ? '每天 00:00 自动清零 · 24 根小时柱'
      : `${HOUR_RANGE === '14d' ? '14' : '30'} 根日期柱 · 那天上线过一次就变蓝`;
  }
}

/** 离线快照里按范围本地重算，不联网也能切换三个按钮 */
function offlineHourly(range) {
  const now = Date.now();
  const base = new Date(now); base.setHours(0, 0, 0, 0);
  const events = (F?.events || []).map(e => ({
    ...e, ts: typeof e?.ts === 'number' ? e.ts : Date.parse(e?.iso || '')
  })).filter(e => Number.isFinite(e.ts));
  const common = {
    ...(F?.stats || {}),
    currentHour: new Date().getHours(), liveNow: F?.totals?.online ?? 0,
    liveMinutes: 0, liveSeconds: 0, offline: true,
    range, rangeLabel: HOUR_RANGE_LABEL[range]
  };
  if (range === '14d' || range === '30d') {
    const days = range === '14d' ? 14 : 30;
    const labels = [], buckets = [], pres = [];
    for (let i = days - 1; i >= 0; i--) {
      const start = base.getTime() - i * 86400000, end = start + 86400000;
      const d = new Date(start);
      labels.push(`${d.getMonth() + 1}/${d.getDate()}`);
      let n = 0, any = false;
      for (const e of events) {
        if (e.ts < start || e.ts >= end) continue;
        if (['online', 'game', 'offline'].includes(e.type)) {
          any = true;
          if (e.type === 'online' || e.type === 'game') n++;
        }
      }
      buckets.push(n); pres.push(any);
    }
    if (common.liveNow > 0) pres[pres.length - 1] = true;
    return { ...common, buckets, presence: pres, labels, mode: 'day', hourBuckets: buckets, hourPresence: pres };
  }
  const from = base.getTime();
  const buckets = Array(24).fill(0), pres = Array(24).fill(false);
  for (const e of events) {
    if (e.ts < from) continue;
    if (['online', 'game', 'offline'].includes(e.type)) {
      const h = new Date(e.ts).getHours();
      buckets[h]++; pres[h] = true;
    }
  }
  return {
    ...common, buckets, presence: pres,
    labels: Array.from({ length: 24 }, (_, i) => String(i)), mode: 'hour',
    hourBuckets: buckets, hourPresence: pres
  };
}

document.querySelectorAll('[data-hour-range]').forEach(b => b.addEventListener('click', () => {
  HOUR_RANGE = b.getAttribute('data-hour-range') || '1d';
  try { localStorage.setItem('sl-hour-range', HOUR_RANGE); } catch {}
  renderHourRangeBar();
  refreshHourlyLive();
  toast('上线时段分布：' + HOUR_RANGE_LABEL[HOUR_RANGE]);
}));
function hourChartHTML(b, nowHour = -1, presence = null, labels = null, mode = 'hour', seconds = null) {
  const arr = Array.isArray(b) && b.length ? b : Array(24).fill(0);
  const max = Math.max(...arr, 1);
  const pres = Array.isArray(presence) && presence.length === arr.length ? presence : arr.map(v => v > 0);
  const secs = Array.isArray(seconds) && seconds.length === arr.length ? seconds : null;
  const labs = Array.isArray(labels) && labels.length === arr.length ? labels : arr.map((_, i) => String(i));
  const isDay = mode === 'day';
  const every = isDay ? (arr.length > 20 ? 5 : arr.length > 10 ? 3 : 2) : 6;
  return `<div class="hour-chart${isDay ? ' day-mode' : ''}">${arr.map((v, i) => {
    const show = isDay ? (i % every === 0 || i === arr.length - 1) : (i % 6 === 0);
    const lab = labs[i] ?? '';
    const isNow = isDay ? i === arr.length - 1 : i === nowHour;
    let dur = '';
    if (secs && secs[i]) { const s = Number(secs[i]) || 0; const mm = Math.floor(s / 60), ss = s % 60; dur = ` · 该时段好友累计在线 ${mm} 分 ${ss} 秒`; }
    const baseTip = isDay
      ? `${lab} · ${v} 次上线${pres[i] ? ' · 这天上线过' : ' · 无上线记录'}`
      : `${i}:00${pres[i] ? ' · 在线过' : ''} · ${v} 次事件`;
    const tip = baseTip + dur;
    /* 每秒只改 data-tip 里的时长文字，不重建 DOM，柱子才不会反复重播高度过渡动画 */
    return `<div class="hour-col${pres[i] ? ' is-on' : ''}${isNow ? ' is-now' : ''}" title="${esc(tip)}" data-tip="${esc(tip)}" data-base-tip="${esc(baseTip)}"><i style="height:${pres[i] ? Math.max(18, v / max * 70) : 3}px"></i><small>${show ? esc(lab) : ''}</small></div>`;
  }).join('')}</div>`;
}

/* 上线时段分布图的悬浮提示：把 data-tip 显示在光标旁，避免依赖浏览器原生 title 的延迟 */
let _chartTip = null;
function chartTipEl() {
  if (!_chartTip) {
    _chartTip = document.createElement('div');
    _chartTip.id = 'chartTip';
    _chartTip.style.cssText = 'position:fixed;z-index:9999;pointer-events:none;background:#1b2330;color:#e8eefc;border:1px solid #2c3a52;border-radius:8px;padding:6px 9px;font-size:12px;line-height:1.5;max-width:250px;box-shadow:0 6px 20px rgba(0,0,0,.35);display:none;';
    document.body.appendChild(_chartTip);
  }
  return _chartTip;
}
function bindChartTip() {
  const tip = chartTipEl();
  document.addEventListener('mousemove', e => {
    const col = e.target && e.target.closest ? e.target.closest('.hour-col[data-tip]') : null;
    if (col) {
      tip.textContent = col.getAttribute('data-tip');
      tip.style.display = 'block';
      let x = e.clientX + 14, y = e.clientY + 14;
      if (x + tip.offsetWidth > window.innerWidth) x = e.clientX - tip.offsetWidth - 14;
      if (y + tip.offsetHeight > window.innerHeight) y = e.clientY - tip.offsetHeight - 14;
      tip.style.left = x + 'px';
      tip.style.top = y + 'px';
    } else if (tip.style.display === 'block') {
      tip.style.display = 'none';
    }
  }, { passive: true });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindChartTip); else bindChartTip();

/** 上线时段分布：每秒只更新数值 / 提示文字，柱子 DOM 只在数据真的变化时重建。
    以前每秒 innerHTML 全量重建，配合 CSS 的 height 过渡会不停重播「从矮长到高」，
    看起来就是图形动来变去；同时鼠标悬浮的柱子会被替换掉。 */
let _hourChartSig = '', _hourLegendSig = '';
function renderHourlyLive(h) {
  const box = $('#hourChart');
  if (!h || !box) return;
  const buckets = h.buckets || h.hourBuckets;
  const presence = h.presence || h.hourPresence;
  const mode = h.mode || 'hour';
  const sig = JSON.stringify([buckets, presence, h.labels, mode, h.currentHour, h.range, !!h.offline]);
  if (sig !== _hourChartSig) {
    box.innerHTML = hourChartHTML(buckets, h.currentHour, presence, h.labels, mode, h.hourSeconds);
    _hourChartSig = sig;
  } else {
    /* 结构没变：只把每秒递增的「累计在线 X 分 Y 秒」写回提示，不动任何元素 */
    const secs = Array.isArray(h.hourSeconds) ? h.hourSeconds : null;
    const cols = box.querySelectorAll('.hour-col[data-base-tip]');
    if (secs && secs.length === cols.length) {
      cols.forEach((col, i) => {
        const s = Number(secs[i]) || 0;
        const dur = s ? ` · 该时段好友累计在线 ${Math.floor(s / 60)} 分 ${s % 60} 秒` : '';
        const tip = col.getAttribute('data-base-tip') + dur;
        if (col.getAttribute('data-tip') !== tip) {
          col.setAttribute('data-tip', tip); col.setAttribute('title', tip);
        }
      });
    }
  }
  const legendHtml = mode === 'day'
    ? '<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:linear-gradient(180deg,#3a7bff,#1b4fd0);vertical-align:middle;margin:0 4px"></span>蓝色 = 那天上线过（一次即亮）<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:linear-gradient(180deg,#27e0c0,#13a98d);vertical-align:middle;margin:0 4px 0 12px"></span>青色 = 今天'
    : '<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:linear-gradient(180deg,#3a7bff,#1b4fd0);vertical-align:middle;margin:0 4px"></span>蓝色 = 该小时内好友在线过<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:linear-gradient(180deg,#27e0c0,#13a98d);vertical-align:middle;margin:0 4px 0 12px"></span>青色 = 当前小时';
  if ($('#hourLegend') && legendHtml !== _hourLegendSig) {
    $('#hourLegend').innerHTML = legendHtml;
    _hourLegendSig = legendHtml;
  }
  const rLabel = h.rangeLabel || HOUR_RANGE_LABEL[h.range] || HOUR_RANGE_LABEL[HOUR_RANGE];
  if ($('#hourChartTag')) $('#hourChartTag').textContent = h.offline
    ? `离线快照 · ${rLabel}` : `${rLabel} · ${h.liveNow ?? 0} 人在线 · 每秒更新`;
  if ($('#hourLiveInfo')) {
    $('#hourLiveInfo').className = h.offline ? 'diag-line warn' : 'diag-line ok';
    $('#hourLiveInfo').innerHTML = h.offline
      ? '<i>!</i><span>离线模式：显示本机快照 · 当前时间 ' + esc(new Date().toLocaleTimeString('zh-CN', { hour12: false })) + ' · 服务恢复后自动同步</span>'
      : '<i>✓</i><span>本小时实时在线累计 ' + esc(String(h.liveMinutes ?? 0)) + ' 分钟（' + esc(String(h.liveSeconds ?? 0))
        + ' 秒）· 今日上线 ' + esc(String(h.todayLogins ?? 0)) + ' 次 · 累计事件 '
        + esc(String(h.totalEvents ?? 0)) + ' 条 · 每秒刷新</span>';
  }
  const boxes = $('#friendStats')?.querySelectorAll('.stat-box .num');
  if (boxes && boxes.length >= 3 && !h.offline) {
    boxes[0].textContent = String(h.todayLogins ?? 0);
    boxes[1].textContent = ((h.todayOnlineMinutes || 0) / 60).toFixed(1) + 'h';
    boxes[2].textContent = String(h.totalEvents ?? 0);
  }
  if ($('#friendsKpi') && F && !h.offline) {
    const el = $('#friendsKpi').children[3];
    if (el) {
      const v = el.querySelector('.k-value'), sub = el.querySelector('.k-sub');
      if (v) v.innerHTML = `${h.todayLogins ?? 0}<small>次</small>`;
      if (sub) sub.textContent = `累计在线 ${((h.todayOnlineMinutes || 0) / 60).toFixed(1)} 小时（估算）· 每秒更新`;
    }
  }
  if ($('#eventCount') && !h.offline) $('#eventCount').textContent = (h.totalEvents ?? 0) + ' 条';
}

/** 把「下线时刻」换算成「已离开 X 天 HH:MM:SS」，按当前时钟逐秒变化 */
function awayText(since) {
  if (!since) return '暂无离线记录';
  const s = Math.max(0, Math.floor((Date.now() - Number(since)) / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = n => String(n).padStart(2, '0');
  return (d ? d + ' 天 ' : '') + p(h) + ':' + p(m) + ':' + p(sec);
}

/** 离线时用本页快照里的下线事件 / 上次离线时间自己算，依然每秒递增 */
function offlineAwayData() {
  const evs = F?.events || [];
  const map = new Map();
  for (const e of evs) {
    const id = String(e.steamId64 || '');
    if (!id || map.has(id)) continue;
    map.set(id, { type: e.type, ts: Date.parse(e.iso || '') || 0 });
  }
  return (F?.friends || []).map(f => {
    const e = map.get(String(f.steamId64));
    const online = Number(f.personastate) > 0;
    let since = 0;
    if (!online) {
      if (e && e.type === 'offline' && e.ts) since = e.ts;
      else if (f.lastLogoff) since = Number(f.lastLogoff) * 1000;
    }
    return {
      steamId64: String(f.steamId64), name: f.name, online,
      awaySince: since || null,
      awaySeconds: since ? Math.max(0, Math.floor((Date.now() - since) / 1000)) : null,
      awayFrom: since ? new Date(since).toISOString() : null,
      source: since ? (e?.type === 'offline' ? '本机下线事件（精准）' : 'Steam 上次离线') : ''
    };
  });
}

function renderFriendAway(a) {
  const list = a?.friends || [];
  const box = $('#friendAwayList'); if (!box) return;
  box.innerHTML = list.length ? list.map(f => `<div class="fp-game-row${f.online ? ' is-playing' : ''}">
      <div class="fp-game-ico">${esc(String(f.name || '?').slice(0, 1))}</div>
      <div class="fp-game-main"><b>${esc(f.name)}</b><small>${f.online ? '当前在线 · 计时已清零' : (f.awayFrom ? '下线于 ' + esc(timeStr(f.awayFrom)) : '暂无下线记录') + (f.source ? ' · ' + esc(f.source) : '')}</small></div>
      <div class="fp-game-meta"><b>${f.online ? '—' : esc(awayText(f.awaySince))}</b><small>${f.online ? '在线中' : '已离开'}</small></div>
    </div>`).join('')
    : '<div class="fp-game-empty">还没有好友记录。保持 Steam 客户端「好友与聊天」窗口开着即可。</div>';
  // 同步更新好友卡片里的那一行，不重建卡片，筛选 / 搜索都不受影响
  for (const f of list) {
    const el = document.querySelector(`[data-away="${f.steamId64}"]`);
    if (el) el.textContent = f.online ? '当前在线 · 计时已清零'
      : (f.awaySince ? '已离开 ' + awayText(f.awaySince) : '暂无离线记录');
  }
  const longest = list.filter(x => !x.online && x.awaySeconds).sort((x, y) => y.awaySeconds - x.awaySeconds)[0];
  if ($('#friendAwayTag')) $('#friendAwayTag').textContent = `每秒更新 · ${list.filter(x => !x.online).length} 人离线`;
  if ($('#friendAwayInfo')) {
    $('#friendAwayInfo').className = a?.offline ? 'diag-line warn' : 'diag-line ok';
    $('#friendAwayInfo').innerHTML = '<i>✓</i><span>当前时间 '
      + esc(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
      + (longest ? ' · 离开最久：' + esc(longest.name) + ' ' + esc(awayText(longest.awaySince)) : ' · 暂无下线记录')
      + ' · 每秒刷新' + (a?.offline ? '（离线快照）' : '') + '</span>';
  }
}

async function refreshHourlyLive() {
  let h = null, a = null;
  if (OFF && !OFF.online) {
    h = offlineHourly(HOUR_RANGE);
    a = { friends: offlineAwayData(), offline: true };
  } else {
    [h, a] = await Promise.all([
      api('/api/friends/hourly?range=' + encodeURIComponent(HOUR_RANGE)).catch(() => null),
      api('/api/friends/away').catch(() => null)
    ]);
    if (!a) a = { friends: offlineAwayData(), offline: false };
  }
  if (h) renderHourlyLive(h);
  if (a) renderFriendAway(a);
}
renderHourRangeBar();
setInterval(refreshHourlyLive, 1000);

function slShown(list, key, cap = 5) { return SL_MORE[key] ? list : list.slice(0, cap); }
function slMoreBtn(key, total, cap = 5, label = '显示更多') {
  if (total <= cap) return '';
  return '<button class="btn ghost tiny sl-more-btn" data-sl-more="' + key + '">'
    + (SL_MORE[key] ? '收起 ▴' : label + '（还有 ' + (total - cap) + ' 个）▾') + '</button>';
}
/* 统一事件委托：列表每次重绘后按钮都能点；按 key 只重绘对应区块 */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-sl-more]'); if (!b) return;
  const k = b.getAttribute('data-sl-more');
  if (!(k in SL_MORE)) return;
  SL_MORE[k] = !SL_MORE[k];
  if (k === 'friends' || k === 'fpChips') renderFriends();
  else if (k === 'discover') renderDiscover();
  else if (k === 'ptPeople') renderPlaytimeSummary();
  else renderFpt();
});
function renderFriends() {
  if (!F) return;
  const t = F.totals || {}, st = F.stats || {};
  $('#friendsKpi').innerHTML =
    kpi('好友总数', t.friends ?? 0, '人', `本机缓存名册 ${t.localCached ?? 0} 人 · 关注 ${t.starred ?? 0} 人`, 'rgba(47,109,246,.16)', '◉') +
    kpi('当前在线', t.online ?? 0, '人', `忙碌 ${t.busy ?? 0} · 离开 ${t.away ?? 0} · 离线 ${t.offline ?? 0}`, 'rgba(16,179,156,.16)', '●') +
    kpi('正在游戏', t.ingame ?? 0, '人', '实时显示正在运行的游戏', 'rgba(122,99,245,.16)', '▸') +
    kpi('今日上线', st.todayLogins ?? 0, '次', `累计在线 ${((st.todayOnlineMinutes || 0) / 60).toFixed(1)} 小时（估算）`, 'rgba(226,148,55,.16)', '↗');

  $('#friendsModeTag').textContent = F.dataModeLabel || '—';
  $('#friendPollInfo').textContent = F.config?.friendPollSec
    ? `服务每 ${F.config.friendPollSec} 秒后台轮询一次 · 最近更新 ${timeStr(F.generatedAt)}`
    : '后台监控已暂停';
  $('#friendApiTag').textContent = F.config?.hasApiKey ? 'API Key 已配置' : '未配置 Key';
  $('#eventCount').textContent = (st.totalEvents ?? 0) + ' 条';

  const allFriends = [...(F.friends || [])];
  let list = [...allFriends];
  if (FFILTER === 'online') list = list.filter(f => f.personastate > 0);
  if (FFILTER === 'ingame') list = list.filter(f => !!f.game);
  if (FFILTER === 'starred') list = list.filter(f => f.starred);
  if (FSEARCH) { const q = FSEARCH.toLowerCase(); list = list.filter(f => String(f.name || '').toLowerCase().includes(q) || String(f.steamId64 || '').includes(q)); }

  // 仅在「重进后首次渲染」且筛选来自旧设置时自动回退一次，避免残留筛选把好友藏起来。
  // 用户手动点过筛选后（FILTER_USER_SET）一律尊重选择，哪怕结果为空也保留空态提示。
  let friendFilterRecovered = false;
  if (!list.length && allFriends.length > 0 && (FFILTER !== 'all' || FSEARCH)
      && FILTER_FIX_AVAILABLE && !FILTER_USER_SET) {
    FFILTER = 'all'; FSEARCH = ''; friendFilterRecovered = true;
    $$('#friendFilters .chip').forEach(x => x.classList.toggle('active', x.dataset.f === 'all'));
    if ($('#friendSearch')) $('#friendSearch').value = '';
    if (!RESTORING && !DEMO) { recordFilter('all', 'friend'); queueUi({ friendSearch: '' }); }
    list = [...allFriends];
  }
  if (FILTER_FIX_AVAILABLE && !RESTORING) FILTER_FIX_AVAILABLE = false;

  const shown = slShown(list, 'friends', 5);
  $('#friendsGrid').innerHTML = (shown.map(f => `<div class="friend-card ${f.game ? 'is-ingame' : (f.personastate > 0 ? 'is-online' : '')}" data-fn-card="${f.steamId64}">
    <button class="friend-star ${f.starred ? 'on' : ''}" data-star="${f.steamId64}" data-on="${f.starred ? 1 : 0}" title="关注（上线时通知）">${f.starred ? '★' : '☆'}</button>
    <button class="friend-del" data-fdel="${f.steamId64}" title="只从软件里删掉这位好友（Steam 好友关系不变）">✕</button>
    <div class="friend-avatar">${f.avatar ? `<img src="${esc(f.avatar)}" loading="lazy" onerror="this.remove()">` : esc(String(f.name || '?').slice(0, 1).toUpperCase())}<span class="state-dot tone-${esc(f.tone)}"></span></div>
    <div class="friend-main">
      <b title="${esc(f.name)}">${esc(f.name)}</b>
      <span class="f-state ${f.personastate > 0 ? 'on' : ''}"><i class="state-dot tone-${esc(f.tone)}"></i>${esc(f.stateLabel)}</span>
      ${f.game ? `<span class="f-game">▸ ${esc(f.game)}</span>` : ''}
      <span class="f-meta">${f.lastLogoff ? '上次离线 ' + dateStr(f.lastLogoff) : '暂无离线记录'} · ${esc(f.source || '')}</span>
      <span class="f-meta fp-away" data-away="${f.steamId64}">正在计算离开时长…</span>
      ${f.profile ? `<span class="f-meta fp-brief">档案 ${f.profile.games} 款 · ${f.profile.totalHours} 小时 · ${shortMoney(f.profile.valueYuan * 100)}</span>` : ''}
      ${friendAchBrief(f.steamId64)}
      <button class="link-btn fp-open" data-fp="${f.steamId64}">查看档案 →</button>
      <button class="link-btn fn-open" data-fn="${f.steamId64}">👥 朋友的朋友 →</button>
    </div></div>`).join('') + slMoreBtn('friends', list.length, 5, '显示更多好友')) || `<div class="empty" style="grid-column:1/-1">当前筛选「${FFILTER === 'online' ? '在线' : FFILTER === 'ingame' ? '游戏中' : FFILTER === 'starred' ? '关注' : '全部'}」下没有匹配的好友${FSEARCH ? `（搜索：${esc(FSEARCH)}）` : ''}。<br><br><button class="btn ghost" id="btnShowAllFriends">显示全部好友（${allFriends.length}）</button><br><br><span class="fine">状态未知时请在 Steam 客户端打开「好友与聊天」窗口（可最小化），SteamLens 会每 3 秒直接读取 Steam 显示的在线状态。</span></div>`;

  $('#friendTimeline').innerHTML = (F.events || []).slice(0, 40).map(e => `<div class="tl-item">
    <div class="tl-dot ${esc(e.type)}">${e.type === 'online' ? '●' : e.type === 'offline' ? '○' : '▸'}</div>
    <div class="tl-main"><b>${esc(e.text || e.name)}</b><small>${timeStr(e.iso)}</small></div></div>`).join('') || '<div class="empty">还没有上线记录。Steam 客户端开着「好友与聊天」窗口时，SteamLens 每 3 秒读取一次状态；好友从离线变为在线，这里就会自动出现一条「上线了」。</div>';

  const top = (st.topFriends || []).slice(0, 4);
  $('#friendStats').innerHTML =
    `<div class="stat-box"><b class="num">${st.todayLogins ?? 0}</b><small>今日上线次数</small></div>
     <div class="stat-box"><b class="num">${((st.todayOnlineMinutes || 0) / 60).toFixed(1)}h</b><small>今日累计在线（估算）</small></div>
     <div class="stat-box"><b class="num">${st.totalEvents ?? 0}</b><small>累计记录事件</small></div>
     <div class="stat-box"><b class="num">${t.starred ?? 0}</b><small>关注好友</small></div>` +
    (top.length ? `<div style="grid-column:1/-1;margin-top:4px"><div class="card-head" style="margin-bottom:8px"><h2 style="font-size:12px">今日最在线</h2></div>${barsHTML(top.map(x => ({ name: x.name, value: Math.round(x.onlineMinutes / 6) / 10 })), v => v + ' h')}</div>` : '');
  /* 与 renderHourlyLive 共用同一份结构签名：好友区轮询重绘时不要顺手重建图表，
     否则每次都会重播柱子的 height 过渡，看起来就是图形动来变去。 */
  if ($('#hourChart')) {
    const _sig = JSON.stringify([
      st.buckets || st.hourBuckets, st.presence || st.hourPresence, st.labels,
      st.mode || 'hour', new Date().getHours(), HOUR_RANGE, !!(OFF && !OFF.online)
    ]);
    if (_sig !== _hourChartSig) {
      $('#hourChart').innerHTML = hourChartHTML(st.buckets || st.hourBuckets, new Date().getHours(), st.presence || st.hourPresence, st.labels, st.mode || 'hour', st.hourSeconds);
      _hourChartSig = _sig;
    }
  }
  renderFriendProfiles();

  const warns = [...(F.warnings || [])];
  if (friendFilterRecovered) warns.unshift('筛选条件没有匹配到好友，已自动恢复「全部」显示（好友一直都在）');
  if (allFriends.length <= 1) warns.unshift('本机 Steam 目前只缓存到 1 位好友名册；Steam 客户端里出现更多好友时会自动补进来');
  if (F.dataMode === 'steam-client' || F.dataMode === 'live') warns.unshift('正在直接读取 Steam 客户端好友列表：好友上线会自动显示在面板和上线动态里');
  if (!F.config?.hasApiKey && !F.config?.friendPastedSummaries && F.dataMode !== 'steam-client') warns.push('备用：也可以填 Steam Web API Key（steamcommunity.com/dev/apikey），关掉 Steam 客户端也能监控');
  if (!F.hasBaseline) warns.push('正在建立首个状态基线，好友下一次上线起开始记录上线事件');
  $('#friendWarnings').innerHTML = warns.map(w => `<span class="root-chip" style="color:var(--amber)">${esc(w)}</span>`).join('');
}

/* ------------------------------ 好友上线诊断 ------------------------------ */
async function loadFriendDiagnosis() {
  try { FDIAG = await api('/api/friends/diagnosis'); }
  catch { FDIAG = null; }
  renderFriendDiagnosis();
}
function renderFriendDiagnosis() {
  const box = $('#friendDiagBody'); if (!box) return;
  const tag = $('#friendDiagTag');
  if (!FDIAG) {
    if (tag) { tag.textContent = '离线（本机快照）'; tag.style.color = ''; }
    box.innerHTML = '<div class="diag-line">服务未连接：当前显示本机快照里的好友数据。服务恢复后会自动重新诊断并同步。</div>';
    return;
  }
  const d = FDIAG, ok = (d.sources || []).length > 0;
  if (tag) { tag.textContent = ok ? '状态源正常' : '缺少状态来源'; tag.style.color = ok ? 'var(--teal)' : 'var(--amber)'; }
  const sc = d.steamClientRaw || {};
  const rows = [
    `<div class="diag-line ${ok ? '' : 'error'}"><b>诊断</b>：${d.rootCause ? esc(d.rootCause) : '已接上：' + esc((d.sources || []).join(' + '))}</div>`,
    `<div class="diag-line"><b>当前模式</b>：${esc(d.dataModeLabel || '—')}${d.sourceNote ? ' · ' + esc(d.sourceNote) : ''}</div>`,
    `<div class="diag-line ${sc.connected ? '' : 'error'}"><b>Steam 客户端直读</b>：${sc.connected ? `已连接（本机端口 ${sc.port}）· 读到 ${sc.count} 位好友、${sc.online} 位在线 · ${sc.secondsAgo} 秒前同步 · 每 ${sc.pollIntervalSec} 秒自动刷新` : '未连接：' + esc(sc.error || '请在 Steam 客户端打开「好友与聊天」窗口')}</div>`,
    `<div class="diag-line"><b>后台轮询</b>：每 ${d.friendPollSec} 秒 · ${esc(d.poll?.result || '等待首次运行')} · 上线通知${d.friendNotify ? '已开启' : '已关闭'} · 退出 Steam 推送${d.friendNotifyOffline === false ? '已关闭' : '已开启'}</div>`,
    `<div class="diag-line"><b>好友与动态</b>：名册 ${d.totals?.friends ?? 0} 人 · 在线 ${d.totals?.online ?? 0} 人 · 游戏中 ${d.totals?.ingame ?? 0} 人 · 状态未知 ${d.totals?.unknown ?? 0} 人 · 累计事件 ${d.events ?? 0} 条 · ${d.hasBaseline ? '已有基线' : '正在建立基线'}</div>`,
    `<div class="diag-line"><b>退出 Steam 推送通道</b>：邮箱 ${d.offlinePush?.mail ? '开' : '关'} · 微信 ${d.offlinePush?.wechat ? '开' : '关'} · QQ ${d.offlinePush?.qq ? '开' : '关'} · 钉钉 ${d.offlinePush?.dingtalk ? '开' : '关'}</div>`
  ];
  if (!ok || !d.hasBaseline) {
    rows.push(`<div class="diag-line"><b>照着做</b>：<br>${(d.steps || []).map(s => `<span class="diag-step">${esc(s)}</span>`).join('')}</div>`);
  }
  box.innerHTML = rows.join('');
}

/* ------------------------------ Steam 账号页 ------------------------------ */
function renderAccount() {
  const connected = !!A?.connected;
  const prof = A?.profile;
  const nm = prof?.personaname || S.connection.account?.personaName || '尚未连接';
  $('#acctAvatar').innerHTML = prof?.avatarfull
    ? `<img src="${esc(prof.avatarfull)}" onerror="this.remove()">` : esc(String(nm).slice(0, 1).toUpperCase());
  $('#acctName').textContent = nm;
  $('#acctId').textContent = A?.steamId64 ? 'ID ' + A.steamId64 : '本机 Steam 账号';
  const pill = $('#acctStatus');
  pill.className = 'status-pill ' + (connected ? 'on' : '');
  pill.innerHTML = `<i></i>${connected ? '只读已连接' : '未连接'}`;
  $('#acctSyncTag').textContent = A?.lastSyncIso ? '同步于 ' + timeStr(A.lastSyncIso) : '尚未同步';
  $('#acctKpi').innerHTML =
    kpi('确认拥有', A?.ownedCount ?? 0, '款', 'Steam 官方接口返回', 'rgba(16,179,156,.16)', '✓') +
    kpi('愿望单', A?.wishlistCount ?? 0, '款', '未购买 · 不计价值', 'rgba(122,99,245,.16)', '♡') +
    kpi('已标记退款', A?.refundedCount ?? 0, '款', '不计价值', 'rgba(224,92,110,.16)', '↩');

  $('#steamExeInfo').textContent = SI?.found
    ? `已检测到 Steam 官方客户端：${SI.exe} · 本机登录账号 ${SI.accounts?.length || 0} 个`
    : '未检测到 steam.exe，可在「连接与配对」里手动指定 Steam 根目录';

  const warns = [...(A?.warnings || [])];
  if (S.totals.trialGames) warns.push(`已识别 ${S.totals.trialGames} 款 Demo / 试玩版，自动从库价值里剔除（不算购入）。`);
  if (!connected) warns.push('尚未连接：当前价值按本机记录统计，无法自动排除已退款与愿望单。填入只读 Key 或粘贴 JSON 即可开始。');
  $('#acctWarnings').innerHTML = warns.slice(0, 6).map(w => `<span class="root-chip" style="color:var(--amber)">${esc(w)}</span>`).join('');

  const rows = [
    ...(S.excluded || []).map(x => ({ ...x, priceCents: x.priceCents || 0, playtimeHours: x.playtimeHours || 0 })),
    ...(S.wishlist || []).map(w => ({
      appid: w.appid, name: w.name, ownership: 'wishlist', ownershipLabel: '愿望单',
      excludeReason: '仅在愿望单，未购买', priceCents: w.priceCents || 0, playtimeHours: 0
    }))
  ];
  $('#truthTable').innerHTML = rows.length ? rows.slice(0, 60).map(x => `<tr>
      <td><b>${esc(x.name)}</b><br><small class="mono">${esc(x.appid)}</small></td>
      <td><span class="cat-chip cat-${esc(x.ownership)}">${esc(x.ownershipLabel || x.ownership)}</span></td>
      <td>${x.playtimeHours} h</td>
      <td>${x.priceCents ? money(x.priceCents) : '—'}</td>
      <td><small>${esc(x.excludeReason || '—')}</small></td>
      <td>${x.ownership === 'refunded'
        ? `<button class="mini-btn" data-act="refund" data-id="${esc(x.appid)}" data-on="0">撤销退款</button>`
        : x.ownership === 'unverified'
          ? `<button class="mini-btn" data-act="refund" data-id="${esc(x.appid)}" data-on="1">确认已退款</button>
             <button class="mini-btn" data-act="reinstate" data-id="${esc(x.appid)}">恢复计入</button>`
          : ''}</td></tr>`).join('')
    : '<tr><td colspan="6"><div class="mini-empty">连接账号后，这里会列出已退款、愿望单和账号里已不存在的本地历史记录。</div></td></tr>';
  renderAccountLink();
}

function renderAccountLink() {
  if (!$('#accountLinkCard')) return;
  const st = ACCLINK || {};
  if ($('#accountLinkTag')) $('#accountLinkTag').textContent = st.steamLive ? 'Steam 客户端在线' : (st.configuredId ? '已自动连接' : '检测中');
  if ($('#accountAutoLink')) $('#accountAutoLink').checked = !!st.autoLinkEnabled;
  const d = st.detected || null;
  if ($('#detectedAccount')) {
    if (d && d.steamId64) {
      $('#detectedAccount').className = 'status-pill on';
      $('#detectedAccount').innerHTML = `<i></i>${esc(d.personaName || d.accountName || 'Steam ' + String(d.steamId64).slice(0, 8))} · ${esc(d.steamId64)}`;
      // 本机检测到的账号自动进保险库（不覆盖已存的 Key）
      if (!vaultHas(d.steamId64)) vaultUpsert({ steamId64: d.steamId64, personaName: d.personaName, accountName: d.accountName, avatar: d.avatar, detected: true, source: 'detected' }, { touch: false });
    } else {
      $('#detectedAccount').className = 'status-pill';
      $('#detectedAccount').innerHTML = '<i></i>未检测到本机登录账号';
    }
  }
  const inp = $('#acctSteamId');
  if (inp && d && d.steamId64 && !inp.value.trim()) inp.value = d.steamId64;
  const rows = (ACCLOGINS || []).slice(0, 30);
  if ($('#accountLogins')) {
    $('#accountLogins').innerHTML = rows.length ? rows.map(e => {
      const label = { login: '登录 Steam', logout: '退出 Steam', switch: '切换账号' }[e.type] || '变更';
      const who = e.personaName || e.accountName || ('Steam ' + String(e.steamId64 || '').slice(0, 8));
      const t = e.ts ? new Date(e.ts).toLocaleString('zh-CN', { hour12: false }) : '';
      return `<div class="mini-item"><div class="mi-main"><b>${esc(who)} ${esc(label)}</b><small>${esc(e.where || '本机')} · ${esc(t)}（精确到秒）</small></div><span class="mi-val">${esc(e.steamId64 || '')}</span></div>`;
    }).join('') : '<div class="mini-empty">还没有检测到登录 / 退出 / 切换事件。打开 Steam 客户端并登录后会自动记录。</div>';
  }
  renderVaultCard();
}

/** 账号保险库卡片（在「Steam 账号」页里展示已保存账号，可切换 / 移除） */
function renderVaultCard() {
  const box = $('#vaultList'); if (!box) return;
  const cnt = $('#vaultCount'); if (cnt) cnt.textContent = String(getVault().length);
  const cur = currentVaultId();
  const v = getVault().slice().sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  if (!v.length) {
    box.innerHTML = '<div class="mini-empty">还没有保存的账号。连接一个账号后会自动出现在这里。</div>';
    return;
  }
  box.innerHTML = v.map(a => {
    const isCur = String(a.steamId64) === String(cur);
    const who = a.note || a.personaName || a.accountName || 'Steam 账号';
    const av = a.avatar ? `<img src="${esc(a.avatar)}" onerror="this.remove()">` : esc(String(who).slice(0, 1).toUpperCase());
    return `<div class="mini-item">
      <div class="watch-ico" style="width:34px;height:34px;border-radius:10px">${av}</div>
      <div class="mi-main"><b>${esc(who)}${isCur ? ' · <span class="ac-cur">当前</span>' : ''}</b><small>${esc(a.steamId64 || '')}${a.connected ? ' · 已连' : ''}${a.familyToken ? ' · <span class="tag">可识别家庭</span>' : ''}</small></div>
      <div class="mi-actions">
        ${isCur ? '' : `<button class="btn primary tiny" data-switch="${esc(a.steamId64)}">切换</button>`}
        ${a.familyToken ? `<button class="link-btn" data-fam="${esc(a.steamId64)}">识别家庭</button>` : ''}
        <button class="link-btn" data-vault-del="${esc(a.steamId64)}">移除</button>
      </div>
    </div>`;
  }).join('');
}

async function loadAccountLink() {
  if (OFF && !OFF.online) {
    const snap = OFF.snapshot();
    ACCLINK = snap?.accountLink || null;
    ACCLOGINS = snap?.accountLogins || [];
    renderAccountLink();
    return;
  }
  try {
    ACCLINK = await api('/api/account/link').catch(() => null);
    const lg = await api('/api/account/logins').catch(() => null);
    ACCLOGINS = lg?.logins || [];
    renderAccountLink();
  } catch {}
}

function fillAccount() {
  if (!A) return;
  $('#acctSteamId').value = A.steamId64 || $('#acctSteamId').value || '';
  $('#acctApiKey').value = '';
  $('#acctApiKey').placeholder = A.apiKeySet ? '已保存只读 Key · 留空表示不修改' : '在 Steam 官网领取后粘贴到这里';
}

/* ------------------------------ 账号保险库（多账号保存 / 切换） ------------------------------
   把每个连接过 / 本机检测到的 Steam 账号存进本机缓存（localStorage），可一键切换。
   切换 = 用保险库里保存的 steamId64 + 只读 Key 重新连接该账号，再 reload。 */
const VAULT_KEY = 'SL_ACCOUNTS';
function getVault() {
  try { const v = JSON.parse(localStorage.getItem(VAULT_KEY) || '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
function saveVault(v) { try { localStorage.setItem(VAULT_KEY, JSON.stringify(v)); } catch {} }
function vaultHas(id) { return getVault().some(a => String(a.steamId64) === String(id)); }
function vaultUpsert(rec, opts) {
  opts = opts || {};
  const v = getVault();
  const i = v.findIndex(a => String(a.steamId64) === String(rec.steamId64));
  const base = i >= 0 ? v[i] : {};
  const merged = Object.assign(base, rec);
  if (i >= 0) v[i] = merged; else v.push(merged);
  if (!base.savedAt) merged.savedAt = Date.now();
  if (opts.touch !== false) merged.lastUsed = Date.now();
  saveVault(v);
  renderAccountSwitchPop();
  return merged;
}
function vaultRemove(id) {
  saveVault(getVault().filter(a => String(a.steamId64) !== String(id)));
  renderAccountSwitchPop();
}
function currentVaultId() {
  return (A && A.steamId64) || (S && S.connection && S.connection.account && S.connection.account.steamId64) || '';
}
function renderAccountSwitchPop() {
  const pop = $('#accountSwitchPop'); if (!pop) return;
  const list = $('#accountPopList'); if (!list) return;
  const cur = currentVaultId();
  const v = getVault().slice().sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  if (!v.length) {
    list.innerHTML = '<div class="mini-empty">还没有保存的账号。去「Steam 账号」页连接一个，或点下面的「把当前账号加入保险库」。</div>';
  } else {
    list.innerHTML = v.map(a => {
      const isCur = String(a.steamId64) === String(cur);
      const who = a.personaName || a.accountName || 'Steam 账号';
      const av = a.avatar ? `<img src="${esc(a.avatar)}" onerror="this.remove()">` : esc(String(who).slice(0, 1).toUpperCase());
      return `<div class="ac-row ${isCur ? 'on' : ''}">
        <div class="ac-av">${av}</div>
        <div class="ac-info"><b>${esc(who)}</b><small>${esc(a.steamId64 || '')}</small></div>
        <div class="ac-act">
          ${isCur ? '<span class="ac-cur">当前</span>' : `<button class="btn primary tiny" data-switch="${esc(a.steamId64)}">切换</button>`}
          <button class="link-btn" data-vault-del="${esc(a.steamId64)}" title="从保险库移除">移除</button>
        </div>
      </div>`;
    }).join('');
  }
  const btn = $('#btnAddCurrentToVault');
  if (btn) btn.hidden = !cur || vaultHas(cur);
}
async function switchAccount(steamId64) {
  const rec = getVault().find(a => String(a.steamId64) === String(steamId64));
  if (!rec) { toast('该账号不在保险库里'); return; }
  toast('正在切换到 ' + (rec.personaName || rec.steamId64) + ' …');
  if (OFF && !OFF.online) { toast('离线版无法直接切换：需用在线版重新拉取该账号的库'); renderAccountSwitchPop(); return; }
  try {
    await post('/api/account/connect', { steamId64: rec.steamId64, apiKey: rec.apiKey || '' });
    await load(true);
    vaultUpsert({ steamId64: rec.steamId64, personaName: rec.personaName, accountName: rec.accountName, avatar: rec.avatar, apiKey: rec.apiKey, connected: true, source: 'switch' });
    if (rec.familyToken) { try { await post('/api/family/config', { accessToken: rec.familyToken }); } catch {} }
    toast('已切换到 ' + (rec.personaName || rec.steamId64));
  } catch (e) {
    toast('切换失败：' + (e.message || '该账号的只读 Key 可能已失效，请到「Steam 账号」页重新连接'));
  }
  renderAccountSwitchPop();
}
function addCurrentToVault() {
  const id = currentVaultId();
  if (!id) { toast('当前没有已连接的账号，先去「Steam 账号」页连接一个'); return; }
  const keyInput = $('#acctApiKey');
  const key = (keyInput && keyInput.value.trim()) || '';
  vaultUpsert({
    steamId64: id,
    personaName: (A && A.profile && A.profile.personaname) || (S && S.connection && S.connection.account && S.connection.account.personaName) || '',
    accountName: (S && S.connection && S.connection.account && S.connection.account.accountName) || '',
    avatar: (A && A.profile && A.profile.avatarfull) || '',
    apiKey: key,
    connected: !!(A && A.connected),
    ownedCount: A && A.ownedCount, wishlistCount: A && A.wishlistCount, lastSyncIso: A && A.lastSyncIso,
    source: 'manual'
  });
  toast('已将当前账号加入保险库' + (key ? '（含只读 Key，可直接切换）' : '（未填 Key，切换时需重新连接）'));
}

function createAccount() {
  const box = $('#createAccountBox'); if (!box) return;
  const note = $('#caNote').value.trim();
  const sid = $('#caSteamId').value.trim();
  const key = $('#caApiKey').value.trim();
  const fam = $('#caFamToken').value.trim();
  const setCur = $('#caSetCurrent') && $('#caSetCurrent').checked;
  const msg = $('#caMsg');
  if (!/^7656\d{13}$/.test(sid)) { if (msg) { msg.textContent = 'SteamID64 格式不对（应为 17 位、以 7656 开头）'; msg.className = 'tag warn'; } return; }
  vaultUpsert({ steamId64: sid, note: note, apiKey: key, familyToken: fam, connected: false, source: 'created', createdAt: Date.now() }, { touch: false });
  if (msg) { msg.textContent = '已创建并保存到保险库'; msg.className = 'muted'; }
  $('#caNote').value = ''; $('#caSteamId').value = ''; $('#caApiKey').value = ''; $('#caFamToken').value = '';
  renderVaultCard();
  if (setCur) { switchAccount(sid); }
  else toast('已创建新账号：' + (note || sid));
}

/* 发现本机 Steam 账号：列出 loginusers.vdf 里的账号，一键添加进保险库（自动提取 SteamID64） */
$('#btnDiscoverAccounts')?.addEventListener('click', async () => {
  const panel = $('#discoveredAccounts'); if (!panel) return;
  panel.hidden = !panel.hidden;
  if (panel.hidden) return;
  const list = $('#discoveredList');
  list.innerHTML = '<div class="mini-empty">正在检测本机 Steam 账号…</div>';
  try {
    const d = await api('/api/account/detect');
    const accs = (d && d.accounts) || [];
    if (!accs.length) { list.innerHTML = '<div class="mini-empty">没有检测到本机 Steam 账号。确认 Steam 客户端已登录过至少一个账号。</div>'; return; }
    list.innerHTML = accs.map(a => `<div class="mini-item">
      <div class="watch-ico" style="width:34px;height:34px;border-radius:10px">${esc(String((a.personaName || a.accountName || a.steamId64).slice(0, 1).toUpperCase()))}</div>
      <div class="mi-main"><b>${esc(a.personaName || a.accountName || ('Steam ' + String(a.steamId64).slice(0, 8)))}${a.current ? ' · <span class="ac-cur">当前</span>' : ''}</b><small>${esc(a.steamId64)}</small></div>
      <div class="mi-actions"><button class="btn primary tiny" data-add-acc="${esc(a.steamId64)}" data-name="${esc(a.personaName || a.accountName || '')}">添加</button></div>
    </div>`).join('');
  } catch (e) { list.innerHTML = '<div class="mini-empty">发现失败：' + esc(e.message) + '</div>'; }
});
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-add-acc]');
  if (b) {
    const sid = b.getAttribute('data-add-acc');
    const name = b.getAttribute('data-name') || '';
    if (!vaultHas(sid)) vaultUpsert({ steamId64: sid, note: name, personaName: name, connected: false, source: 'discovered', discoveredAt: Date.now() }, { touch: false });
    renderVaultCard();
    toast('已添加账号：' + (name || sid) + '（SteamID64 已提取）');
  }
});

async function recognizeFamily(steamId64) {
  const rec = getVault().find(a => String(a.steamId64) === String(steamId64));
  if (!rec) { toast('该账号不在保险库'); return; }
  if (!rec.familyToken) { toast('该账号没有家庭访问令牌：请在「创建新账号」里填入它的 webapi_token，或用「识别家庭」页手动粘贴'); return; }
  if (OFF && !OFF.online) { toast('离线版无法识别家庭'); return; }
  try {
    await post('/api/family/config', { accessToken: rec.familyToken });
    try { await post('/api/account/connect', { steamId64: rec.steamId64, apiKey: rec.apiKey || '' }); } catch {}
    toast('已载入「' + (rec.note || rec.personaName || rec.steamId64) + '」的家庭令牌，去「识别家庭」点扫描');
    go('family');
  } catch (e) { toast('设置失败：' + (e.message || e)); }
}

function toggleAccountSwitchPop() {
  const pop = $('#accountSwitchPop'); if (!pop) return;
  const card = $('#accountCard');
  if (pop.hidden) { renderAccountSwitchPop(); pop.hidden = false; positionAccountPop(); if (card) card.setAttribute('aria-expanded', 'true'); }
  else { pop.hidden = true; if (card) card.setAttribute('aria-expanded', 'false'); }
}
function hideAccountSwitchPop() { const pop = $('#accountSwitchPop'); if (pop) pop.hidden = true; const c = $('#accountCard'); if (c) c.setAttribute('aria-expanded', 'false'); }
function positionAccountPop() {
  const pop = $('#accountSwitchPop'); const card = $('#accountCard'); if (!pop || !card) return;
  const r = card.getBoundingClientRect();
  pop.style.top = (r.bottom + 8) + 'px';
  pop.style.left = Math.max(8, r.left) + 'px';
}
function bindAccountSwitch() {
  const card = $('#accountCard');
  if (card) card.addEventListener('click', (e) => {
    if (e.target.closest('[data-switch],[data-vault-del],[data-act]')) return;
    toggleAccountSwitchPop();
  });
  document.addEventListener('click', (e) => {
    const sw = e.target.closest('[data-switch]');
    if (sw) { switchAccount(sw.getAttribute('data-switch')); hideAccountSwitchPop(); return; }
    const del = e.target.closest('[data-vault-del]');
    if (del) { vaultRemove(del.getAttribute('data-vault-del')); return; }
    if (e.target.closest('#btnAddCurrentToVault') || e.target.closest('#btnVaultAdd')) { addCurrentToVault(); return; }
    const fam = e.target.closest('[data-fam]');
    if (fam) { recognizeFamily(fam.getAttribute('data-fam')); return; }
    if (e.target.closest('#btnCreateAccount')) { const b = $('#createAccountBox'); if (b) b.hidden = !b.hidden; return; }
    if (e.target.closest('#btnCaCancel')) { const b = $('#createAccountBox'); if (b) b.hidden = true; return; }
    if (e.target.closest('#btnCaSave')) { createAccount(); return; }
    if (!e.target.closest('#accountSwitchPop') && !e.target.closest('#accountCard') && !e.target.closest('#createAccountBox')) hideAccountSwitchPop();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideAccountSwitchPop(); });
  window.addEventListener('resize', () => { const p = $('#accountSwitchPop'); if (p && !p.hidden) positionAccountPop(); });
}

/* ------------------------------ 通知与邮箱页 ------------------------------ */
function fillNotify() {
  const c = N?.config || {};
  $('#nDesktop').checked = c.desktop !== false;
  $('#nSound').checked = !!c.sound;
  $('#nEnabled').checked = c.enabled !== false;
  if ($('#nOfflineEnabled')) $('#nOfflineEnabled').checked = c.offlineEnabled !== false;
  $('#nScope').value = c.scope || 'all';
  $('#nMinInterval').value = c.minIntervalSec || 300;
  $('#nWebhook').value = c.webhookUrl || '';
  $('#nWebhookType').value = c.webhookType || 'auto';
  if (MAIL) {
    $('#mailUser').value = MAIL.user || '';
    $('#mailTo').value = MAIL.to || '';
    $('#mailAuthCode').value = '';
    $('#mailAuthCode').placeholder = MAIL.authCodeValid
      ? '已保存 16 位授权码 · 留空表示不修改'
      : '请重新粘贴完整的 16 位 SMTP 授权码';
    if ($('#mOnOnline')) $('#mOnOnline').checked = MAIL.onOnline !== false;
    if ($('#mOnOffline')) $('#mOnOffline').checked = MAIL.onOffline !== false;
  }
  if (W) {
    $('#wThreshold').value = W.thresholdYuan || 30;
    $('#wEnabled').checked = W.enabled !== false;
    $('#wCheckHours').value = AR?.config?.wishlistCheckHours || 6;
  }
}

function renderNotify() {
  const c = N?.config || {};
  const off = c.offlineEnabled !== false;
  $('#notifyTag').textContent = c.enabled === false
    ? '已关闭'
    : `上线${off ? ' + 退出' : ''} · ${c.scope === 'starred' ? '仅关注好友' : '所有好友'}`;
  const hist = N?.history || [];
  $('#notifyHistory').innerHTML = hist.length ? hist.slice(0, 8).map(x => {
    const kind = x.type === 'offline' ? '退出 Steam' : (x.type === 'online' ? '上线' : '通知');
    return `<div class="mini-item">
      <div class="mi-main"><b><span class="tag" style="margin-right:6px">${kind}</span>${esc(x.body || x.title)}</b><small>${timeStr(x.iso)} · 弹窗 ${x.channels?.desktop?.ok ? '✓' : '—'} · 邮箱 ${x.channels?.mail?.sent ? '✓' : '—'}</small></div></div>`;
  }).join('')
    : '<div class="mini-empty">还没有通知记录。好友上线或退出 Steam 时会自动出现在这里。</div>';

  const issue = MAIL?.authCodeIssue || '';
  const connected = !!MAIL?.connected && !issue;
  const badge = $('#mailStatusBadge');
  badge.className = 'status-pill ' + (connected ? 'on' : '');
  badge.innerHTML = `<i></i>${connected ? '已登录 · 永久保持' : (issue ? '授权码有误' : '未登录')}`;
  $('#mailHint').textContent = connected
    ? `已登录 ${MAIL.user} → 收件人 ${MAIL.to}。授权码长期保存在本机，服务重启自动恢复。`
    : (issue || '凭证保存在本机 config.json，长期有效、服务重启自动恢复 = 永久登录。');
  const diag = $('#mailDiagnosis');
  if (diag) {
    const lastFail = (MAIL?.history || []).find(x => x.ok === false);
    diag.innerHTML = (issue
      ? `<div class="diag-line error"><b>发不出去的原因</b>：${esc(issue)}</div>`
        + '<div class="diag-line">QQ 邮箱 →「设置 → 账号 → 安全设置」开启 IMAP/SMTP 服务 → 生成 <b>16 位授权码</b>（不是 QQ 密码）→ 完整粘贴到上面 → 点「登录 QQ 邮箱」。</div>'
      : '<div class="diag-line ok">授权码格式正确，点「发送测试邮件」可验证送达。</div>')
      + (lastFail ? `<div class="diag-line error">上次发送失败：${esc(lastFail.reason || '未知原因')}</div>` : '');
  }

  $('#wishTag').textContent = W
    ? (W.enabled === false ? '已关闭' : `跌破 ¥${W.thresholdYuan} 提醒`) + (W.mutedCount ? ` · ${W.mutedCount} 款不再提醒` : '')
    : '—';
  const items = W?.items || [];
  $('#wishlistStatus').innerHTML = items.length ? items.slice(0, 20).map(x => `<div class="mini-item${x.muted ? ' is-muted' : ''}">
      <div class="mi-main"><b>${esc(x.name)}${x.muted ? '<span class="muted-tag">已静音 · 不再提醒</span>' : ''}</b><small>${x.below ? '已低于提醒线' : '在提醒线以上'} · 上次 ¥${(x.lastFinalCents / 100).toFixed(2)}${x.lastDiscount ? ' (-' + x.lastDiscount + '%)' : ''}</small></div>
      <span class="mi-val ${x.below ? 'up' : ''}">¥${(x.lastFinalCents / 100).toFixed(2)}</span>
      <button class="wish-x ${x.muted ? 'is-restore' : ''}" data-wish-mute="${esc(x.appid)}" data-wish-on="${x.muted ? '1' : '0'}" data-wish-name="${esc(x.name)}" title="${x.muted ? '重新开启这款游戏的降价/回涨提醒' : '不再提醒这款游戏，并删掉它的提醒记录'}">${x.muted ? '↺ 恢复' : '✕ 不再提醒'}</button></div>`).join('')
    : '<div class="mini-empty">还没有价格基线。导入愿望单后点「立即检查价格」建立基线（首次不发邮件）。</div>';

  const labels = { value: '库价值', library: '账号真实库', wishlist: '愿望单价格', friends: '好友状态' };
  const jobs = AR?.jobs || {};
  $('#autoRefreshList').innerHTML = Object.keys(labels).map(k => {
    const j = jobs[k] || {};
    return `<div class="mini-item"><span class="rb-dot ${j.running ? 'busy' : ''}"></span>
      <div class="mi-main"><b>${labels[k]}</b><small>${esc(j.result || '等待运行')} · 上次 ${j.lastAt ? timeStr(new Date(j.lastAt).toISOString()) : '—'}${j.nextAt ? ' · 下次 ' + timeStr(new Date(j.nextAt).toISOString()) : ''}</small></div>
      <span class="mi-val">${j.running ? '进行中' : '自动'}</span></div>`;
  }).join('');

  const alerts = W?.alerts || [];
  $('#alertTag').textContent = alerts.length + ' 条';
  $('#wishlistAlerts').innerHTML = alerts.length ? alerts.slice(0, 20).map(x => `<div class="mini-item">
      <div class="mi-main"><b>${esc(x.name)} · ${x.kind === 'drop' ? '跌破提醒线' : '涨回提醒线'}</b>
      <small>${timeStr(x.iso)} · ¥${(x.fromCents / 100).toFixed(2)} → ¥${(x.toCents / 100).toFixed(2)}${x.discount ? ' (-' + x.discount + '%)' : ''} · 邮件 ${x.mail?.sent ? '已发送' : (x.mail?.reason || '未启用')}</small></div>
      <span class="mi-val ${x.kind === 'drop' ? 'down' : 'up'}">¥${(x.toCents / 100).toFixed(2)}</span>
      <button class="wish-x" data-wish-alert-del="${esc(x.ts)}" title="删除这一条提醒记录">✕</button></div>`).join('')
    : '<div class="mini-empty">暂无提醒。只有价格跨过提醒线才会记录并发邮件。</div>';
}

/* ------------------------------ 手机号通知（短信） ------------------------------ */
function renderSms() {
  const st = SMS || {};
  const offMode = DEMO || (OFF && OFF.online === false);
  const badge = $('#smsStatusBadge');
  if (badge) {
    const on = !!st.configured && st.enabled !== false;
    badge.className = 'status-pill ' + (on ? 'on' : '');
    badge.innerHTML = `<i></i>${on ? '已配置 · 短信开启' : (st.configured ? '已配置 · 已关闭' : '未配置')}`;
  }
  const ph = $('#smsPhone'), wh = $('#smsWebhook'), tk = $('#smsToken');
  if (ph) ph.placeholder = st.phoneMasked ? `已保存 ${st.phoneMasked} · 留空不修改` : '例如 13800138000';
  if (wh) wh.placeholder = st.webhookSet ? '已保存网关地址 · 留空不修改' : 'https://… 接收 POST JSON';
  if (tk) tk.placeholder = '网关要求校验才填；只存本机';
  if ($('#smsEnabled')) $('#smsEnabled').checked = st.enabled !== false;
  if ($('#smsOnCount')) $('#smsOnCount').textContent = `${st.onCount ?? 0} / ${st.totalEvents ?? 0} 类开启 · 累计约 ${st.estimatedSms ?? 0} 条短信`;
  const evs = st.eventList || [];
  /* 大类开关：好友通知 / 愿望单通知，一次切换这一类下面的全部类别 */
  const groups = [...new Set(evs.map(e => e.group || '其他'))];
  if ($('#smsGroups')) $('#smsGroups').innerHTML = groups.length ? groups.map(g => {
    const ids = evs.filter(e => (e.group || '其他') === g).map(e => e.id);
    const allOn = ids.every(id => st.events?.[id] !== false);
    return `<label class="switch"><input type="checkbox" data-sms-group="${esc(g)}" ${allOn ? 'checked' : ''} ${offMode ? 'disabled' : ''}><span></span><b>${esc(g)}通知（${ids.length} 类）</b></label>`;
  }).join('') : '';
  if ($('#smsSwitches')) $('#smsSwitches').innerHTML = evs.length ? evs.map(e => `
    <label class="switch"><input type="checkbox" data-sms-event="${esc(e.id)}" ${st.events?.[e.id] !== false ? 'checked' : ''} ${offMode ? 'disabled' : ''}><span></span><b>${esc(e.label)}</b></label>`).join('')
    : '<div class="mini-empty">等待读取短信开关…</div>';
  const hist = st.history || [];
  if ($('#smsHistoryTag')) $('#smsHistoryTag').textContent = hist.length + ' 条';
  if ($('#smsHistory')) $('#smsHistory').innerHTML = hist.length ? hist.map(h => `
    <div class="mini-item"><div class="mi-main"><b>${esc(h.label || h.event)} · ${h.ok ? '已发送' : '未发送'}</b>
      <small>${esc(String(h.iso || '').replace('T', ' ').slice(0, 19))} · ${esc(h.phoneMasked || '')} · 约 ${h.smsCount || 1} 条短信${h.reason ? ' · ' + esc(h.reason) : ''}</small></div>
      <span class="mi-val ${h.ok ? 'up' : ''}">${h.ok ? '✓' : '—'}</span></div>`).join('')
    : '<div class="mini-empty">还没有短信记录。关掉的类别不会发送，也不会计入费用。</div>';
}
$('#btnSmsSave')?.addEventListener('click', async () => {
  if (DEMO || (OFF && OFF.online === false)) { toast('离线版不能修改短信设置'); return; }
  const body = {};
  const p = String($('#smsPhone')?.value || '').trim();
  const w = String($('#smsWebhook')?.value || '').trim();
  const t = String($('#smsToken')?.value || '').trim();
  if (p) body.phone = p;
  if (w) body.webhook = w;
  if (t) body.token = t;
  try {
    const r = await post('/api/sms/config', body);
    if (!r.ok) { toast('保存失败：' + (r.error || '未知错误')); return; }
    SMS = r.status;
    if ($('#smsPhone')) $('#smsPhone').value = '';
    if ($('#smsWebhook')) $('#smsWebhook').value = '';
    if ($('#smsToken')) $('#smsToken').value = '';
    renderSms(); toast('手机号与短信网关已保存到本机');
  } catch (e) { toast('保存失败：' + e.message); }
});
$('#smsEnabled')?.addEventListener('change', async () => {
  if (DEMO || (OFF && OFF.online === false)) return;
  try {
    const on = $('#smsEnabled').checked;
    const r = await post('/api/sms/config', { enabled: on });
    SMS = r.status; renderSms(); toast(on ? '短信总开关已开启' : '短信总开关已关闭：不会再发任何短信');
  } catch (e) { toast('失败：' + e.message); }
});
$('#smsGroups')?.addEventListener('change', async e => {
  const el = e.target.closest('[data-sms-group]'); if (!el) return;
  if (DEMO || (OFF && OFF.online === false)) { toast('离线版不能修改短信设置'); return; }
  const g = el.getAttribute('data-sms-group');
  const ids = (SMS?.eventList || []).filter(x => (x.group || '其他') === g).map(x => x.id);
  try {
    let last = null;
    for (const id of ids) {
      const r = await post('/api/sms/toggle', { event: id, enabled: el.checked });
      if (r.status) last = r.status;
    }
    if (last) SMS = last;
    renderSms();
    toast(el.checked ? `已开启「${g}」全部短信通知` : `已关闭「${g}」全部短信通知（省短信费）`);
  } catch (err) { toast('失败：' + err.message); }
});
$('#smsSwitches')?.addEventListener('change', async e => {
  const el = e.target.closest('[data-sms-event]'); if (!el) return;
  if (DEMO || (OFF && OFF.online === false)) { toast('离线版不能修改短信设置'); return; }
  try {
    const r = await post('/api/sms/toggle', { event: el.getAttribute('data-sms-event'), enabled: el.checked });
    if (r.status) SMS = r.status;
    renderSms(); toast(el.checked ? '已开启这类短信通知' : '已关闭这类短信通知（不再产生短信费）');
  } catch (err) { toast('失败：' + err.message); }
});
$('#btnSmsAllOff')?.addEventListener('click', async () => {
  if (DEMO || (OFF && OFF.online === false)) { toast('离线版不能修改短信设置'); return; }
  const r = await post('/api/sms/all', { enabled: false });
  if (r.status) SMS = r.status;
  renderSms(); toast('已一键关闭全部短信通知：一条都不会发');
});
$('#btnSmsAllOn')?.addEventListener('click', async () => {
  if (DEMO || (OFF && OFF.online === false)) { toast('离线版不能修改短信设置'); return; }
  const r = await post('/api/sms/all', { enabled: true });
  if (r.status) SMS = r.status;
  renderSms(); toast('已一键开启全部短信通知');
});
$('#btnSmsTest')?.addEventListener('click', async () => {
  if (DEMO || (OFF && OFF.online === false)) { toast('离线版不能发测试短信'); return; }
  try {
    const r = await post('/api/sms/test', {});
    if (r.status) SMS = r.status;
    renderSms(); toast(r.ok ? '测试短信已发出' : ('未发出：' + (r.reason || '请检查手机号与网关')));
  } catch (e) { toast('失败：' + e.message); }
});
/* 愿望单：✕ 不再提醒 / ✕ 删除单条提醒记录 */
document.addEventListener('click', async (e) => {
  const offMode = DEMO || (OFF && OFF.online === false);
  const muteBtn = e.target.closest('[data-wish-mute]');
  if (muteBtn) {
    if (offMode) { toast('离线版不能修改提醒设置'); return; }
    const turnOn = muteBtn.getAttribute('data-wish-on') === '1';
    const name = muteBtn.getAttribute('data-wish-name') || '';
    try {
      const r = await post('/api/wishlist/mute', { appid: muteBtn.getAttribute('data-wish-mute'), muted: !turnOn });
      if (r.status) W = r.status;
      renderNotify();
      toast(turnOn ? `已恢复《${name}》的降价/回涨提醒` : `《${name}》不再提醒，已删掉它的提醒记录`);
    } catch (err) { toast('失败：' + err.message); }
    return;
  }
  const delBtn = e.target.closest('[data-wish-alert-del]');
  if (delBtn) {
    if (offMode) { toast('离线版不能删除提醒记录'); return; }
    try {
      const r = await post('/api/wishlist/alert-delete', { ts: delBtn.getAttribute('data-wish-alert-del') });
      if (r.status) W = r.status;
      renderNotify(); toast('已删除这条提醒');
    } catch (err) { toast('失败：' + err.message); }
  }
});

/* ------------------------------ 个性化 · 动态壁纸 ------------------------------ */
let WP_LOOKUP = null, WP_APPLIED_KEY = '', WP_UI_DRAG = false;
function wpOffline() { return DEMO || (OFF && OFF.online === false); }
/* 离线版自己存的壁纸偏好：选中的款、透明度、音量、删除记录，刷新后仍然生效 */
const WP_LOCAL_KEY = 'sl-offline-wallpaper-config';
function wpLocalConfig() { try { return JSON.parse(localStorage.getItem(WP_LOCAL_KEY) || 'null'); } catch { return null; } }
function wpSaveLocalConfig(c) { try { localStorage.setItem(WP_LOCAL_KEY, JSON.stringify(c)); } catch {} }
/* 离线壁纸资源基址：单文件版指向同目录的「SteamLens-离线版/」，壁纸包内版为空 */
const SL_WP_BASE = window.SL_WP_BASE || '';
function wpKeyOf(it) {
  const a = String(it.id || '').replace(/[^0-9A-Za-z_-]/g, '_').slice(0, 60);
  const b = String(it.src || 'local').replace(/[^0-9A-Za-z_-]/g, '_').slice(0, 20);
  return a + '_' + b;
}
function wpMediaMap() {
  const a = (OFF && OFF.snapshot) ? OFF.snapshot() : null;
  const b = window.SL_OFFLINE_DATA || null;
  return {
    media: (a && a.wallpaperMedia) || (b && b.wallpaperMedia) || null,
    inline: (a && a.wallpaperInline) || (b && b.wallpaperInline) || null,
    pack: (a && a.wallpaperPack) || (b && b.wallpaperPack) || null
  };
}
/* 优先级：内联 data URL（单文件自带）→ 离线包相对路径 → 本机小红车绝对路径 */
function wpOfflineUrl(it, which) {
  if (!wpOffline()) return '';
  const m = wpMediaMap(), key = wpKeyOf(it);
  const inl = m.inline && m.inline[key];
  if (inl && inl[which]) return inl[which];
  const e = m.media && m.media[key];
  const p = e && e[which];
  if (!p) return '';
  return /^data:/i.test(p) ? p : (SL_WP_BASE + p);
}
function wpFileUrl(it, f) {
  if (!f) return '';
  if (!wpOffline()) return '';
  /* 中文 / 空格文件名必须编码，否则离线版会加载失败、只剩模糊预览图 */
  return 'file:///' + encodeURI(String(it.dir || '').replace(/\\/g, '/').replace(/\/+$/, '') + '/' + f);
}
/* 离线版优先用「完整媒体」：打包相对路径 → 本机原始完整文件 → 最后才退到预览图。
   之前的顺序把打包预览图排在本机完整视频前面，导致明明有完整视频却显示一张糊图。 */
function wpFallbackPreview(it) {
  return wpOfflineUrl(it, 'preview') || wpFileUrl(it, it.preview);
}
function wpPreviewUrl(it) {
  if (wpOffline()) return wpOfflineUrl(it, 'preview') || wpOfflineUrl(it, 'media') || wpFileUrl(it, it.preview || it.file);
  return `/api/wallpaper/preview?id=${encodeURIComponent(it.id)}&src=${encodeURIComponent(it.src)}`;
}
function wpMediaSrc(it) {
  /* 自定义网页壁纸：src==='url' 时 file 就是网址本身，直接用，不受离线/在线影响 */
  if (it.src === 'url') return it.file || '';
  if (wpOffline()) return wpOfflineUrl(it, 'media')
    || wpFileUrl(it, it.file)
    || wpFallbackPreview(it);
  const f = it.file || it.preview;
  if (!f) return '';
  if (it.kind === 'web') return `/api/wallpaper/html/${encodeURIComponent(it.id)}/${it.src}/${encodeURIComponent(f)}`;
  return `/api/wallpaper/media?id=${encodeURIComponent(it.id)}&src=${encodeURIComponent(it.src)}`;
}
function wpKindLabel(k) {
  return ({ video: '▶ 视频', web: '🌐 网页', image: '🖼 图片', scene: '⤓ Scene', other: '◌ 其他' })[k] || k;
}
/* 自定义网页壁纸（用户直接贴的网址 / 本地 HTML）：存在配置里，渲染时合成一条虚拟条目 */
function customWebItem() {
  const u = (WP?.config && WP.config.customUrl) || '';
  if (!u) return null;
  return { id: 'custom-web', src: 'url', kind: 'web', title: '自定义网页壁纸', type: 'web',
    file: u, playable: true, preview: '', previewOk: false, dir: '', reason: '' };
}
/* 把自定义网页壁纸并入当前列表，供渲染与查找使用 */
function wpEffectiveItems() {
  const items = (WP?.items || []).slice();
  const ci = customWebItem();
  if (ci && !items.some(x => x.id === 'custom-web' && x.src === 'url')) items.push(ci);
  return items;
}
function wpCardHtml(it) {
  const c = WP?.config || {};
  const active = c.enabled && c.id === it.id && c.src === it.src;
  const id = esc(String(it.id)), src = esc(it.src);
  const shop = `https://steamcommunity.com/sharedfiles/filedetails/?id=${encodeURIComponent(it.id)}`;
  const note = it.reason || (it.subscriptions ? `订阅 ${it.subscriptions} · ${it.author || 'Steam 创意工坊'}` : '');
  return `<div class="wp-card${active ? ' is-active' : ''}">
    <div class="wp-thumb-wrap">
      <img class="wp-thumb" src="${esc(wpPreviewUrl(it))}" loading="lazy" alt="" onerror="this.style.opacity=.2" data-wp-pick="${id}" data-wp-src="${src}">
      <span class="wp-kind ${it.kind === 'scene' ? 'scene' : ''}">${wpKindLabel(it.kind)}</span>
    </div>
    <div class="wp-body">
      <b title="${esc(it.title)}">${esc(it.title)}</b>
      <small>ID ${id} · ${esc(it.type || it.kind)} · ${Number(it.sizeMB || 0)} MB${note ? ' · ' + esc(note) : ''}</small>
      <div class="wp-actions">
        <button class="btn primary tiny" data-wp-pick="${id}" data-wp-src="${src}">${active ? '✓ 正在使用' : '设为壁纸'}</button>
        <a class="btn ghost tiny" href="${esc(shop)}" target="_blank" rel="noopener noreferrer">↗ 工坊页</a>
        <button class="btn ghost tiny" data-wp-hide="${id}" data-wp-hide-src="${src}">🗑 从软件删除</button>
      </div>
    </div></div>`;
}
function renderWorkshopResult() {
  const el = $('#wpWorkshopResult'); if (!el) return;
  if (!WP_LOOKUP) { el.innerHTML = '<div class="mini-empty">还没查询。粘贴工坊链接或 ID，点「读取工坊信息」。</div>'; return; }
  if (!WP_LOOKUP.ok) { el.innerHTML = `<div class="mini-empty">查询失败：${esc(WP_LOOKUP.error || '未知错误')}</div>`; return; }
  const d = (WP_LOOKUP.items || [])[0];
  if (!d) { el.innerHTML = '<div class="mini-empty">Steam 没找到这个物品（可能已下架或设为私密）。</div>'; return; }
  const canBody = !!d.fileUrl;
  el.innerHTML = `<div class="mini-item">
    <div class="mi-main"><b>${esc(d.title)}</b>
      <small>ID ${esc(d.id)} · 订阅 ${Number(d.subscriptions || 0)} · 浏览 ${Number(d.views || 0)} · 作者 ${esc(d.author || '—')}</small>
      <small>${canBody ? '✓ Steam 提供了本体下载链接，可以完整下载到软件' : '⚠ Steam 未开放本体下载（file_url 为空），只能下载预览图；完整壁纸请在 Steam 里订阅后重新扫描'}</small></div>
    ${d.previewUrl ? `<img src="${esc(d.previewUrl)}" alt="工坊预览" style="width:120px;height:68px;object-fit:cover;border-radius:8px" onerror="this.remove()">` : ''}
  </div>`;
}
function renderWallpaper() {
  const st = WP || {};
  const c = st.config || {};
  const items = wpEffectiveItems();
  const local = items.filter(x => x.src === 'local');
  const downloaded = items.filter(x => x.src === 'workshop');
  if ($('#wpStatusTag')) $('#wpStatusTag').textContent = `${items.length} 款 · ${st.playableCount || 0} 款可播放`;
  if ($('#navWallpaper')) $('#navWallpaper').textContent = String(items.length || '—');
  if ($('#wpLocalTag')) $('#wpLocalTag').textContent = local.length + ' 款';
  if ($('#wpDownloadedTag')) $('#wpDownloadedTag').textContent = downloaded.length + ' 款';
  if ($('#wpEnabled')) $('#wpEnabled').checked = !!c.enabled;
  if ($('#wpCrisp')) $('#wpCrisp').checked = c.crisp !== false;
  for (const [id, v] of [['wpUi', c.ui === undefined ? 16 : c.ui], ['wpDim', c.dim], ['wpBlur', c.blur], ['wpVolume', c.volume]]) {
    if (id === 'wpUi' && WP_UI_DRAG) continue;   // 拖动时别被每秒刷新抢走滑块
    const el = $('#' + id); if (el && v !== undefined) el.value = String(v);
  }
  if ($('#wpFit')) $('#wpFit').value = c.fit === 'contain' ? 'contain' : 'cover';
  if ($('#wpCurrent')) $('#wpCurrent').textContent = c.enabled && st.current
    ? `当前壁纸：${st.current.title}（${wpKindLabel(st.current.kind)}）· ID ${st.current.id}`
    : '当前：未启用。选一款壁纸就会变成软件背景。';
  if ($('#wpPathHint')) $('#wpPathHint').textContent = (st.dirs || []).length
    ? `扫描到的小红车目录：${st.dirs.join('；')} · 工坊下载目录：${st.downloadDir || ''}`
    : '还没找到小红车（Wallpaper Engine）的工坊目录：请先在 Steam 里订阅至少一款壁纸，再点「重新扫描」。';
  if ($('#wpList')) $('#wpList').innerHTML = local.length ? local.map(wpCardHtml).join('')
    : '<div class="mini-empty">还没读到本机订阅的壁纸。点「↻ 重新扫描本机小红车」，或先在 Steam 里订阅一款。</div>';
  if ($('#wpDownloaded')) $('#wpDownloaded').innerHTML = downloaded.length ? downloaded.map(wpCardHtml).join('')
    : '<div class="mini-empty">还没下载过工坊物品到 SteamLens。在上面粘贴工坊 ID / 链接就能下载预览素材。</div>';
  if ($('#wpCustomList')) {
    const ci = customWebItem();
    $('#wpCustomList').innerHTML = ci
      ? `<div class="wp-card is-active"><div class="wp-thumb-wrap"><div class="wp-thumb" style="display:flex;align-items:center;justify-content:center;font-size:30px">🌐</div><span class="wp-kind web">🌐 网页</span></div><div class="wp-body"><b>${esc(ci.title)}</b><small>自定义网址 · ${esc(String(ci.file).slice(0, 64))}</small></div></div>`
      : '<div class="mini-empty">还没设置。在上方粘贴网址或选本地 HTML 文件，立刻把它当动态壁纸。</div>';
  }
  if ($('#wpCurrent')) {
    const cc = WP?.config || {};
    if (cc.enabled && cc.id === 'custom-web' && cc.customUrl) {
      $('#wpCurrent').textContent = `当前壁纸：自定义网页壁纸（🌐 网页）· ${String(cc.customUrl).slice(0, 60)}`;
    } else {
      $('#wpCurrent').textContent = c.enabled && st.current
        ? `当前壁纸：${st.current.title}（${wpKindLabel(st.current.kind)}）· ID ${st.current.id}`
        : '当前：未启用。选一款壁纸就会变成软件背景。';
    }
  }
  renderWorkshopResult();
  applyWallpaper();
}
function applyWallpaper() {
  const c = WP?.config || {};
  let layer = $('#slWallpaperLayer');
  if (!layer) { layer = document.createElement('div'); layer.id = 'slWallpaperLayer'; document.body.prepend(layer); }
  const on = !!c.enabled && !!c.id;
  /* 界面透明度：启用壁纸时面板自动让位，滑块 0 = 纯透明，100 = 原玻璃面板 */
  const rawUi = WP_UI_DRAG && $('#wpUi') ? $('#wpUi').value : (c.ui === undefined ? 16 : c.ui);
  const ui = Math.max(0, Math.min(100, Number(rawUi) || 0));
  const crisp = c.crisp !== false;
  document.body.style.setProperty('--wp-ui-a', (ui / 100).toFixed(2));
  document.body.style.setProperty('--wp-ui-blur', crisp ? '0px' : (ui / 100 * 9).toFixed(1) + 'px');
  document.body.classList.toggle('wp-on', on);
  document.body.classList.toggle('wp-crisp', on && crisp);
  if (!on) { document.body.classList.remove('wp-focus'); wpTouchMode(false); }
  let exitBtn = $('#slWpExit');
  if (!exitBtn) {
    exitBtn = document.createElement('button');
    exitBtn.id = 'slWpExit'; exitBtn.type = 'button';
    exitBtn.textContent = '↩ 返回界面（Esc）';
    exitBtn.addEventListener('click', () => document.body.classList.remove('wp-focus'));
    document.body.appendChild(exitBtn);
  }
  layer.hidden = !on;
  if (!on) { layer.innerHTML = ''; WP_APPLIED_KEY = ''; return; }
  // 先按 id+src 精确匹配；匹配不到再退回只按 id 匹配（兼容旧配置里 src 被存成 local 的自定义网页壁纸）
  const it = wpEffectiveItems().find(x => String(x.id) === String(c.id) && x.src === c.src)
    || wpEffectiveItems().find(x => String(x.id) === String(c.id));
  if (!it) { layer.innerHTML = ''; WP_APPLIED_KEY = ''; return; }
  const src = wpMediaSrc(it);
  const vol = Math.min(1, Number(c.volume || 0) / 100);
  /* 视频壁纸把音量算进 key（改音量需重建 <video> 才能切换 muted 属性）；
     网页壁纸的 key 不含音量——音量通过注入脚本实时调节，避免每次拖动都重载壁纸。 */
  /* 离线包里没带完整媒体的大视频只显示预览图：URL 是图片时降级成 <img>，
     否则 <video> 加载一张图会完全没画面。 */
  const isStill = /^data:image\//i.test(src) || /\.(jpe?g|png|gif|webp|bmp)(\?|#|$)/i.test(src);
  const layerKind = isStill ? 'image' : it.kind;
  // 换成视频 / 图片 / 预览图降级后没有可互动内容，自动退出触摸模式，避免界面一直被收起
  if (layerKind !== 'web' && document.body.classList.contains('wp-touch')) wpTouchMode(false);
  const key = [c.id, c.src, c.fit, layerKind, layerKind === 'video' ? c.volume : ''].join('|');
  if (WP_APPLIED_KEY !== key && src) {
    WP_APPLIED_KEY = key;
    layer.innerHTML = layerKind === 'video'
      ? `<video autoplay loop playsinline ${vol > 0 ? '' : 'muted'} src="${esc(src)}"></video>`
      : layerKind === 'web'
        ? `<iframe src="${esc(src)}" title="动态壁纸" scrolling="no" allow="autoplay; encrypted-media; fullscreen; pointer-lock; gamepad; clipboard-read; clipboard-write"></iframe>`
        : `<img src="${esc(src)}" alt="动态壁纸">`;
    if (layerKind === 'web') {
      const fr = layer.querySelector('iframe');
      if (fr) fr.onload = () => { wireWebAudio(fr, vol); wpWakeIframe(fr); };
    } else {
      /* 完整视频/图片在另一台电脑上找不到时，才降级成预览图；本机永远先加载完整媒体 */
      const mediaEl = layer.firstElementChild;
      if (mediaEl) mediaEl.addEventListener('error', () => {
        const fb = wpFallbackPreview(it);
        if (!fb || fb === src || !mediaEl.isConnected) return;
        const img = document.createElement('img');
        img.src = fb; img.alt = '';
        mediaEl.replaceWith(img);
      }, { once: true });
    }
  }
  /* 高清模式：压暗与模糊强制归零，避免壁纸被蒙上一层灰、被面板糊掉 */
  layer.style.setProperty('--wp-dim', crisp ? '0' : (Number(c.dim || 0) / 100).toFixed(2));
  layer.style.setProperty('--wp-blur', crisp ? '0px' : Number(c.blur || 0) + 'px');
  layer.style.setProperty('--wp-fit', c.fit === 'contain' ? 'contain' : 'cover');
  const v = layer.querySelector('video');
  if (v) { v.volume = vol; v.muted = vol === 0; wpEnsurePlay(v, vol); }
  /* 网页壁纸：同源 iframe，直接控制其内部音频的音量（壁纸自带的声音） */
  if (it.kind === 'web') {
    const fr = layer.querySelector('iframe');
    if (fr && fr.__wpSetVol) fr.__wpSetVol(vol);
    if (fr) wpWakeIframe(fr);
  }
}

/* ✋ 网页壁纸「触摸 / 互动模式」
   常态下壁纸层是 pointer-events:none，软件界面盖在上层，鼠标只能点到面板。
   开启后收起界面并把事件交给 iframe，网页壁纸里的角色 / 按钮 / 物件就能真的被点到、拖到。
   只对网页（HTML）壁纸开放；状态不写进配置，重开软件自动回到正常界面。 */
function ensureWpTouchBar() {
  let bar = $('#slWpTouchBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'slWpTouchBar';
    bar.innerHTML = '<span>✋ <b>触摸模式</b> · 现在可以直接点 / 拖 / 摸壁纸里的角色和物件</span>' +
      '<button type="button" id="slWpTouchExit">↩ 返回界面（Esc）</button>';
    document.body.appendChild(bar);
    const exit = bar.querySelector('#slWpTouchExit');
    if (exit) exit.addEventListener('click', () => wpTouchMode(false));
  }
  return bar;
}
function wpTouchMode(on) {
  if (!on) { document.body.classList.remove('wp-touch'); return true; }
  const c = WP?.config || {};
  if (!c.enabled || !c.id) { toast('先选一款壁纸，再开启触摸模式'); return false; }
  const it = wpEffectiveItems().find(x => String(x.id) === String(c.id) && x.src === c.src)
    || wpEffectiveItems().find(x => String(x.id) === String(c.id));
  const kind = it ? it.kind : '';
  if (kind !== 'web') {
    toast(`当前是「${wpKindLabel(kind)}」壁纸，没有可互动的网页内容；请选一款「网页 / HTML」壁纸再开触摸模式。`);
    return false;
  }
  const fr = $('#slWallpaperLayer')?.querySelector('iframe');
  if (!fr) { toast('网页壁纸还没加载好，稍等一下再试'); return false; }
  document.body.classList.remove('wp-focus');
  document.body.classList.add('wp-touch');
  ensureWpTouchBar();
  try { fr.focus(); } catch {}
  try { wpWakeIframe(fr); } catch {}
  /* 焦点在 iframe 里时 Esc 不会冒泡到主页面；同源壁纸直接在 iframe 文档里补一个监听 */
  try {
    const d = fr.contentDocument;
    if (d && !d.__slTouchEscBound) {
      d.__slTouchEscBound = true;
      d.addEventListener('keydown', ev => {
        if (ev.key === 'Escape' && document.body.classList.contains('wp-touch')) {
          ev.preventDefault(); wpTouchMode(false);
        }
      }, true);
    }
  } catch { /* 跨域网页壁纸：只能点底部悬浮条返回 */ }
  toast('触摸模式已开启：可直接点击 / 拖动壁纸里的角色与物件，按 Esc 或点底部悬浮条返回');
  return true;
}

/* 启动即播放：浏览器常把「页面刚加载时创建的 <video autoplay>」停在首帧，
   尤其带音量时会被自动播放策略拦下，刷新一次（有了用户手势）才动。
   这里显式 play() + 多时点重试 + 被拦时先静音再播，保证一启动就在动。 */
const WP_BOUND = new WeakSet();
function wpEnsurePlay(v, vol) {
  if (!v) return;
  const tryPlay = () => {
    if (!v.isConnected || !v.paused || v.ended) return;
    try {
      const p = v.play();
      if (p && typeof p.catch === 'function') p.catch(() => {
        // 有声音的自动播放被拦：先静音播起来，再按用户设置的音量恢复
        try { v.muted = true; } catch {}
        const p2 = v.play();
        if (p2 && typeof p2.then === 'function') p2
          .then(() => { try { v.muted = vol === 0; v.volume = vol; } catch {} })
          .catch(() => {});
      });
    } catch {}
  };
  if (!WP_BOUND.has(v)) {
    WP_BOUND.add(v);
    v.addEventListener('loadeddata', tryPlay);
    v.addEventListener('canplay', tryPlay);
    v.addEventListener('stalled', () => setTimeout(tryPlay, 600));
  }
  tryPlay();
  setTimeout(tryPlay, 400);
  setTimeout(tryPlay, 1600);
}

/* 网页（HTML）壁纸：iframe 在隐藏/未聚焦时内部 requestAnimationFrame 会被节流，
   表现为「画面停在第一帧」。加载完派发 resize/focus 唤醒内部动画循环。 */
function wpWakeIframe(fr) {
  const wake = () => {
    try {
      const w = fr.contentWindow;
      if (!w) return;
      w.dispatchEvent(new Event('resize'));
      w.dispatchEvent(new Event('focus'));
      w.document?.dispatchEvent(new Event('visibilitychange'));
    } catch {}
  };
  wake();
  setTimeout(wake, 500);
  setTimeout(wake, 1800);
}

/* 全局兜底：任何时刻视频被浏览器暂停了，3 秒内自动拉回来 */
setInterval(() => {
  const layer = document.getElementById('slWallpaperLayer');
  if (!layer || layer.hidden) return;
  const v = layer.querySelector('video');
  if (v && v.paused && !v.ended && v.isConnected) {
    try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch {}
  }
}, 3000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  const layer = document.getElementById('slWallpaperLayer');
  if (!layer || layer.hidden) return;
  const v = layer.querySelector('video');
  if (v && v.paused) { try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch {} }
  const fr = layer.querySelector('iframe');
  if (fr) wpWakeIframe(fr);
});
/* 给网页（HTML）壁纸的同源 iframe 注入音量控制：让壁纸自带的音乐 / 音效能被软件音量滑块调节。
   仅在壁纸加载完成后注入一次，之后父级通过 __wpSetVol 实时改音量，不重载壁纸。 */
function wireWebAudio(iframe, vol) {
  const setVol = (val) => {
    const doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
    if (!doc) return;
    doc.querySelectorAll('audio, video').forEach(m => {
      try { m.volume = val; if (val > 0) m.muted = false; } catch (e) {}
    });
  };
  setVol(vol);
  try {
    const doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
    if (doc && doc.documentElement) {
      const mo = new MutationObserver(() => setVol(vol));
      mo.observe(doc.documentElement, { childList: true, subtree: true });
    }
  } catch (e) {}
  iframe.__wpSetVol = setVol;
}
async function loadWallpaper() {
  if (!wpOffline()) {
    try { WP = await api('/api/wallpaper/status'); } catch { /* 保留上次数据 */ }
  }
  renderWallpaper();
}
async function wpSet(patch) {
  if (wpOffline()) {
    /* 离线版照样能调壁纸：改本机内存 + 存 localStorage + 排队，服务恢复后合并回在线版 */
    if (!WP) WP = { config: {}, items: [] };
    WP.config = Object.assign({}, WP.config || {}, patch);
    wpSaveLocalConfig(WP.config);
    if (OFF) OFF.queueChange('/api/wallpaper/config', patch);
    renderWallpaper();
    return;
  }
  try {
    const r = await post('/api/wallpaper/config', patch);
    if (r.status) WP = r.status;
    renderWallpaper();
  } catch (e) { toast('壁纸设置失败：' + e.message); }
}
document.addEventListener('click', async (e) => {
  const pick = e.target.closest('[data-wp-pick]');
  if (pick) {
    await wpSet({ enabled: true, id: pick.getAttribute('data-wp-pick'), src: pick.getAttribute('data-wp-src') || 'local' });
    toast('已应用动态壁纸');
  }
  const hide = e.target.closest('[data-wp-hide]');
  if (hide) {
    const hid = hide.getAttribute('data-wp-hide'), hsrc = hide.getAttribute('data-wp-hide-src') || 'local';
    if (wpOffline()) {
      const c = Object.assign({}, (WP && WP.config) || {});
      const set = new Set(Array.isArray(c.hiddenIds) ? c.hiddenIds : []);
      set.add(String(hid) + ':' + hsrc);
      c.hiddenIds = [...set];
      if (String(c.id) === String(hid) && (c.src || 'local') === hsrc) c.enabled = false;
      WP.config = c; wpSaveLocalConfig(c);
      if (OFF) OFF.queueChange('/api/wallpaper/hide', { id: hid, src: hsrc });
      const all = WP._offlineAllItems || WP.items || [];
      WP.items = all.filter(x => !set.has(String(x.id) + ':' + (x.src || 'local')));
      renderWallpaper();
      toast('已从离线版列表删除；点「↻ 重新扫描本机小红车」会重新加载回来（小红车文件没动）');
      return;
    }
    try {
      const r = await post('/api/wallpaper/hide', { id: hid, src: hsrc });
      if (r.status) WP = r.status;
      renderWallpaper();
      toast('已从软件列表删除（小红车里的文件没动，点「重新扫描本机小红车」会重新加载回来）');
    } catch (err) { toast('删除失败：' + err.message); }
  }
});
$('#btnWpScan')?.addEventListener('click', async () => {
  if (wpOffline()) {
    const c = Object.assign({}, (WP && WP.config) || {}, { hiddenIds: [] });
    WP.config = c; wpSaveLocalConfig(c);
    WP.items = (WP._offlineAllItems || WP.items || []).slice();
    renderWallpaper(); toast(`离线版已恢复 ${WP.items.length} 款壁纸（小红车文件没动）`);
    return;
  }
  const b = $('#btnWpScan'); if (b) { b.disabled = true; b.textContent = '扫描中…'; }
  try { const r = await post('/api/wallpaper/scan', {}); if (r.status) WP = r.status; renderWallpaper(); toast(`扫描完成：${WP?.items?.length || 0} 款壁纸`); }
  catch (err) { toast('扫描失败：' + err.message); }
  if (b) { b.disabled = false; b.textContent = '↻ 重新扫描本机小红车'; }
});
$('#btnWpOff')?.addEventListener('click', () => wpSet({ enabled: false }));
$('#wpEnabled')?.addEventListener('change', e => wpSet({ enabled: e.target.checked }));
for (const [id, key] of [['wpDim', 'dim'], ['wpBlur', 'blur'], ['wpVolume', 'volume']]) {
  $('#' + id)?.addEventListener('change', e => wpSet({ [key]: Number(e.target.value) }));
}
$('#wpFit')?.addEventListener('change', e => wpSet({ fit: e.target.value }));
/* 界面不透明度：拖动时立刻预览，松手才写盘，避免每秒刷新打断拖动 */
$('#wpUi')?.addEventListener('input', e => {
  WP_UI_DRAG = true;
  const v = Number(e.target.value);
  if (WP && WP.config) WP.config.ui = v;
  applyWallpaper();
});
$('#wpUi')?.addEventListener('change', async e => {
  WP_UI_DRAG = false;
  await wpSet({ ui: Number(e.target.value) });
});
$('#wpUi')?.addEventListener('pointerup', () => { WP_UI_DRAG = false; });
$('#wpCrisp')?.addEventListener('change', e => wpSet({ crisp: e.target.checked }));
$('#btnWpCrisp')?.addEventListener('click', () => {
  wpSet({ ui: 12, dim: 0, blur: 0, crisp: true });
  toast('已切到高清模式：界面最透，壁纸不压暗、不模糊');
});
$('#btnWpReset')?.addEventListener('click', async () => {
  if (wpOffline()) {
    /* 离线版照常恢复默认：保留当前选中的壁纸与自定义网址，只把观感参数复位 */
    const prev = (WP && WP.config) || {};
    const d = { enabled: !!prev.enabled, id: String(prev.id || ''), src: prev.src || 'local',
      customUrl: prev.customUrl || '', dim: 0, blur: 0, volume: 50, fit: 'cover', ui: 16, crisp: true,
      hiddenIds: Array.isArray(prev.hiddenIds) ? prev.hiddenIds : [] };
    if (!WP) WP = { config: {}, items: [] };
    WP.config = Object.assign({}, WP.config || {}, d);
    wpSaveLocalConfig(WP.config);
    if (OFF) OFF.queueChange('/api/wallpaper/config', d);
    WP_UI_DRAG = false;
    renderWallpaper();
    toast('已恢复默认设置（界面最透、高清、音量 50%、铺满、不压暗不模糊）');
    return;
  }
  try {
    const r = await post('/api/wallpaper/reset', {});
    /* 兼容两种返回：{ status }（与 config 接口一致）或直接返回 status 对象 */
    if (r && r.config) WP = r;
    else if (r && r.status) WP = r.status;
    WP_UI_DRAG = false;   // 复位拖动标志，确保界面透明度滑块能跳回默认位置
    renderWallpaper();
    toast('已恢复动态壁纸默认设置（界面最透、高清、音量 50%、铺满、不压暗不模糊）');
  } catch (e) { toast('恢复默认失败：' + e.message); }
});
$('#btnWpFocus')?.addEventListener('click', () => {
  const c = WP?.config || {};
  if (!c.enabled || !c.id) { toast('先选一款壁纸，再进入沉浸模式'); return; }
  wpTouchMode(false);
  document.body.classList.add('wp-focus');
});
$('#btnWpTouch')?.addEventListener('click', () => wpTouchMode(true));
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (document.body.classList.contains('wp-touch')) wpTouchMode(false);
  else if (document.body.classList.contains('wp-focus')) document.body.classList.remove('wp-focus');
});
$('#btnWpLookup')?.addEventListener('click', async () => {
  if (wpOffline()) { toast('离线版不能查询工坊'); return; }
  const q = String($('#wpWorkshopInput')?.value || '').trim();
  if (!q) { toast('先粘贴工坊链接或 ID'); return; }
  const b = $('#btnWpLookup'); if (b) { b.disabled = true; b.textContent = '读取中…'; }
  try { WP_LOOKUP = await api('/api/wallpaper/workshop?id=' + encodeURIComponent(q)); renderWorkshopResult(); }
  catch (err) { WP_LOOKUP = { ok: false, error: err.message }; renderWorkshopResult(); }
  if (b) { b.disabled = false; b.textContent = '⌕ 读取工坊信息'; }
});
$('#btnWpDownload')?.addEventListener('click', async () => {
  if (wpOffline()) { toast('离线版不能下载工坊物品'); return; }
  const q = String($('#wpWorkshopInput')?.value || '').trim();
  if (!q) { toast('先粘贴工坊链接或 ID'); return; }
  const b = $('#btnWpDownload'); if (b) { b.disabled = true; b.textContent = '下载中…'; }
  try {
    const r = await post('/api/wallpaper/workshop/download', { id: q });
    if (r.status) WP = r.status;
    renderWallpaper();
    toast(r.ok ? `已下载到 SteamLens：${r.title || q}` : ('未下载成功：' + (r.error || r.note || '未知原因')));
  } catch (err) { toast('下载失败：' + err.message); }
  if (b) { b.disabled = false; b.textContent = '↓ 下载到软件'; }
});

/* ---------- 自定义网页壁纸：直接贴网址 / 选本地 HTML，立刻当动态壁纸 ---------- */
async function wpSetWeb(url) {
  if (wpOffline()) {
    /* 离线版照样能贴网址 / 选本地 HTML（data URL）当壁纸，存本机并排队回传 */
    const patch = { enabled: !!url, id: 'custom-web', src: 'url', customUrl: url || '' };
    if (!WP) WP = { config: {}, items: [] };
    WP.config = Object.assign({}, WP.config || {}, patch);
    wpSaveLocalConfig(WP.config);
    /* 本地 HTML 转成的 data URL 可能很大，超过 300 KB 就不塞同步队列，避免撑爆浏览器存储 */
    if (OFF && String(url || '').length < 300000) OFF.queueChange('/api/wallpaper/config', patch);
    renderWallpaper();
    toast(url ? '已应用自定义网页壁纸（离线版立刻生效）' : '已清除自定义网页壁纸');
    return;
  }
  try {
    const r = await post('/api/wallpaper/config', { enabled: !!url, id: 'custom-web', src: 'url', customUrl: url || '' });
    if (r.status) WP = r.status;
    renderWallpaper();
    toast(url ? '已应用自定义网页壁纸（立刻可见）' : '已清除自定义网页壁纸');
  } catch (err) { toast('设置失败：' + err.message); }
}
$('#btnWpWebUrl')?.addEventListener('click', () => {
  const u = String($('#wpWebUrl')?.value || '').trim();
  if (!u) { toast('先粘贴一个网页地址（http/https）'); return; }
  wpSetWeb(u);
});
$('#btnWpWebFile')?.addEventListener('click', () => $('#wpWebFile')?.click());
$('#wpWebFile')?.addEventListener('change', e => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  const rd = new FileReader();
  rd.onload = () => { wpSetWeb(String(rd.result)); toast('已用本地 HTML 文件做壁纸'); };
  rd.onerror = () => toast('读取文件失败');
  rd.readAsDataURL(f);
  e.target.value = '';
});
$('#btnWpWebClear')?.addEventListener('click', () => wpSetWeb(''));

/* ---------------- ✦ 开发者启动页面 ----------------
   硬性约束：默认绝不出现；唯一入口是软件内「设置保存 → 最下面 → 开发者模式」。
     · 开机自动播放（reason='boot'）：必须 #chkBootSplash 已启用。
       勾选 / 取消勾选【只是写设置，当场不播放】。
     · 当场预览（reason='dev'）：必须开发者面板已展开（BOOT_SPLASH_GATE），
       由面板内 #btnBootSplashPlay 点击触发；只是预览，不改变开机行为。
     · 关闭软件 / 退出页面：绝不播放，也没有退出动画；
       pagehide / beforeunload 会立刻把启动页收掉并清理定时器。
     · 其它任何来源（其它按钮 / 导航 / 快捷键 / URL 参数 / 控制台乱传）一律拒绝。
   与电脑系统、浏览器的「开发者模式」无关，纯粹是 SteamLens 软件内的开关。 */
const BOOT_SPLASH_KEY = 'sl-dev-bootsplash';
let BOOT_SPLASH_GATE = false;     // 软件内开发者模式面板是否展开
let BOOT_SPLASH_RUNNING = false;  // 防重入 / 供进度循环判断
let BOOT_SPLASH_TIMERS = [];
let BOOT_SPLASH_RAF = 0;

function bootSplashEnabled() {
  try { return localStorage.getItem(BOOT_SPLASH_KEY) === '1'; } catch { return false; }
}
function setBootSplashEnabled(on) {
  try {
    if (on) localStorage.setItem(BOOT_SPLASH_KEY, '1');
    else localStorage.removeItem(BOOT_SPLASH_KEY);
  } catch {}
}
function bootSplashSyncUI() {
  const on = bootSplashEnabled();
  const chk = $('#chkBootSplash');
  if (chk) chk.checked = on;
  const state = $('#bootSplashState'), hint = $('#bootSplashHint');
  if (state) state.textContent = on ? '已启用' : '未启用';
  if (hint) hint.textContent = on
    ? '状态：已启用 · 只在下次打开 / 刷新软件时播放一次；勾选不会立刻播放。想现在看效果可点「▶ 立即播放一次」，关闭软件不播放。'
    : '状态：未启用 · 软件启动时不会出现启动页面；想现在预览可点「▶ 立即播放一次」。';
  return on;
}
/* 关闭软件 / 离开页面：绝不播放启动页，也不做退出动画；
   把正在显示的一帧直接收掉，避免退出时残留或 bfcache 恢复时闪一下。 */
function bootSplashTeardown() {
  const el = $('#bootSplash');
  if (!el) return;
  BOOT_SPLASH_TIMERS.forEach(clearTimeout);
  BOOT_SPLASH_TIMERS = [];
  if (BOOT_SPLASH_RAF) cancelAnimationFrame(BOOT_SPLASH_RAF);
  BOOT_SPLASH_RAF = 0;
  BOOT_SPLASH_RUNNING = false;
  el.removeEventListener('click', bootSplashFinish);
  document.removeEventListener('keydown', bootSplashKey);
  el.classList.remove('bs-in', 'bs-out', 'bs-reset');
  el.hidden = true;
  el.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('boot-locked');
}
window.addEventListener('pagehide', bootSplashTeardown);
window.addEventListener('beforeunload', bootSplashTeardown);
function bootSplashKey(e) { if (e.key === 'Escape') bootSplashFinish(); }
function bootSplashFinish() {
  const el = $('#bootSplash'); if (!el || el.hidden) return;
  BOOT_SPLASH_TIMERS.forEach(clearTimeout);
  BOOT_SPLASH_TIMERS = [];
  if (BOOT_SPLASH_RAF) cancelAnimationFrame(BOOT_SPLASH_RAF);
  BOOT_SPLASH_RAF = 0;
  BOOT_SPLASH_RUNNING = false;
  el.removeEventListener('click', bootSplashFinish);
  document.removeEventListener('keydown', bootSplashKey);
  el.classList.remove('bs-in');
  el.classList.add('bs-out');
  /* 等淡出结束、遮罩真正隐藏后再解锁 body：
     若中途解锁，滚动条会在动画里回来，视口宽度一变，居中的标题会横向挪一下。 */
  BOOT_SPLASH_TIMERS.push(setTimeout(() => {
    if (!el.hidden) {
      el.hidden = true;
      el.setAttribute('aria-hidden', 'true');
      el.classList.remove('bs-out');
      const bar = $('#bsBar'); if (bar) bar.style.transform = 'scaleX(0)';
      document.body.classList.remove('boot-locked');
    }
  }, 580));
}
function playBootSplash(reason) {
  /* 入口守卫：只允许「开机自动（已启用）」和「开发者面板内手动预览」两种来源。
     勾选开关不是播放入口；任何其它 reason 一律拒绝；关闭软件也不会走到这里。 */
  if (reason === 'boot') { if (!bootSplashEnabled()) return false; }
  else if (reason === 'dev') { if (!BOOT_SPLASH_GATE) return false; }
  else return false;

  const el = $('#bootSplash');
  if (!el || BOOT_SPLASH_RUNNING) return false;
  /* 清掉上一次淡出遗留的收尾定时器，保证「立即播放一次」能反复完整重播 */
  BOOT_SPLASH_TIMERS.forEach(clearTimeout);
  BOOT_SPLASH_TIMERS = [];
  if (BOOT_SPLASH_RAF) cancelAnimationFrame(BOOT_SPLASH_RAF);
  BOOT_SPLASH_RAF = 0;
  const reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const total = reduce ? 850 : 3350;
  BOOT_SPLASH_RUNNING = true;

  const bar = $('#bsBar'), pct = $('#bsPct'), status = $('#bsStatusText');
  if (bar) bar.style.transform = 'scaleX(0)';
  if (pct) pct.textContent = '000';
  const stages = reduce
    ? [[0, '正在建立本机通道'], [55, '系统就绪']]
    : [[0, '正在建立本机通道'], [22, '校验 Steam 客户端'], [46, '同步游戏库与游玩时长'],
       [70, '正在初始化'], [92, '系统就绪']];
  if (status) status.textContent = stages[0][1];

  /* 重置所有 CSS 动画终态，保证「立即播放一次」可以反复完整重播 */
  el.classList.remove('bs-in', 'bs-out');
  el.classList.add('bs-reset');
  el.hidden = false;
  el.setAttribute('aria-hidden', 'false');
  void el.offsetWidth;
  el.classList.remove('bs-reset');
  void el.offsetWidth;
  el.classList.add('bs-in');
  document.body.classList.add('boot-locked');
  el.addEventListener('click', bootSplashFinish);
  document.addEventListener('keydown', bootSplashKey);

  let stageIdx = -1, lastPct = -1;
  const t0 = performance.now();
  const tick = now => {
    if (!BOOT_SPLASH_RUNNING) return;
    /* 连续浮点进度：只改 scaleX（可合成，不改布局），逐帧平滑、没有整数百分比的阶梯跳变 */
    const p = Math.min(1, (now - t0) / total);
    if (bar) bar.style.transform = 'scaleX(' + p.toFixed(5) + ')';
    const pi = Math.round(p * 100);
    if (pi !== lastPct) {            // 数字没变就不写 DOM，避免每帧无谓重排
      lastPct = pi;
      if (pct) pct.textContent = String(pi).padStart(3, '0');   // 固定三位，宽度恒定
    }
    let idx = 0;
    for (let i = 0; i < stages.length; i++) if (pi >= stages[i][0]) idx = i;
    if (idx !== stageIdx) {
      stageIdx = idx;
      if (status) {
        status.textContent = stages[idx][1];
        /* 阶段文案用一次短淡入，避免文字硬跳造成视觉抖动 */
        if (!reduce && status.animate) {
          try { status.getAnimations().forEach(a => a.cancel()); } catch {}
          status.animate(
            [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }],
            { duration: 320, easing: 'cubic-bezier(.16,.8,.24,1)' });
        }
      }
    }
    if (p < 1) BOOT_SPLASH_RAF = requestAnimationFrame(tick);
    else BOOT_SPLASH_RAF = 0;
  };
  BOOT_SPLASH_RAF = requestAnimationFrame(tick);
  /* 点击启动页任意处 / 按 Esc 可提前结束；不显示跳过按钮，保持开机画面的完整感 */
  BOOT_SPLASH_TIMERS.push(setTimeout(bootSplashFinish, total + (reduce ? 260 : 430)));
  return true;
}

/* 开发者模式：无论以后「设置保存」页新增多少卡片，都把它钉在最后一个。
   1) 每次 renderAll 归位一次；2) MutationObserver 监听子节点增删，自动重新归位
   （回调里若已经是最后一个就不再移动，不会造成观察循环）。 */
function pinDevModeLast() {
  const page = $('#page-settings');
  const card = $('#devModeCard');
  if (!page || !card) return;
  if (page.lastElementChild !== card) page.appendChild(card);
}
function initDevMode() {
  const page = $('#page-settings');
  const btn = $('#btnDevMode');
  const info = $('#devModeInfo');
  if (!page || !btn || !info) return;
  btn.addEventListener('click', () => {
    info.hidden = !info.hidden;
    /* 手动预览许可：只有展开软件内开发者模式面板时才解锁 */
    BOOT_SPLASH_GATE = !info.hidden;
    btn.textContent = info.hidden ? '点此展开 ›' : '收起 ‹';
    btn.setAttribute('aria-expanded', String(!info.hidden));
    if (!info.hidden) bootSplashSyncUI();
    pinDevModeLast();
  });
  /* 启动页开关与「立即播放一次」都只存在于这个面板里，是全软件唯一入口。
     开关【只是设置】：点它不播放，只有软件下次开启时 boot() 才按它决定播不播。
     预览按钮点了才当场播放一次，不改变开机行为。 */
  $('#chkBootSplash')?.addEventListener('change', e => {
    setBootSplashEnabled(!!e.target.checked);
    const on = bootSplashSyncUI();
    toast(on ? '已启用：下次打开软件时播放启动页面（这里不会立即播放）' : '已关闭：软件启动时不再显示启动页面');
  });
  $('#btnBootSplashPlay')?.addEventListener('click', () => {
    if (!BOOT_SPLASH_GATE) return;
    playBootSplash('dev');
  });
  if (!page.__slDevPinned) {
    page.__slDevPinned = true;
    new MutationObserver(() => {
      const c = $('#devModeCard');
      if (c && page.lastElementChild !== c) page.appendChild(c);
    }).observe(page, { childList: true });
  }
  bootSplashSyncUI();
  pinDevModeLast();
}

function renderAll() {
  renderHeader(); renderOverview(); renderGames(); renderFriends(); renderPrivate();
  renderValue(); renderProgress(); renderExport(); renderConnect();
  renderAccount(); renderNotify(); renderWechat(); renderQq(); renderBrowser(); renderSettings(); renderSms(); renderWallpaper();
  renderHidden(); renderDingtalk(); renderOffline(); renderFriendProfiles();
  pinDevModeLast();
}
initDevMode();

/* ---------------- ✦ 真开发者模式（隐藏入口） ----------------
   唯一触发方式：展开软件内「设置保存 → 开发者模式」后，连续点击「作者语录」三次。
   界面上不提供任何可见按钮 / 提示 / 光标变化 / hover 反馈 / 键盘或 URL 入口；
   点 1~2 次、或三次间隔过久，都完全没有反应，看不出这里能点。 */
const REAL_DEV_CLICKS = 3;
const REAL_DEV_WINDOW_MS = 2000;   // 三次必须落在同一个 2 秒窗口内，避免长时间误触累计
let realDevHits = 0, realDevLastAt = 0;

/* 两处内容互不混用：
   ① 「设置保存 → 开发者模式 → 作者语录」= 最早那几句旧原话（连点三次的隐藏入口就挂在它上面）；
   ② 三击后打开的「真开发者模式」= 作者后来真正想说的那一长段话，排成一整团短文。
   按用户要求：没有编辑处、没有诊断、没有复制 / 工具按钮，后面什么都不加。 */
const AUTHOR_QUOTE = '这是一款用来查看 Steam 游戏库、愿望单和好友动态的小工具。所有数据只保存在你自己的电脑上，不会上传到任何外部服务。';
const AUTHOR_TEXT = '欢迎使用 SteamLens。软件里的游戏、好友、愿望单和通知数据都只存在本机；首次使用时，请在设置里填写你自己的 Steam 信息，再按需要绑定你自己的通知渠道。';
function putOneParagraph(box, cls, text) {
  if (!box) return;
  box.replaceChildren();
  const p = document.createElement('p');
  p.className = cls;
  p.textContent = text;
  box.appendChild(p);
}
function paintDevWords() {
  putOneParagraph($('#devQuoteLines'), 'dq-text', AUTHOR_QUOTE);
  putOneParagraph($('#rdWords'), 'rd-w-text', AUTHOR_TEXT);
}

function realDevClose() {
  const el = $('#slRealDev');
  if (!el || el.hidden) return;
  el.hidden = true;
  el.setAttribute('aria-hidden', 'true');
}
function realDevOpen() {
  const el = $('#slRealDev');
  if (!el) return;
  el.hidden = false;
  el.setAttribute('aria-hidden', 'false');
  paintDevWords();
}
function initRealDev() {
  const quote = $('#devAuthorQuote');
  if (!quote) return;
  /* 刻意不加 cursor / title / role / tabindex / hover：语录看起来就是一段普通文字 */
  quote.addEventListener('click', () => {
    /* 选中文字不算连点，避免复制语录时误触发 */
    try { if (window.getSelection && String(window.getSelection()).length) return; } catch {}
    const now = Date.now();
    realDevHits = (now - realDevLastAt <= REAL_DEV_WINDOW_MS) ? realDevHits + 1 : 1;
    realDevLastAt = now;
    if (realDevHits >= REAL_DEV_CLICKS) {
      realDevHits = 0; realDevLastAt = 0;
      realDevOpen();
    }
  });
  $('#btnRealDevClose')?.addEventListener('click', realDevClose);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const rd = $('#slRealDev');
      if (rd && !rd.hidden) realDevClose();
    }
  });
  /* 点遮罩空白处退出；点内容区不退出 */
  $('#slRealDev')?.addEventListener('click', e => { if (e.target.id === 'slRealDev') realDevClose(); });
}
initRealDev();
paintDevWords();   // 主界面「作者语录」与真开发者模式共用同一份固定内容

/* 触摸模式悬浮条常驻 DOM，平时靠 body.wp-touch 控制显隐，避免任何路径进入模式时缺返回按钮 */
try { ensureWpTouchBar(); } catch {}

/* ------------------------------ 交互 ------------------------------ */
function go(page) {
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + page));
  $('#pageTitle').textContent = PAGE_META[page][0];
  $('#pageSub').textContent = PAGE_META[page][1];
  if (page === 'connect') fillConfig();
  if (page === 'friends') fillFriendConfig();
  if (page === 'account') fillAccount();
  if (page === 'notify') { fillNotify(); fillWechat(); fillQq(); }
  if (page === 'browser') fillBrowser();
  if (page === 'settings') renderSettings();
  if (page === 'wallpaper') loadWallpaper();
  if (page === 'syscheck') renderSysCheck();
  if (page === 'family') renderFamily();
  if (page === 'updates') loadUpdate();
  recordPage(page);
  renderAll();
}

$('#nav').addEventListener('click', e => {
  const b = e.target.closest('.nav-item'); if (b) go(b.dataset.page);
});
$('#modeSwitch').addEventListener('click', e => {
  const b = e.target.closest('button[data-mode]'); if (!b) return;
  setMode(b.dataset.mode);
});
async function setMode(m) {
  if (m !== 'auto' && m !== 'manual') return;
  MODE = m;
  try { localStorage.setItem('sl-mode', m); } catch {}
  recordMode(m);
  // 先立刻切换界面状态：即便后续联网刷新失败，开关也能立刻翻过去，杜绝“切换不到”
  renderHeader(); renderConnect();
  if (!DEMO) { try { await post('/api/config', { mode: m }); } catch {} }
  try {
    await load(true);
  } catch (e) {
    toast('切换模式时刷新数据失败：' + (e?.message || e));
  }
  // 兜底再同步一次，确保开关 / 状态徽标 / 连接卡片与 MODE 完全一致
  renderHeader(); renderConnect();
  toast(m === 'auto' ? '已切换到自动连接：读取本机 Steam' : '已切换到手动连接：Steam Web API / 粘贴 JSON');
}
$('#btnUseAuto').addEventListener('click', () => setMode('auto'));
$('#btnUseManual').addEventListener('click', () => { go('connect'); setMode('manual'); });
$('#btnRefresh').addEventListener('click', async () => { await load(true); toast(DEMO ? '仍处于离线演示模式' : '已重新扫描并保存快照'); });
$('#btnTheme').addEventListener('click', () => {
  applyTheme(isDark() ? 'light' : 'dark', true);
  renderAll(); toast(isDark() ? '已切换到深色' : '已恢复到白色');
});

$('#gameSearch').addEventListener('input', e => { SEARCH = e.target.value.trim(); renderGames(); });
$('#gameSort').addEventListener('change', e => { SORT = e.target.value; renderGames(); });
$('#gameFilters').addEventListener('click', e => {
  const b = e.target.closest('.chip'); if (!b) return;
  FILTER = b.dataset.f; recordFilter(FILTER);
  $$('#gameFilters .chip').forEach(x => x.classList.toggle('active', x === b));
  renderGames();
});
$('#maskToggle').addEventListener('change', e => {
  MASK = e.target.checked; localStorage.setItem('sl-mask', MASK ? '1' : '0');
  $('#exportMask').checked = MASK;
  renderAll(); toast(MASK ? '隐私游戏名称已脱敏（统计不变）' : '已显示真实名称（仅本机）');
});
$('#exportMask').addEventListener('change', e => { MASK = e.target.checked; $('#maskToggle').checked = MASK; renderExport(); });

/* 编辑弹窗 */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-edit]'); if (!b) return;
  editId = b.dataset.edit;
  const g = S.games.find(x => x.appid === editId); if (!g) return;
  $('#modalTitle').textContent = `编辑 · ${g.name}`;
  $('#modalForm').innerHTML = `
    <label>显示名称<input id="ovName" value="${esc(g.name)}"></label>
    <label>累计时长（小时）<input id="ovHours" type="number" step="0.1" min="0" value="${g.playtimeHours}"></label>
    <label>估价（元，0 = 免费）<input id="ovPrice" type="number" step="0.01" min="0" value="${g.priceCents ? (g.priceCents / 100).toFixed(2) : ''}"></label>
    <label>目标时长（小时，可留空）<input id="ovTarget" type="number" step="0.5" min="0" value="${g.targetHours || ''}"></label>
    <label>隐私标记<select id="ovPrivate"><option value="0"${!g.markedPrivate ? ' selected' : ''}>普通游戏</option><option value="1"${g.markedPrivate ? ' selected' : ''}>标记为隐私（计入统计但可脱敏）</option></select></label>
    <label>Steam 隐藏标记<select id="ovHidden"><option value="0"${!g.hiddenBySteam ? ' selected' : ''}>否</option><option value="1"${g.hiddenBySteam ? ' selected' : ''}>是</option></select></label>`;
  $('#modal').classList.remove('hidden');
});
$('#btnCloseModal').addEventListener('click', () => $('#modal').classList.add('hidden'));
$('#btnCancelModal').addEventListener('click', () => $('#modal').classList.add('hidden'));
$('#btnSaveOverride').addEventListener('click', async () => {
  if (!editId) return;
  const patch = {
    name: $('#ovName').value,
    playtimeMin: Math.round(Number($('#ovHours').value || 0) * 60),
    priceCents: $('#ovPrice').value === '' ? null : Math.round(Number($('#ovPrice').value) * 100),
    targetHours: $('#ovTarget').value === '' ? null : Number($('#ovTarget').value),
    markedPrivate: $('#ovPrivate').value === '1',
    hiddenBySteam: $('#ovHidden').value === '1'
  };
  for (const k of Object.keys(patch)) if (patch[k] === null) delete patch[k];
  if (!DEMO) { try { await post('/api/override', { appid: editId, ...patch }); } catch (e) { toast('保存失败：' + e.message); } }
  else {
    const g = S.games.find(x => x.appid === editId);
    Object.assign(g, patch, { effectivePrivate: patch.markedPrivate || patch.hiddenBySteam, playtimeHours: h(patch.playtimeMin ?? g.playtimeMin) });
  }
  $('#modal').classList.add('hidden');
  await load(true); toast('已保存（本机覆盖值）');
});

/* 配置保存 */
$('#btnSaveCfg').addEventListener('click', async () => {
  if (DEMO) { toast('离线演示模式：请先启动本地服务'); return; }
  const body = {
    steamPath: $('#cfgSteamPath').value.trim(), steamId64: $('#cfgSteamId').value.trim(),
    apiKey: $('#cfgApiKey').value.trim(), port: Number($('#cfgPort').value || 8787),
    pastedOwnedGames: $('#cfgPasted').value.trim()
  };
  try { await post('/api/config', body); await load(true); toast('配置已保存并重新扫描'); }
  catch (e) { toast('保存失败：' + e.message); }
});

/* 估价：进度条与服务端任务完全同步，任何异常都能自恢复 */
function setEstimateUi(busy) {
  const box = $('#estimateProgress'); if (!box) return;
  box.hidden = !busy;
  box.classList.toggle('busy', busy);
  const b1 = $('#btnEstimate'), b2 = $('#btnEstimateAll');
  if (b1) b1.disabled = busy;
  if (b2) b2.disabled = busy;
  if (!busy && $('#estimateBar')) $('#estimateBar').style.width = '0%';
}
function syncEstimateUi() {
  if (DEMO || estimatePolling) return;
  // 页面刚打开时也要能看到「后台自动刷新」正在跑的进度
  api('/api/estimate/status').then(j => {
    if (j.running) { setEstimateUi(true); pollEstimate(); }
    else setEstimateUi(false);
  }).catch(() => {});
}
function pollEstimate() {
  clearInterval(estTimer);
  estimatePolling = true;
  estTimer = setInterval(async () => {
    try {
      const j = await api('/api/estimate/status');
      if (!j.running) {
        clearInterval(estTimer); estimatePolling = false;
        setEstimateUi(false);
        try { await load(true); } catch {}
        toast(j.error ? '估价结束：' + j.error : '库价值已刷新');
        return;
      }
      setEstimateUi(true);
      const pct = j.total ? Math.max(3, Math.round((j.done || 0) / j.total * 100)) : 0;
      if ($('#estimateBar')) $('#estimateBar').style.width = pct + '%';
      if ($('#estimateText')) $('#estimateText').textContent =
        `${j.done || 0} / ${j.total || 0} · 成功 ${j.fetched || 0} · 待重试 ${j.failed || 0}` +
        `${j.inflight ? ' · 查询中 ' + j.inflight : ''} · ${j.elapsedSec || 0}s`;
    } catch (e) {
      clearInterval(estTimer); estimatePolling = false;
      setEstimateUi(false); toast('进度查询中断，按钮已恢复');
    }
  }, 700);
}
async function startEstimate(refreshAll) {
  if (DEMO) { toast('离线演示模式：请先启动本地服务'); return; }
  try {
    const j = await post('/api/estimate', { mode: MODE, refreshAll });
    if (!j.started) {
      toast(j.reason || '无需查价');
      if (j.job?.running) { setEstimateUi(true); pollEstimate(); }
      else { setEstimateUi(false); await load(true).catch(() => {}); }
      return;
    }
    setEstimateUi(true);
    $('#estimateText').textContent = `0 / ${j.total} · 3 路并发查询`;
    toast(`开始估算 ${j.total} 款游戏的商店标价`);
    pollEstimate();
  } catch (e) { setEstimateUi(false); toast('启动失败：' + e.message); }
}
$('#btnEstimate').addEventListener('click', () => startEstimate(false));
$('#btnEstimateAll').addEventListener('click', () => startEstimate(true));

/* 复制（导出页不再提供文件下载入口） */
async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); toast(label + ' 已复制到剪贴板'); }
  catch { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); toast(label + ' 已复制'); }
}
$('#btnCopyMd').addEventListener('click', async () => {
  let txt = localMarkdown();
  if (!DEMO) { try { txt = await api(`/api/context?mask=${MASK ? '1' : '0'}`); } catch {} }
  copy(txt, 'Steam 报告');
});
$('#btnCopyPrompt').addEventListener('click', () => copy(
  '请基于我接下来提供的 SteamLens 报告，分析我的游戏时间分布、投入产出比、最近游玩趋势，指出最花时间的游戏是否「值回票价」，并给出 3 条可执行建议。报告：\n\n' + localMarkdown(),
  '分析提示词'));
$('#btnCopyMcp').addEventListener('click', () => copy($('#mcpCode').textContent, 'MCP 配置'));

/* ------------------------------ 好友上线交互 ------------------------------ */
$('#friendFilters').addEventListener('click', e => {
  const b = e.target.closest('.chip'); if (!b) return;
  FILTER_USER_SET = true;              // 手动选择，之后不再自动回退
  FILTER_FIX_AVAILABLE = false;
  FFILTER = b.dataset.f;
  $$('#friendFilters .chip').forEach(x => x.classList.toggle('active', x === b));
  recordFilter(FFILTER, 'friend');
  renderFriends();
});
$('#friendSearch').addEventListener('input', e => {
  FILTER_USER_SET = true;
  FSEARCH = e.target.value.trim();
  renderFriends();
});
// 空态里的「显示全部好友」快捷按钮（事件委托，因为按钮是动态生成的）
$('#friendsGrid').addEventListener('click', e => {
  if (!e.target.closest('#btnShowAllFriends')) return;
  FILTER_USER_SET = true; FILTER_FIX_AVAILABLE = false;
  FFILTER = 'all'; FSEARCH = '';
  $$('#friendFilters .chip').forEach(x => x.classList.toggle('active', x.dataset.f === 'all'));
  if ($('#friendSearch')) $('#friendSearch').value = '';
  recordFilter('all', 'friend'); queueUi({ friendSearch: '' });
  renderFriends();
  toast('已显示全部好友');
});

$('#friendsGrid').addEventListener('click', async e => {
  const b = e.target.closest('[data-star]'); if (!b) return;
  const id = b.dataset.star, on = b.dataset.on !== '1';
  if (!DEMO) {
    try {
      await post('/api/friends/star', { steamId64: id, starred: on });
      F = await api('/api/friends');
    } catch (err) { toast('操作失败：' + err.message); return; }
  } else {
    const f = F.friends.find(x => x.steamId64 === id); if (f) f.starred = on;
    F.totals.starred = F.friends.filter(x => x.starred).length;
  }
  renderFriends(); renderHeader();
  toast(on ? '已关注 · 上线时会通知你' : '已取消关注');
});

$('#btnFriendsRefresh').addEventListener('click', async () => {
  if (DEMO) { toast('离线演示模式：请先启动本地服务'); return; }
  try {
    const r = await post('/api/friends/refresh');
    F = r.state || F;
    checkFriendNotifications(); renderFriends(); renderHeader();
    toast('好友状态已刷新');
  } catch (e) { toast('刷新失败：' + e.message); }
});

$('#friendAuto').addEventListener('change', async e => {
  const sec = e.target.checked ? (savedPollSec || 60) : 0;
  if (e.target.checked) savedPollSec = sec;
  if (!DEMO) {
    try { const r = await post('/api/friends/config', { friendPollSec: sec }); F = r.state || F; }
    catch (err) { toast('设置失败：' + err.message); }
  } else F.config.friendPollSec = sec;
  renderFriends();
  toast(e.target.checked ? '后台自动监控已开启' : '后台自动监控已暂停');
});

$('#fNotify').addEventListener('change', e => {
  if (e.target.checked && typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission().then(p => toast(p === 'granted' ? '已允许桌面通知' : '未允许桌面通知，仍会在面板内提示'));
  }
});

$('#btnSaveFriendCfg').addEventListener('click', async () => {
  if (DEMO) { toast('离线演示模式：请先启动本地服务'); return; }
  const body = {
    friendPollSec: Math.min(3600, Math.max(15, Number($('#fPoll').value || 60))),
    friendNotify: $('#fNotify').checked,
    friendLoadRemoteAvatars: $('#fRemoteAvatar').checked
  };
  const key = $('#fApiKey').value.trim(); if (key) body.apiKey = key;
  const pasted = $('#fPasted').value.trim(); if (pasted) body.friendPastedSummaries = pasted;
  try {
    const r = await post('/api/friends/config', body);
    F = r.state || F; savedPollSec = body.friendPollSec;
    checkFriendNotifications(); fillFriendConfig(); renderFriends(); renderHeader();
    toast('连接设置已保存');
  } catch (e) { toast('保存失败：' + e.message); }
});

$('#btnAddFriend').addEventListener('click', async () => {
  const id = $('#fAddId').value.trim();
  if (!/^7656119\d{10}$/.test(id)) { toast('请填写 17 位 SteamID64（7656119 开头）'); return; }
  if (DEMO) { toast('离线演示模式：请先启动本地服务'); return; }
  try {
    const r = await post('/api/friends/add', { steamId64: id, name: $('#fAddName').value.trim() });
    F = r.state || F;
    $('#fAddId').value = ''; $('#fAddName').value = '';
    renderFriends(); renderHeader(); toast('已添加好友');
  } catch (e) { toast('添加失败：' + e.message); }
});

$('#btnClearEvents').addEventListener('click', async () => {
  if (DEMO) { F.events = []; F.stats.totalEvents = 0; renderFriends(); toast('演示动态已清空'); return; }
  try {
    await post('/api/friends/clear-events');
    F = await api('/api/friends?refresh=1');
    lastEventTs = Date.now(); localStorage.setItem('sl-last-event', String(lastEventTs));
    renderFriends(); toast('上线动态已清空');
  } catch (e) { toast('清空失败：' + e.message); }
});

/* 旧的「清理非好友」已统一到好友页的「🗑 删掉好友」弹窗：
   以 Steam 客户端 / 网页端真实好友名单为准，只软删除软件里的记录，随时可恢复。
   （事件监听在文件末尾的 friendCleanOpen 处统一绑定，这里不再重复注册。） */

// 面板每 15 秒读取一次服务端结果（真正的轮询由服务后台完成，关掉页面也照常记录）
setInterval(async () => {
  if (DEMO) return;
  try {
    if ($('#friendAuto')?.checked) {
      const fresh = await api('/api/friends');
      /* 新数据为空时保留启动缓存的好友记录，界面不会闪成空白 */
      if (fresh && Array.isArray(fresh.friends) && (fresh.friends.length || !F?._fromCache)) F = fresh;
      friendCacheSave();
    }
    const [ar, hid, est] = await Promise.all([
      api('/api/autorefresh').catch(() => AR),
      api('/api/hidden/status').catch(() => H),
      api('/api/estimate/status').catch(() => null)
    ]);
    AR = ar; H = hid;
    checkFriendNotifications(); renderFriends(); renderHeader(); renderHidden();
    if (est?.running && !estimatePolling) { setEstimateUi(true); pollEstimate(); }
    if ($('#page-notify').classList.contains('active')) renderNotify();
    if ($('#page-value').classList.contains('active')) renderValue();
  } catch {}
}, 15000);

/* ------------------------------ 账号 / 通知 / 邮箱交互 ------------------------------ */
async function refreshAux() {
  if (DEMO) return;
  const [a, n, w, ar, m, wx, bs, qq, sm] = await Promise.all([
    api('/api/account').catch(() => A), api('/api/notify/status').catch(() => N),
    api('/api/wishlist').catch(() => W), api('/api/autorefresh').catch(() => AR),
    api('/api/mail/status').catch(() => MAIL),
    api('/api/wechat/status').catch(() => WECHAT), api('/api/browser/status').catch(() => B),
    api('/api/qq/status').catch(() => QQ), api('/api/sms/status').catch(() => SMS)
  ]);
  A = a; N = n; W = w; AR = ar; MAIL = m; WECHAT = wx; B = bs; QQ = qq; SMS = sm;
  renderAccount(); renderNotify(); renderWechat(); renderQq(); renderBrowser(); renderValue(); renderHeader(); renderSms();
}

// 表格与刷新条里的动态按钮走事件委托
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act;
  if (DEMO) { toast('离线演示模式：请先启动本地服务'); return; }
  try {
    if (act === 'refresh-value') {
      const r = await post('/api/refresh/value');
      toast(r.started ? `开始刷新 ${r.total} 款价格（后台进行）` : '价格缓存均有效，无需刷新');
      await refreshAux(); pollEstimate();
    } else if (act === 'refund' || act === 'reinstate') {
      await post('/api/account/refund', { appid: b.dataset.id, refunded: b.dataset.on === '1', reinstate: act === 'reinstate' });
      await load(true); toast(act === 'reinstate' ? '已恢复计入价值' : (b.dataset.on === '1' ? '已标记为退款，不再计价' : '已撤销退款标记'));
    }
  } catch (err) { toast('操作失败：' + err.message); }
});

async function connectAccount() {
  if (DEMO) { toast('离线演示模式：请先启动本地服务'); return; }
  const btn = $('#btnAccountConnect');
  btn.disabled = true; btn.textContent = '正在连接并扫描…';
  try {
    const body = {
      steamId64: $('#acctSteamId').value.trim(),
      apiKey: $('#acctApiKey').value.trim()
    };
    const po = $('#acctPastedOwned').value.trim(); if (po) body.pastedOwnedGames = po;
    const pw = $('#acctPastedWishlist').value.trim(); if (pw) body.pastedWishlist = pw;
    const r = await post('/api/account/connect', body);
    await load(true); fillAccount();
    // 连接成功后把该账号存进保险库（含只读 Key，方便一键切换）
    try {
      const vid = (A && A.steamId64) || body.steamId64;
      if (!vid) throw 0;
      vaultUpsert({
        steamId64: (A && A.steamId64) || body.steamId64,
        personaName: (A && A.profile && A.profile.personaname) || '',
        accountName: (S && S.connection && S.connection.account && S.connection.account.accountName) || '',
        avatar: (A && A.profile && A.profile.avatarfull) || '',
        apiKey: body.apiKey || '',
        connected: !!(A && A.connected),
        ownedCount: A && A.ownedCount, wishlistCount: A && A.wishlistCount, lastSyncIso: A && A.lastSyncIso,
        source: 'connect'
      });
    } catch {}
    toast(`扫描完成：${r.message}`);
    if (r.warnings?.length) toast('提示：' + r.warnings[0]);
  } catch (err) { toast('连接失败：' + (err.message || '请检查 SteamID64 与 Key')); }
  finally { btn.disabled = false; btn.textContent = '登录并扫描游戏库'; }
}
$('#btnAccountConnect').addEventListener('click', connectAccount);
$('#btnPasteImport').addEventListener('click', connectAccount);
$('#btnAccountSync').addEventListener('click', async () => {
  if (DEMO) { toast('离线演示模式'); return; }
  try { const r = await post('/api/account/sync'); await load(true); toast('真实库已重新同步：' + (r.message || '完成')); }
  catch (e) { toast('同步失败：' + e.message); }
});
$('#btnAccountDisconnect').addEventListener('click', async () => {
  if (DEMO) { toast('离线演示模式'); return; }
  try { await post('/api/account/disconnect'); await load(true); toast('已退出 Steam 账号连接（手动标记的退款保留）'); }
  catch (e) { toast('退出失败：' + e.message); }
});
$('#accountAutoLink').addEventListener('change', async (e) => {
  try { await post('/api/account/link', { enabled: e.target.checked }); await loadAccountLink(); toast(e.target.checked ? '已开启自动连接本机 Steam 账号' : '已关闭自动连接'); }
  catch (err) { toast('设置失败：' + err.message); }
});
loadAccountLink();
setInterval(loadAccountLink, 4000);
bindAccountSwitch();
// 离线版（file:// 双击打开）在界面上显示「离线版」小字
if (location.protocol === 'file:') { const b = document.getElementById('offlineBadge'); if (b) b.hidden = false; }
$('#btnToggleKey').addEventListener('click', () => {
  const i = $('#acctApiKey');
  i.type = i.type === 'password' ? 'text' : 'password';
  $('#btnToggleKey').textContent = i.type === 'password' ? '显示' : '隐藏';
});
$('#btnGenLinks').addEventListener('click', async () => {
  if (DEMO) { toast('离线演示模式'); return; }
  try {
    const r = await api('/api/account/links');
    $('#acctLinks').innerHTML = (r.ownedGames ? `<span class="root-chip">GetOwnedGames：<a href="${esc(r.ownedGames)}" target="_blank" rel="noopener">在浏览器打开 ↗</a></span>` : '<span class="root-chip">填写 API Key + SteamID64 后可生成直连链接</span>')
      + (r.wishlist ? `<span class="root-chip">愿望单 JSON：<a href="${esc(r.wishlist)}" target="_blank" rel="noopener">在浏览器打开 ↗</a></span>` : '');
    if (r.ownedGames) copy(r.ownedGames, 'API 链接');
  } catch (e) { toast('生成失败：' + e.message); }
});

// 方式 1：在 Steam 官方客户端里用账号密码登录（密码不经过本程序）
$('#btnSteamOfficialLogin').addEventListener('click', async () => {
  if (DEMO) { toast('离线演示模式：请先启动本地服务'); return; }
  try {
    const r = await post('/api/steam/launch');
    toast(r.message || '已打开 Steam 官方客户端');
  } catch (e) { toast('打开失败：' + e.message); }
});

/* QQ 邮箱：登录 / 退出 / 测试 */
$('#btnMailLogin').addEventListener('click', async () => {
  if (DEMO) { toast('离线演示模式'); return; }
  const user = $('#mailUser').value.trim();
  const code = $('#mailAuthCode').value.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(user)) { toast('请填写正确的 QQ 邮箱地址'); return; }
  if (!code && !MAIL?.authCodeSet) { toast('请填写 16 位 SMTP 授权码'); return; }
  const btn = $('#btnMailLogin'); btn.disabled = true; btn.textContent = '正在登录…';
  try {
    const r = await post('/api/mail/connect', {
      user, authCode: code, to: $('#mailTo').value.trim() || user,
      verify: $('#mailVerify').checked
    });
    await refreshAux(); fillNotify();
    toast(r.message || '登录成功');
  } catch (e) { toast('登录失败：' + e.message); }
  finally { btn.disabled = false; btn.textContent = '登录 QQ 邮箱'; }
});
$('#btnMailLogout').addEventListener('click', async () => {
  if (DEMO) { toast('离线演示模式'); return; }
  try {
    await post('/api/mail/logout');
    $('#mailUser').value = ''; $('#mailTo').value = ''; $('#mailAuthCode').value = '';
    await refreshAux(); fillNotify(); toast('已退出 QQ 邮箱，本机授权码已清除');
  } catch (e) { toast('退出失败：' + e.message); }
});
$('#btnMailTest').addEventListener('click', async () => {
  if (DEMO) { toast('离线演示模式'); return; }
  try {
    const r = await post('/api/mail/test');
    toast(r.sent ? '测试邮件已发出，请查收'
      : '未发出：' + (r.diagnosis || r.reason || r.error || '未知原因'));
    await refreshAux();
  } catch (e) { toast('发送失败：' + e.message); }
});

/* 通知设置 */
$('#btnSaveNotify').addEventListener('click', async () => {
  if (DEMO) { toast('离线演示模式'); return; }
  const body = {
    friendNotify: $('#nEnabled').checked,
    friendNotifyOffline: $('#nOfflineEnabled')?.checked !== false,
    notifyDesktop: $('#nDesktop').checked,
    notifySound: $('#nSound').checked, notifyScope: $('#nScope').value,
    notifyMinIntervalSec: Math.max(30, Number($('#nMinInterval').value || 300)),
    notifyWebhookUrl: $('#nWebhook').value.trim(), notifyWebhookType: $('#nWebhookType').value,
    mailOnOnline: $('#mOnOnline')?.checked !== false,
    mailOnOffline: $('#mOnOffline')?.checked !== false
  };
  try { await post('/api/notify/config', body); await refreshAux(); toast('通知设置已保存'); }
  catch (e) { toast('保存失败：' + e.message); }
});
$('#btnTestNotify').addEventListener('click', async () => {
  if (DEMO) { toast('离线演示模式'); return; }
  try { const r = await post('/api/notify/test', { type: 'online' }); toast(r.sent ? '上线测试弹窗已发出（看右下角）' : '未发出：' + (r.reason || '')); await refreshAux(); }
  catch (e) { toast('测试失败：' + e.message); }
});
$('#btnTestOffline')?.addEventListener('click', async () => {
  if (DEMO) { toast('离线演示模式'); return; }
  try {
    const r = await post('/api/notify/test', { type: 'offline' });
    toast(r.sent ? '「好友退出 Steam」测试弹窗已发出（看右下角）' : '未发出：' + (r.reason || ''));
    await refreshAux();
  } catch (e) { toast('测试失败：' + e.message); }
});

/* 愿望单提醒 */
$('#btnSaveWishlist').addEventListener('click', async () => {
  if (DEMO) { toast('离线演示模式'); return; }
  try {
    await post('/api/wishlist/config', {
      thresholdYuan: Number($('#wThreshold').value || 30),
      enabled: $('#wEnabled').checked,
      checkHours: Number($('#wCheckHours').value || 6)
    });
    await refreshAux(); toast('愿望单提醒设置已保存');
  } catch (e) { toast('保存失败：' + e.message); }
});
$('#btnWishlistCheck').addEventListener('click', async () => {
  if (DEMO) { toast('离线演示模式'); return; }
  const btn = $('#btnWishlistCheck'); btn.disabled = true; btn.textContent = '正在查价…';
  try {
    const r = await post('/api/wishlist/check');
    await load(true); toast(r.message || '检查完成');
    if (r.alerts?.length) toast(`${r.alerts.length} 条跨阈值变化，已尝试发送邮件`);
  } catch (e) { toast('检查失败：' + e.message); }
  finally { btn.disabled = false; btn.textContent = '↻ 立即检查价格'; }
});
$('#btnRefreshAll').addEventListener('click', async () => {
  if (DEMO) { toast('离线演示模式'); return; }
  try { await post('/api/refresh/all'); await refreshAux(); pollEstimate(); toast('已触发全部自动刷新任务'); }
  catch (e) { toast('刷新失败：' + e.message); }
});

/* ==================================================================== */
/*  设置持久化：所有改动自动落盘，重启 / 换浏览器都不丢                    */
/* ==================================================================== */

/* 凭证类输入框不写草稿，避免把明文散落到 ui-settings.json */
const SECRET_IDS = new Set([
  'cfgApiKey', 'fApiKey', 'acctApiKey', 'mailAuthCode', 'wKey', 'qKey', 'cfgPasted',
  'fPasted', 'acctPastedOwned', 'acctPastedWishlist'
]);

/* 控件 → 后台配置端点 / 字段。留空的凭证类字段由后端自行沿用旧值，不会误清空。 */
const CONFIG_BINDINGS = [
  // [元素 id, 端点, 后台字段名, 类型]
  ['cfgSteamPath', '/api/config', 'steamPath', 'str'],
  ['cfgSteamId', '/api/config', 'steamId64', 'str'],
  ['cfgPort', '/api/config', 'port', 'num'],
  ['cfgApiKey', '/api/config', 'apiKey', 'secret'],
  ['cfgPasted', '/api/config', 'pastedOwnedGames', 'secret'],
  ['fApiKey', '/api/friends/config', 'apiKey', 'secret'],
  ['fPoll', '/api/friends/config', 'friendPollSec', 'num'],
  ['fNotify', '/api/friends/config', 'friendNotify', 'bool'],
  ['fRemoteAvatar', '/api/friends/config', 'friendLoadRemoteAvatars', 'bool'],
  ['fPasted', '/api/friends/config', 'friendPastedSummaries', 'secret'],
  ['nScope', '/api/notify/config', 'notifyScope', 'str'],
  ['nMinInterval', '/api/notify/config', 'notifyMinIntervalSec', 'num'],
  ['nDesktop', '/api/notify/config', 'notifyDesktop', 'bool'],
  ['nSound', '/api/notify/config', 'notifySound', 'bool'],
  ['nEnabled', '/api/notify/config', 'friendNotify', 'bool'],
  ['nOfflineEnabled', '/api/notify/config', 'friendNotifyOffline', 'bool'],
  ['mOnOnline', '/api/notify/config', 'mailOnOnline', 'bool'],
  ['mOnOffline', '/api/notify/config', 'mailOnOffline', 'bool'],
  ['nWebhook', '/api/notify/config', 'notifyWebhookUrl', 'str'],
  ['nWebhookType', '/api/notify/config', 'notifyWebhookType', 'str'],
  ['mailUser', '/api/mail/connect', 'user', 'mail'],
  ['mailTo', '/api/mail/connect', 'to', 'mail'],
  ['mailAuthCode', '/api/mail/connect', 'authCode', 'mail'],
  ['wThreshold', '/api/wishlist/config', 'thresholdYuan', 'num'],
  ['wCheckHours', '/api/wishlist/config', 'checkHours', 'num'],
  ['wEnabled', '/api/wishlist/config', 'enabled', 'bool'],
  ['wChannel', '/api/wechat/config', 'channel', 'str'],
  ['wKey', '/api/wechat/connect', 'key', 'wechat'],
  ['wMinInterval', '/api/wechat/config', 'minIntervalSec', 'num'],
  ['wOnOnline', '/api/wechat/config', 'onOnline', 'bool'],
  ['wOnOffline', '/api/wechat/config', 'onOffline', 'bool'],
  ['wOnWishlist', '/api/wechat/config', 'onWishlist', 'bool'],
  ['wEnabledWechat', '/api/wechat/config', 'enabled', 'bool'],
  ['qChannel', '/api/qq/config', 'channel', 'str'],
  ['qUin', '/api/qq/config', 'uin', 'str'],
  ['qEndpoint', '/api/qq/config', 'endpoint', 'str'],
  ['qKey', '/api/qq/connect', 'key', 'wechat'],
  ['qOnOnline', '/api/qq/config', 'onOnline', 'bool'],
  ['qOnOffline', '/api/qq/config', 'onOffline', 'bool'],
  ['qOnWishlist', '/api/qq/config', 'onWishlist', 'bool'],
  ['qEnabled', '/api/qq/config', 'enabled', 'bool'],
  ['dOnOnline', '/api/dingtalk/config', 'dingtalkOnOnline', 'bool'],
  ['dOnOffline', '/api/dingtalk/config', 'dingtalkOnOffline', 'bool'],
  ['dOnWishlist', '/api/dingtalk/config', 'dingtalkOnWishlist', 'bool'],
  ['dEnabled', '/api/dingtalk/config', 'dingtalkEnabled', 'bool'],
  ['dKeyword', '/api/dingtalk/config', 'dingtalkKeyword', 'str'],
  ['bFriendCode', '/api/browser/friend-code', 'code', 'friendCode']
];

/* 只保存界面草稿（没有对应后台配置端点，或后台值不适合直接覆盖） */
const DRAFT_ONLY = new Set([
  'gameSearch', 'friendSearch', 'fAddId', 'fAddName', 'acctSteamId',
  'mailVerify', 'bSteamId64'
]);

const SAVE_IDS = new Set([...CONFIG_BINDINGS.map(b => b[0]), ...DRAFT_ONLY,
  'maskToggle', 'exportMask', 'gameSort', 'friendAuto', 'nSound']);

let uiPending = {}, cfgPending = {}, saveTimer = null, restoreTimer = null;

function setSaveBadge(state, text) {
  const el = $('#saveState'); if (!el) return;
  el.classList.remove('saving', 'error');
  if (state !== 'ok') el.classList.add(state);
  $('#saveStateText').textContent = text || (state === 'ok' ? '已自动保存' : state === 'saving' ? '保存中…' : '保存失败');
}

function queueUi(patch) {
  Object.assign(uiPending, patch);
  scheduleFlush();
}
function queueCfg(endpoint, field, value, type) {
  const key = endpoint + '|' + field;
  cfgPending[key] = { endpoint, field, value, type };
  scheduleFlush();
}
function scheduleFlush() {
  setSaveBadge('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 420);
}

async function flushSave() {
  const uiPatch = uiPending, cfgPatch = cfgPending;
  uiPending = {}; cfgPending = {};
  if (DEMO) { setSaveBadge('ok'); return; }

  const jobs = [];
  if (Object.keys(uiPatch).length) {
    jobs.push(post('/api/ui-settings', uiPatch).then(s => {
      if (s?.settings) UI = s.settings;
    }));
  }
  // 按端点合并，避免同一端点连发多次
  const groups = new Map();
  for (const it of Object.values(cfgPatch)) {
    // 凭证类留空 → 不发送，后端沿用已保存值
    if ((it.type === 'secret' || it.type === 'mail' || it.type === 'wechat' || it.type === 'friendCode')
        && !String(it.value ?? '').trim()) continue;
    if (!groups.has(it.endpoint)) groups.set(it.endpoint, {});
    groups.get(it.endpoint)[it.field] = it.value;
  }
  for (const [endpoint, body] of groups) {
    // 登录类端点只在「登录」按钮里调用，自动保存改用 config 端点避免误触发登录
    const safe = endpoint === '/api/mail/connect' ? '/api/mail/config'
      : endpoint === '/api/wechat/connect' ? '/api/wechat/config'
      : endpoint === '/api/qq/connect' ? '/api/qq/config'
      : endpoint === '/api/browser/friend-code' ? null : endpoint;
    if (!safe) continue;
    const clean = { ...body };
    if (safe === '/api/mail/config') {
      // 邮箱地址 / 收件人可直接落盘；授权码只在「登录 QQ 邮箱」按钮里提交
      if (clean.user !== undefined) { clean.mailUser = clean.user; delete clean.user; }
      delete clean.authCode;
      if (!clean.to) delete clean.to;
    }
    if (safe === '/api/wechat/config') { delete clean.key; }  // 推送 Key 只在「登录微信」里提交
    if (safe === '/api/qq/config') { delete clean.key; }      // QQ Key 只在「登录 QQ」里提交
    if (Object.keys(clean).length) jobs.push(post(safe, clean));
  }
  if (!jobs.length) { setSaveBadge('ok'); return; }
  try { await Promise.all(jobs); setSaveBadge('ok'); }
  catch (e) { setSaveBadge('error', '保存失败'); console.warn('[SteamLens 自动保存]', e.message); }
}

/* 读取一个控件的当前值 */
function controlValue(el) {
  if (el.type === 'checkbox') return el.checked;
  return el.value;
}

/* 全局事件委托：任何输入 / 开关 / 下拉改动都自动保存 */
function handleControlChange(el) {
  if (RESTORING || !el || !el.id || DEMO) return;
  const id = el.id;
  const val = controlValue(el);

  // 1) 后台配置项
  const binding = CONFIG_BINDINGS.find(b => b[0] === id);
  if (binding) {
    let v = val;
    if (binding[3] === 'num') v = Number(v) || 0;
    if (binding[3] === 'bool') v = !!v;
    queueCfg(binding[1], binding[2], v, binding[3]);
  }

  // 2) 界面状态
  if (id === 'gameSearch') queueUi({ search: String(val) });
  else if (id === 'friendSearch') queueUi({ friendSearch: String(val) });
  else if (id === 'gameSort') queueUi({ sort: String(val) });
  else if (id === 'maskToggle' || id === 'exportMask') queueUi({ mask: !!val, exportMask: !!val });
  else if (id === 'friendAuto') queueUi({ friendAuto: !!val });
  else if (id === 'mailVerify') queueUi({ mailVerify: !!val });

  // 3) 非凭证输入框的草稿
  if (!SECRET_IDS.has(id)) queueUi({ draft: { [id]: String(val) } });
}

document.addEventListener('input', e => {
  if (!SAVE_IDS.has(e.target?.id)) return;
  handleControlChange(e.target);
});
document.addEventListener('change', e => {
  if (!SAVE_IDS.has(e.target?.id)) return;
  handleControlChange(e.target);
});

/* 页签、筛选、主题、模式这些不是标准控件，单独记录 */
function recordPage(page) { if (!RESTORING && !DEMO) queueUi({ page }); }
function recordTheme(t) { if (!RESTORING && !DEMO) queueUi({ theme: t }); }
function recordMode(m) { if (!RESTORING && !DEMO) queueUi({ mode: m }); }
function recordFilter(f, kind) { if (!RESTORING && !DEMO) queueUi(kind === 'friend' ? { friendFilter: f } : { filter: f }); }

/* ------------------------------ 全量回填 ------------------------------ */
function applyTheme(t, save = false) {
  const theme = t === 'dark' ? 'dark' : 'light';   // 白色为默认
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('sl-theme', theme); } catch {}
  if ($('#settingsHint')) $('#settingsHint').textContent = '当前主题：' + (theme === 'dark' ? '深色' : '白色');
  if (save) recordTheme(theme);
}

function restoreUiState(u) {
  if (!u) return;
  RESTORING = true;
  applyTheme(u.theme || 'light');
  MODE = u.mode === 'manual' ? 'manual' : 'auto';
  MASK = u.mask !== false;
  FILTER = u.filter || 'all';
  SORT = u.sort || 'playtime';
  SEARCH = u.search || '';
  FFILTER = u.friendFilter || 'all';
  FSEARCH = u.friendSearch || '';
  lastEventTs = Number(u.lastEventTs || 0) || lastEventTs;

  const draft = u.draft || {};
  const put = (id, val) => {
    /* 个性化开场视频开关以 localStorage 为唯一准绳：开发者开场动画启用时
       boot() 会把它清掉，界面草稿不能在这里把它又勾回来，否则「自动关掉」看不见。 */
    if (id === 'chkBootVideo') return;
    const el = $('#' + id); if (!el || val === undefined || val === null) return;
    if (el.type === 'checkbox') el.checked = (val === true || val === 'true' || val === '1' || val === 1);
    else el.value = String(val);
  };
  // 所有非凭证控件一次性回填（不只当前页）
  for (const id of SAVE_IDS) {
    if (SECRET_IDS.has(id)) continue;
    if (draft[id] !== undefined) put(id, draft[id]);
  }
  if (u.mask !== undefined) {
    if ($('#maskToggle')) $('#maskToggle').checked = MASK;
    if ($('#exportMask')) $('#exportMask').checked = u.exportMask !== false ? MASK : MASK;
  }
  if (u.exportMask !== undefined && $('#exportMask')) $('#exportMask').checked = !!u.exportMask;
  if (u.mailVerify !== undefined && $('#mailVerify')) $('#mailVerify').checked = !!u.mailVerify;
  if (u.friendAuto !== undefined && $('#friendAuto')) $('#friendAuto').checked = !!u.friendAuto;

  // 筛选 chip / 排序下拉 / 搜索框
  $$('#gameFilters .chip').forEach(x => x.classList.toggle('active', x.dataset.f === FILTER));
  $$('#friendFilters .chip').forEach(x => x.classList.toggle('active', x.dataset.f === FFILTER));
  if ($('#gameSort')) $('#gameSort').value = SORT;
  if ($('#gameSearch')) $('#gameSearch').value = SEARCH;
  if ($('#friendSearch')) $('#friendSearch').value = FSEARCH;
  setTimeout(() => { RESTORING = false; }, 120);
}

/* ==================================================================== */
/*  微信推送页                                                          */
/* ==================================================================== */
function fillWechat() {
  if (!WECHAT) return;
  RESTORING = true;
  if ($('#wChannel')) $('#wChannel').value = WECHAT.channel || 'serverchan';
  if ($('#wMinInterval')) $('#wMinInterval').value = WECHAT.minIntervalSec ?? 60;
  if ($('#wOnOnline')) $('#wOnOnline').checked = WECHAT.onOnline !== false;
  if ($('#wOnOffline')) $('#wOnOffline').checked = WECHAT.onOffline !== false;
  if ($('#wOnWishlist')) $('#wOnWishlist').checked = WECHAT.onWishlist !== false;
  if ($('#wEnabledWechat')) $('#wEnabledWechat').checked = WECHAT.enabled !== false && WECHAT.connected;
  if ($('#wKey')) {
    $('#wKey').value = '';
    $('#wKey').placeholder = WECHAT.keySet ? '已保存推送 Key · 留空表示不修改' : 'SendKey / token（不是微信密码）';
  }
  setTimeout(() => { RESTORING = false; }, 80);
}

function renderWechat() {
  const badge = $('#wechatStatusBadge'); if (!badge) return;
  const connected = !!WECHAT?.connected;
  badge.className = 'status-pill ' + (connected ? 'on' : '');
  badge.innerHTML = `<i></i>${connected ? '已绑定 · 永久保持' : '未绑定'}`;
  if ($('#wechatHint')) $('#wechatHint').textContent = connected
    ? `已绑定 ${WECHAT.channelName}（${WECHAT.keyMasked}）。${WECHAT.direction}`
    : '凭证保存在本机 config.json，长期有效、服务重启自动恢复 = 永久登录。';
  const ch = (WECHAT?.channels || []).find(c => c.id === (WECHAT?.channel || 'serverchan'));
  if ($('#wechatChannelHint')) $('#wechatChannelHint').textContent = ch ? ch.hint : '';
  if ($('#wechatQr')) $('#wechatQr').title = ch?.home || '扫码绑定';

  const hist = WECHAT?.history || [];
  if ($('#wechatHistoryTag')) $('#wechatHistoryTag').textContent = hist.length + ' 条';
  if ($('#wechatHistory')) $('#wechatHistory').innerHTML = hist.length
    ? hist.slice(0, 12).map(x => `<div class="mini-item"><div class="mi-main"><b>${esc(x.title)}</b>
        <small>${timeStr(x.iso)} · ${x.ok ? '已送达你的微信' : esc(x.reason || '未送达')}</small></div>
        <span class="mi-val ${x.ok ? 'up' : ''}">${x.ok ? '✓' : '—'}</span></div>`).join('')
    : '<div class="mini-empty">还没有推送记录。绑定后好友上线、愿望单降价都会自动发到你的微信。</div>';
  if ($('#wechatChannels')) $('#wechatChannels').innerHTML = (WECHAT?.channels || []).map(c =>
    `<div class="mini-item"><div class="mi-main"><b>${esc(c.name)}</b><small>${esc(c.home || '自定义地址')} · ${esc(c.hint)}</small></div></div>`).join('');
}

/* ==================================================================== */
/*  QQ 通知页                                                           */
/* ==================================================================== */
/* 通道切换联动：字段名 / 占位符 / 必填提示跟着变，切回 Qmsg 酱自动还原 */
const QQ_CHANNEL_UI = {
  qmsg: {
    keyLabel: 'Qmsg 酱 Key（不是 QQ 密码）',
    keyPlaceholder: '已绑定后留空表示沿用原来的 Key',
    endpointLabel: '机器人地址 / 自定义 Webhook（Qmsg 酱模式用不到）',
    endpointPlaceholder: '留空即可',
    hint: '在 qmsg.zendee.cn 用你自己的 QQ 扫码绑定后复制 Key，填到上面。消息只发给你自己的 QQ。',
    endpointRequired: false
  },
  onebot: {
    keyLabel: '机器人访问令牌 Token（可选，不是 QQ 密码）',
    keyPlaceholder: '机器人没设 access_token 就留空',
    endpointLabel: '本机 QQ 机器人 HTTP 地址（必填）',
    endpointPlaceholder: 'http://127.0.0.1:3000',
    hint: '本机跑 NapCat / Lagrange.OneBot 后填它的 HTTP 地址，再填接收消息的自己 QQ 号。这里绝对不需要、也不会收你的 QQ 密码。',
    endpointRequired: true,
    qr: 'assets/onebot-qr.png',
    qrTitle: '扫码查看 NapCat 部署文档',
    qrDesc: '本机 QQ 机器人模式：扫码看官方文档，在本机装好 NapCat / OneBot 后，把 HTTP 地址填到下面。二维码只指向文档，不含任何凭证。'
  },
  custom: {
    keyLabel: '自定义令牌（可选，不是 QQ 密码）',
    keyPlaceholder: '没有令牌就留空',
    endpointLabel: 'Webhook 完整 URL（必填）',
    endpointPlaceholder: 'https://… 接收 {title, body, text, qq} 的 JSON',
    hint: '这个 URL 怎么搞？三种最省事的做法：① 本机装 NapCat / Lagrange 这类 QQ 机器人，用它的 OneBot 地址（如 http://127.0.0.1:3000/send_private_msg），消息直接发到你自己的 QQ；② 自己搭一个能接收 POST(JSON) 的转发服务（任意能收 HTTP 请求的程序都行），把地址填这里；③ 自己搭任意能收 HTTP POST 的转发服务，把地址填这里。填好后点「发一条测试」验证送达。',
    endpointRequired: true,
    qr: '',
    qrTitle: '自定义 Webhook',
    qrDesc: '这个通道用的是你自己的服务地址，没有官方页可扫。把完整 URL 填到下面即可。'
  },
};
QQ_CHANNEL_UI.qmsg.qr = 'assets/qmsg-qr.png';
QQ_CHANNEL_UI.qmsg.qrTitle = '扫码打开 Qmsg 酱官网';
QQ_CHANNEL_UI.qmsg.qrDesc = '用<b>你自己的 QQ</b> 扫码登录官方页 → 复制 Key 填到下面。之后好友上线、愿望单降价/回涨会自动推到<b>你自己的 QQ</b>。';

function applyQqChannelUI(ch) {
  const ui = QQ_CHANNEL_UI[ch] || QQ_CHANNEL_UI.qmsg;
  const set = (id, txt) => { const el = $('#' + id); if (el) el.textContent = txt; };
  set('qKeyLabelText', ui.keyLabel);
  set('qEndpointLabelText', ui.endpointLabel);
  set('qChannelHint', ui.hint);
  const k = $('#qKey'), e = $('#qEndpoint');
  if (k) {
    // 已保存过 Key 时保留「留空沿用」提示，但标签始终随通道切换
    k.placeholder = (QQ?.keySet && ch === 'qmsg') ? '已保存推送 Key · 留空表示不修改' : ui.keyPlaceholder;
    k.type = ch === 'qmsg' ? 'password' : 'text';
  }
  if (e) {
    e.placeholder = ui.endpointPlaceholder;
    e.required = !!ui.endpointRequired;
  }
  const ep = $('#qEndpointLabel');
  if (ep) ep.style.opacity = ui.endpointRequired ? '1' : '.62';

  // 二维码与说明随通道切换
  const qr = $('#qqQr');
  if (qr) {
    if (ui.qr) { qr.src = assetUrl(ui.qr); qr.style.display = ''; qr.alt = ui.qrTitle; }
    else { qr.style.display = 'none'; }
  }
  const qt = $('#qqQrTitle'), qd = $('#qqQrDesc');
  if (qt) qt.textContent = ui.qrTitle;
  if (qd) qd.innerHTML = ui.qrDesc;
}

function fillQq() {
  const saved = (QQ?.channel && QQ.channel !== 'direct') ? QQ.channel : 'qmsg';
  RESTORING = true;
  const put = (id, v) => { const el = $('#' + id); if (el && v !== undefined) el.value = v; };
  put('qChannel', saved);
  // ★ 必须用完整 QQ 号回填：以前用打码值回填，自动保存会把掩码写回 config.json 导致永远发不出去
  put('qUin', QQ?.uinFull || '');
  put('qEndpoint', QQ?.endpoint || '');
  if ($('#qKey')) $('#qKey').value = '';
  if ($('#qOnOnline')) $('#qOnOnline').checked = QQ?.onOnline !== false;
  if ($('#qOnOffline')) $('#qOnOffline').checked = QQ?.onOffline !== false;
  if ($('#qOnWishlist')) $('#qOnWishlist').checked = QQ?.onWishlist !== false;
  if ($('#qEnabled')) $('#qEnabled').checked = QQ?.enabled !== false && !!QQ?.connected;
  applyQqChannelUI(saved);   // 重进后保持上次选的通道样式
  setTimeout(() => { RESTORING = false; }, 80);
}

/* 切换即时联动（同时由自动保存层把通道写入服务端，重启不丢） */
$('#qChannel')?.addEventListener('change', e => {
  applyQqChannelUI(e.target.value);
  const ch = QQ_CHANNEL_UI[e.target.value] || QQ_CHANNEL_UI.qmsg;
  $('#qqHint').textContent = ch.hint;
});

function renderQq() {
  const badge = $('#qqStatusBadge'); if (!badge) return;
  const connected = !!QQ?.connected;
  badge.className = 'status-pill ' + (connected ? 'on' : '');
  badge.innerHTML = `<i></i>${connected ? '已绑定 · 永久保持' : '未绑定'}`;
  if ($('#qqHint')) $('#qqHint').textContent = connected
    ? `已绑定 ${QQ.channelName}（${QQ.keyMasked || QQ.endpoint}）。${QQ.direction}`
    : '凭证保存在本机 config.json，长期有效、服务重启自动恢复 = 永久登录。';
  /* 「QQ 直接登录 · 自己发自己」已移除：通道对照里不再列出这个通道 */
  if ($('#qqChannelList')) $('#qqChannelList').innerHTML = (QQ?.channels || []).filter(c => c.id !== 'direct').map(c =>
    `<div class="mini-item"><div class="mi-main"><b>${esc(c.name)}</b><small>${esc(c.home || '自定义地址')} · ${esc(c.hint)}</small></div></div>`).join('');
  const diag = QQ?.diagnosis || [];
  if ($('#qqDiagnosis')) {
    $('#qqDiagnosis').innerHTML = diag.map(x =>
      `<div class="hdiag ${esc(x.level || 'ok')}">${esc(x.text || '')}</div>`).join('');
  }
  const hist = QQ?.history || [];
  if ($('#qqHistory')) $('#qqHistory').innerHTML = hist.length
    ? hist.slice(0, 8).map(x => `<div class="mini-item"><div class="mi-main"><b>${esc(x.title)}</b>
        <small>${timeStr(x.iso)} · ${x.ok ? '已送达你的 QQ' : esc(String(x.reason || '未送达').slice(0, 110))}${x.httpStatus ? ' · HTTP ' + esc(x.httpStatus) : ''}</small></div>
        <span class="mi-val ${x.ok ? 'up' : ''}">${x.ok ? '✓' : '—'}</span></div>`).join('')
    : '<div class="mini-empty">还没有推送记录。绑定后好友上线、愿望单降价会自动发到你的 QQ。</div>';
}

$('#btnQqLogin')?.addEventListener('click', async () => {
  if (DEMO) { toast('离线演示模式'); return; }
  const channel = $('#qChannel')?.value || 'qmsg';
  const endpoint = $('#qEndpoint')?.value || '';
  const uin = $('#qUin')?.value || '';
  if ((channel === 'onebot' || channel === 'custom') && !endpoint.trim()) { toast('请先填机器人 HTTP 地址 / Webhook URL'); return; }
  if (channel === 'onebot' && !uin.trim()) { toast('请填接收消息的自己 QQ 号'); return; }
  const btn = $('#btnQqLogin'); btn.disabled = true; btn.textContent = '正在绑定…';
  try {
    const r = await post('/api/qq/connect', {
      channel, key: $('#qKey')?.value || '', uin, endpoint,
      onOnline: $('#qOnOnline')?.checked, onOffline: $('#qOnOffline')?.checked,
      onWishlist: $('#qOnWishlist')?.checked, verify: true
    });
    QQ = r.status || QQ;
    if (r.blocked) toast('配置已保存，但未发送测试：' + (r.diagnosis?.find(x => x.level === 'error')?.text || '请先补全配置'));
    else toast(r.test?.ok ? '已绑定，测试消息已发到你的 QQ' : '已保存配置，测试未送达：' + (r.test?.reason || '未知原因'));
    fillQq(); renderQq();
  } catch (e) { toast('绑定失败：' + e.message); }
  finally { btn.disabled = false; btn.textContent = '登录 QQ'; }
});
$('#btnQqLogout')?.addEventListener('click', async () => {
  if (DEMO) return;
  try { const r = await post('/api/qq/disconnect'); QQ = r.status || QQ; fillQq(); renderQq(); toast('已退出 QQ 通知（本机 Key 已清除）'); }
  catch (e) { toast('退出失败：' + e.message); }
});
$('#btnQqTest')?.addEventListener('click', async () => {
  if (DEMO) return;
  const btn = $('#btnQqTest');
  if (btn?.disabled) return;   // 防连点：以前一次点击会连发好几条
  if (btn) { btn.disabled = true; btn.textContent = '发送中…'; }
  try {
    const r = await post('/api/qq/test');
    toast(r.ok ? '✓ 测试消息已送达到你的 QQ' : '未送达：' + (r.reason || '未知原因'));
    QQ = await api('/api/qq/status').catch(() => QQ);
    renderQq();
  } catch (e) { toast('测试失败：' + e.message); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '↗ 发一条测试'; } }
});

/* ==================================================================== */
/*  游戏详情弹窗（点击游戏 → 玩法 + 成就）                              */
/* ==================================================================== */
function fmtAchTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('zh-CN', {
      hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  } catch { return ''; }
}
let GD_CTX = { appid: '', name: '', friendId: '', refresh: false };

function renderGameDetail(d, appid, owner) {
  $('#gdName').textContent = d.name || ('AppID ' + appid);
  $('#gdAppid').textContent = 'AppID ' + appid + (d.gameplayPermanent ? ' · 玩法已永久保存' : '') + (owner ? ' · 好友成就' : ' · 我的成就');
  $('#gdGameplay').textContent = d.gameplay || '（本机 Steam 文件里没有玩法介绍，也还没搜到；联网搜到后会自动存成永久内容）';
  const c = $('#gdCover');
  if (c) {
    /* 本机没有封面文件时也给出 Steam 商店封面；离线单文件里 /api/ 路径不可用，直接走 CDN */
    const offMode = DEMO || (OFF && !OFF.online);
    let src = d.headerImage || steamCdn(appid);
    if (offMode && /^\/api\//.test(src)) src = steamCdn(appid);
    c.removeAttribute('data-stage');
    if (offMode) c.removeAttribute('data-local');
    else c.setAttribute('data-local', `/api/game/cover?appid=${appid}`);
    c.setAttribute('onerror', 'slCoverFallback(this)');
    c.src = src;
    c.style.visibility = 'visible';
  }
  $('#gdSource').textContent = d.source || '';
  const own = $('#gdOwner');
  if (own) {
    /* 不点好友时明确标成「我的成就」，避免和好友成就混淆 */
    own.hidden = false;
    own.textContent = owner ? '👤 ' + owner + ' 的成就' : '🎮 我的成就';
    own.classList.toggle('is-friend', !!owner);
  }
  const ach = d.achievements || [];
  const total = d.achievementTotal != null ? d.achievementTotal : ach.length;
  const got = d.achievementUnlocked != null ? d.achievementUnlocked : ach.filter(a => a.unlocked).length;
  const head = document.querySelector('.gd-ach-head');
  if (head) head.innerHTML = (owner
    ? `成就（${esc(owner)} · Steam 社区）`
    : (d.achievementFromStore ? '成就（Steam 商店公开 · 本机未解锁）' : '成就（我自己的 · Steam 本地文件）'))
    + `<span class="gd-summary">${total ? `${got} / ${total} 已解锁` : (owner ? '未读到成就' : '暂无成就数据')}</span>`;
  $('#gdAchievements').innerHTML = ach.length
    ? ach.map(a => `<div class="mini-item gd-ach ${a.unlocked ? 'is-unlocked' : 'is-locked'}">
        <div class="gd-ach-ico">${a.icon && /^https?:\/\//.test(a.icon) ? `<img src="${esc(a.icon)}" onerror="this.remove()">` : '🏆'}</div>
        <div class="mi-main"><b>${esc(a.name)}</b><small>${esc(a.desc || (a.hidden ? '（隐藏成就）' : '—'))}</small></div>
        <div class="gd-ach-state ${a.unlocked ? 'ok' : ''}">${a.unlocked ? '✓ 已解锁' : '未解锁'}${a.unlockedIso ? `<br>${esc(fmtAchTime(a.unlockedIso))}` : ''}</div>
      </div>`).join('')
    : `<div class="mini-empty">${esc(owner
        ? (d.achievementSource || 'Steam 上没有公开这个游戏的成就。')
        : (d.achievementSource || '本机未找到该游戏的成就文件')
          + '。已下载安装的游戏显示「我的成就」解锁记录；愿望单 / 未下载的游戏显示 Steam 商店公开成就（均未解锁）。')}</div>`;
  const sub = $('#gdGameplaySub');
  if (sub) sub.textContent = d.gameplaySource ? `来源：${d.gameplaySource} · 已固定，以后打开都是这段` : '';
  const asub = $('#gdAchSub');
  if (asub) asub.textContent = d.achievementSource || '';
  const hint = $('#gdAchHint');
  if (hint) {
    const mine = (owner && d._myTotal) ? `我自己的：${d._myUnlocked || 0} / ${d._myTotal} 已解锁（对比）` : '';
    const when = d.fetchedAtIso ? '抓取于 ' + fmtAchTime(d.fetchedAtIso) : '';
    hint.textContent = [mine, when].filter(Boolean).join(' · ');
  }
  const btn = $('#btnGdRefreshAch');
  if (btn) btn.hidden = !owner || !!(DEMO || (OFF && OFF.online === false));
}

/** 把「玩法」(本机永久缓存) 和「某好友的成就」(Steam 社区) 合成弹窗数据 */
function mergeFriendDetail(base, fa, friendId) {
  // 有些旧缓存没有 ok 字段但成就列表是完整的，一样要显示出来
  const ok = !!(fa && (fa.ok || (Array.isArray(fa.achievements) && fa.achievements.length)));
  return {
    ...base,
    achievements: ok ? (fa.achievements || []) : [],
    achievementTotal: ok ? (fa.achievementTotal || 0) : 0,
    achievementUnlocked: ok ? (fa.achievementUnlocked || 0) : 0,
    achievementSource: (fa && fa.achievementSource) || 'Steam 未返回成就（档案可能私密，或该游戏没有成就）。',
    ownerName: (fa && fa.ownerName) || friendId,
    fetchedAtIso: fa && fa.fetchedAtIso,
    cached: !!(fa && fa.cached),
    _myTotal: base.achievementTotal || 0,
    _myUnlocked: base.achievementUnlocked || 0
  };
}

async function openGameDetail(appid, name, friendId, refresh = false) {
  const mask = $('#gameDetailMask'); if (!mask) return;
  const fid = /^7656119\d{10}$/.test(String(friendId || '')) ? String(friendId) : '';
  GD_CTX = { appid, name: name || '', friendId: fid, refresh: !!refresh };
  mask.hidden = false;
  $('#gdName').textContent = name || '加载中…';
  $('#gdAppid').textContent = 'AppID ' + appid;
  $('#gdGameplay').textContent = fid ? '正在读取已保存的玩法与该好友的 Steam 成就…' : '正在读取 Steam 本地成就文件与已保存的玩法…';
  $('#gdAchievements').innerHTML = '<div class="mini-empty">加载中…</div>';
  const c = $('#gdCover'); if (c) { c.style.visibility = 'hidden'; c.removeAttribute('src'); }
  $('#gdSource').textContent = '';
  const offMode = DEMO || (OFF && OFF.online === false);
  const snap = OFF && OFF.snapshot ? OFF.snapshot() : (window.SL_OFFLINE_DATA || null);
  // 离线：全部读快照里固化的数据，不发网络请求
  if (offMode) {
    const base = (snap && snap.gameDetails ? snap.gameDetails[String(appid)] : null)
      || { name, achievements: [], achievementTotal: 0, achievementUnlocked: 0 };
    if (fid) {
      const fa = snap && snap.friendAchievements ? snap.friendAchievements[fid + ':' + appid] : null;
      renderGameDetail(mergeFriendDetail(base, fa, fid), appid, (fa && fa.ownerName) || fid);
    } else renderGameDetail(base, appid, '');
    return;
  }
  try {
    const baseP = api('/api/game/detail?appid=' + encodeURIComponent(appid) + (name ? '&name=' + encodeURIComponent(name) : ''))
      .catch(() => ({ name, achievements: [], achievementTotal: 0, achievementUnlocked: 0 }));
    const faP = fid
      ? api('/api/friend/achievements?steamId64=' + encodeURIComponent(fid) + '&appid=' + encodeURIComponent(appid)
          + (name ? '&name=' + encodeURIComponent(name) : '') + (refresh ? '&refresh=1' : ''))
        .catch(e => ({ ok: false, achievementSource: '读取失败：' + e.message }))
      : Promise.resolve(null);
    const [base, fa] = await Promise.all([baseP, faP]);
    if (fid) {
      renderGameDetail(mergeFriendDetail(base, fa, fid), appid, (fa && fa.ownerName) || fid);
      // 抓回来后同步刷新好友列表 / 档案里的「他有什么成就」
      setTimeout(loadFriendAch, 400);
    } else renderGameDetail(base, appid, '');
    renderGameDetailSysReq(appid, name, false);
  } catch (e) {
    $('#gdGameplay').textContent = '读取失败：' + e.message;
    $('#gdAchievements').innerHTML = '<div class="mini-empty">无法读取成就数据。</div>';
  }
}
function closeGameDetail() { const m = $('#gameDetailMask'); if (m) m.hidden = true; }
/** 游戏详情弹窗的系统需求：拉 /api/game/sysreq（服务端已算好对比），填充最低/推荐列 + 逐项对比表 */
async function renderGameDetailSysReq(appid, name, refreshPc) {
  const verdict = $('#gdSysreqVerdict'), minU = $('#gdReqMin'), recU = $('#gdReqRec'),
        cmp = $('#gdSysreqCompare'), pcEl = $('#gdSysreqPc');
  if (!verdict) return;
  verdict.innerHTML = '<span class="fine">正在检测你的电脑并对比…</span>';
  if (minU) minU.innerHTML = '<li class="fine">—</li>';
  if (recU) recU.innerHTML = '<li class="fine">—</li>';
  if (cmp) cmp.innerHTML = '';
  if (pcEl) pcEl.textContent = '';
  try {
    const r = await api('/api/game/sysreq?appid=' + encodeURIComponent(appid) + '&name=' + encodeURIComponent(name || '') + (refreshPc ? '&refresh=1' : ''));
    const x = sysCompareInner(r);
    verdict.innerHTML = x.verdictHtml || '<span class="fine">无系统需求数据</span>';
    if (minU) minU.innerHTML = x.minHtml;
    if (recU) recU.innerHTML = x.recHtml;
    if (cmp) cmp.innerHTML = x.compareHtml;
    if (pcEl) pcEl.textContent = x.pcText;
  } catch (e) {
    verdict.innerHTML = '<span class="fine">对比失败：' + esc(e.message) + '</span>';
  }
}
// 点击游戏行 / 好友库中游戏 → 弹窗（好友库会带上该好友的 SteamID64）
document.addEventListener('click', (e) => {
  if (e.target.closest('.link-btn')) return;
  if (!e.target.closest('#gameDetailMask')) {
    const row = e.target.closest('[data-appid]');
    if (row) openGameDetail(row.getAttribute('data-appid'), row.getAttribute('data-name') || '', row.getAttribute('data-friend') || '');
  }
});
$('#gameDetailClose')?.addEventListener('click', closeGameDetail);
$('#btnGdDetect')?.addEventListener('click', () => { if (GD_CTX && GD_CTX.appid) renderGameDetailSysReq(GD_CTX.appid, GD_CTX.name, true); });
$('#gameDetailMask')?.addEventListener('click', (e) => { if (e.target.id === 'gameDetailMask') closeGameDetail(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeGameDetail(); });
$('#btnGdRefreshAch')?.addEventListener('click', () => {
  if (!GD_CTX.friendId) return;
  const b = $('#btnGdRefreshAch');
  if (b) { b.disabled = true; b.textContent = '正在从 Steam 读取…'; }
  openGameDetail(GD_CTX.appid, GD_CTX.name, GD_CTX.friendId, true).finally(() => {
    if (b) { b.disabled = false; b.textContent = '⟳ 重新从 Steam 读取'; }
  });
});

/* ==================================================================== */
/*  他有什么成就：把 Steam 抓到的成就名称 / 说明 / 解锁时间直接列出来     */
/*  数据来自 friendAchievements 缓存（在线读 API，离线读快照），不藏弹窗  */
/* ==================================================================== */
function friendAchList(id) {
  const key = String(id || '');
  const out = [];
  for (const [k, v] of Object.entries(FRIEND_ACH || {})) {
    if (!k.startsWith(key + ':') || !v || !Array.isArray(v.achievements)) continue;
    const appid = String(v.appid || k.split(':')[1] || '');
    const gameName = v.appName || v.name || ('AppID ' + appid);
    for (const a of v.achievements) {
      out.push({ ...a, appid, gameName, ownerName: v.ownerName || '', fetchedAtIso: v.fetchedAtIso || '' });
    }
  }
  return out;
}
function friendAchGroups(id) {
  const all = friendAchList(id);
  const map = new Map();
  for (const a of all) {
    if (!map.has(a.appid)) map.set(a.appid, { appid: a.appid, name: a.gameName, items: [] });
    map.get(a.appid).items.push(a);
  }
  const groups = [...map.values()];
  for (const g of groups) g.items.sort((a, b) => (a.unlocked === b.unlocked ? 0 : (a.unlocked ? -1 : 1)));
  groups.sort((a, b) => b.items.filter(x => x.unlocked).length - a.items.filter(x => x.unlocked).length
    || String(a.name).localeCompare(String(b.name), 'zh-CN'));
  return { groups, all };
}
/** 好友卡片上的一行摘要：直接写出他解锁了哪些成就 */
function friendAchBrief(id) {
  const { groups, all } = friendAchGroups(id);
  if (!all.length) return '<span class="f-meta fp-ach-brief">🏆 成就：尚未读取（在下方「好友关系链」选一款游戏点「读取成就」）</span>';
  const got = all.filter(a => a.unlocked);
  const picks = (got.length ? got : all).slice(0, 4).map(a => a.name).join('、');
  const rest = ((got.length ? got : all).length > 4) ? ' …' : '';
  return `<span class="f-meta fp-ach-brief">🏆 <b>${got.length} / ${all.length}</b> 已解锁 · ${groups.length} 款游戏${picks ? ' · ' + esc(picks) + rest : ''}</span>`;
}
/** 好友档案里的「他的成就」区块 */
function friendAchBlock(id) {
  const { groups, all } = friendAchGroups(id);
  if (!all.length) {
    return `<div class="fa-inline"><div class="card-head"><h2 style="font-size:12px">他的成就</h2>
      <button class="btn ghost tiny" data-fa-open="${esc(id)}">去读取 →</button></div>
      <p class="fine">还没有从 Steam 读取过他的成就。点「去读取」后选一款游戏即可把成就名称列出来。</p></div>`;
  }
  const got = all.filter(a => a.unlocked);
  const chips = (got.length ? got : all).slice(0, 12).map(a =>
    `<span class="fa-chip ${a.unlocked ? 'ok' : ''}">${esc(a.name || a.key || '未命名成就')}${a.unlockedIso ? ' · ' + esc(fmtAchTime(a.unlockedIso)) : ''}</span>`).join('');
  const perGame = groups.map(g => `${esc(g.name)} ${g.items.filter(x => x.unlocked).length}/${g.items.length}`).join(' · ');
  return `<div class="fa-inline"><div class="card-head"><h2 style="font-size:12px">他的成就 · ${got.length} / ${all.length} 已解锁</h2>
      <button class="btn ghost tiny" data-fa-open="${esc(id)}">查看全部成就 →</button></div>
    <div class="fa-chips">${chips}</div><p class="fine">${perGame}</p></div>`;
}
function faRowHtml(a) {
  const offline = DEMO || (OFF && OFF.online === false);
  const icon = (!offline && a.icon && /^https?:\/\//.test(a.icon))
    ? `<img src="${esc(a.icon)}" onerror="this.remove()">` : '🏆';
  return `<div class="fa-row ${a.unlocked ? 'is-unlocked' : 'is-locked'}">
      <div class="fa-ico">${icon}</div>
      <div class="mi-main"><b>${esc(a.name || a.key || '未命名成就')}</b>
        <small>${esc(a.desc || (a.hidden ? '（隐藏成就）' : '—'))}</small></div>
      <div class="fa-state ${a.unlocked ? 'ok' : ''}">${a.unlocked ? '✓ 已解锁' : '未解锁'}${a.unlockedIso ? '<br>' + esc(fmtAchTime(a.unlockedIso)) : ''}</div>
    </div>`;
}
function renderFaPanel() {
  const panel = $('#friendAchPanel');
  if (!panel) return;
  if (!FA_SEL.id) { panel.hidden = true; return; }
  panel.hidden = false;
  const { groups, all } = friendAchGroups(FA_SEL.id);
  const got = all.filter(a => a.unlocked);
  const t = $('#faPanelTitle'); if (t) t.textContent = `${FA_SEL.name} 有什么成就`;
  const tag = $('#faPanelTag'); if (tag) tag.textContent = `${got.length} / ${all.length} 已解锁 · ${groups.length} 款游戏`;
  const note = $('#faPanelNote');
  if (note) note.textContent = all.length
    ? '成就名称、说明与解锁时间来自 Steam 社区公开成就页，已永久写进本机缓存；离线版也能看到。'
    : '还没有从 Steam 读取过他的成就：先在上面选一款游戏（或填 AppID），再点「读取所选游戏的成就」。';
  const only = !!$('#faOnlyUnlocked')?.checked;
  const shown = groups.map(g => ({ ...g, items: only ? g.items.filter(a => a.unlocked) : g.items })).filter(g => g.items.length);
  const box = $('#faPanelBody'); if (!box) return;
  box.innerHTML = shown.length ? shown.map(g => `
    <div class="fa-game">
      <div class="fa-game-head"><b>${esc(g.name)}</b>
        <span class="tag">${g.items.filter(a => a.unlocked).length} / ${g.items.length} 已解锁</span>
        <span class="fine">AppID ${esc(g.appid)}</span>
        <button class="btn ghost tiny" data-fa-refresh-game="${esc(g.appid)}">⟳ 重新读取</button></div>
      <div class="fa-list">${g.items.map(faRowHtml).join('')}</div>
    </div>`).join('')
    : `<div class="mini-empty">${only
        ? '他还没有已解锁的成就。取消「只看已解锁」可以看这款游戏的完整成就清单。'
        : '还没有成就数据，点上面「读取所选游戏的成就」从 Steam 抓取并永久保存。'}</div>`;
}
function openFaPanel(id, name) {
  FA_SEL = { id: String(id || ''), name: String(name || id || '') };
  const nav = document.querySelector('.nav-item[data-page="friends"]');
  if (nav && document.querySelector('#page-friends')?.hidden) nav.click();
  renderFaPanel();
  setTimeout(() => $('#friendAchPanel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60);
}
async function loadFriendAch() {
  const offMode = DEMO || (OFF && OFF.online === false);
  if (!offMode) {
    try { const r = await api('/api/friend/achievements/all'); FRIEND_ACH = r.items || {}; } catch { /* 回退快照 */ }
  }
  if (!FRIEND_ACH) {
    const snap = OFF && OFF.snapshot ? OFF.snapshot() : (window.SL_OFFLINE_DATA || null);
    FRIEND_ACH = (snap && snap.friendAchievements) || {};
  }
  renderFaPanel();
  if (DISCOVER) renderDiscover();
  // 好友卡片上的成就摘要也要跟着刷新（首次读到数据时补上）
  if (F && F.friends) renderFriends();
  // 档案详情每秒会自己重绘；这里只在它已加载时顺手补一次成就区块
  if (FP_ACTIVE_ID && typeof FP_ACTIVE !== 'undefined' && FP_ACTIVE) renderFriendProfileDetail(FP_ACTIVE);
}
/** 抓一个人的某一款游戏成就，并立刻把列表刷出来 */
async function fetchFriendAchOne(appid, refresh) {
  if (!FA_SEL.id || !/^\d+$/.test(String(appid || ''))) return { ok: false, error: 'AppID 不正确' };
  if (DEMO || (OFF && OFF.online === false)) return { ok: false, error: '离线版只能看已保存的成就，联网后可刷新' };
  const sel = $('#discoverGame');
  let gname = '';
  if (sel && String(sel.value) === String(appid)) gname = sel.options[sel.selectedIndex]?.text || '';
  try {
    const r = await api('/api/friend/achievements?steamId64=' + encodeURIComponent(FA_SEL.id)
      + '&appid=' + encodeURIComponent(appid) + (gname ? '&name=' + encodeURIComponent(gname) : '')
      + (refresh ? '&refresh=1' : ''));
    await loadFriendAch();
    return { ok: !!r.ok, total: r.achievementTotal || 0, unlocked: r.achievementUnlocked || 0, reason: r.achievementSource || '' };
  } catch (e) { return { ok: false, error: e.message }; }
}

/* ------------------------------------------------------------------ */
/*  好友关系链：直接好友 + 朋友的朋友，读取他们在 Steam 上的成就        */
/* ------------------------------------------------------------------ */
let DISCOVER = null;
function discoverGames() {
  if (S && Array.isArray(S.games) && S.games.length) return S.games.map(g => ({ appid: g.appid, name: g.name }));
  const cd = CACHE && Array.isArray(CACHE.gameDetails) ? CACHE.gameDetails : [];
  return cd.map(g => ({ appid: g.appid, name: g.name }));
}
function fillDiscoverGames() {
  const sel = $('#discoverGame'); if (!sel) return;
  const cur = sel.value;
  const opts = discoverGames();
  sel.innerHTML = '<option value="">选一款本机游戏…</option>'
    + opts.map(g => `<option value="${esc(g.appid)}">${esc(g.name || g.appid)}</option>`).join('');
  if (cur && opts.some(g => String(g.appid) === cur)) sel.value = cur;
}
function currentDiscoverAppid() {
  const manual = String($('#discoverAppid')?.value || '').trim();
  if (/^\d+$/.test(manual)) return manual;
  return String($('#discoverGame')?.value || '');
}
function renderDiscover() {
  const box = $('#discoverFriendsList'); if (!box) return;
  const all = [...(DISCOVER?.direct || []), ...(DISCOVER?.extended || [])];
  const tag = $('#discoverTag');
  if (tag) tag.textContent = DISCOVER?.ok
    ? `直接好友 ${DISCOVER.direct?.length || 0} · 朋友的朋友 ${DISCOVER.extended?.length || 0}`
    : '未扫描';
  const note = $('#discoverNote');
  if (note) {
    const extra = (DISCOVER?.scanNotes || []).slice(0, 2).join('；');
    note.textContent = DISCOVER?.generatedAtIso
      ? `上次扫描：${fmtAchTime(DISCOVER.generatedAtIso)} · ${DISCOVER.source || ''}${[DISCOVER.note, extra].filter(Boolean).join('；') ? ' · ' + [DISCOVER.note, extra].filter(Boolean).join('；') : ''}`
      : '尚未扫描。点「从 Steam 重新发现」读取好友关系链（只读公开页面）。';
  }
  const shown = slShown(all, 'discover', 5);
  box.innerHTML = all.length ? shown.map(p => {
    const { groups, all: ach } = friendAchGroups(p.steamId64);
    const got = ach.filter(a => a.unlocked);
    const names = (got.length ? got : ach).slice(0, 6).map(a => a.name).join('、');
    const brief = ach.length
      ? `🏆 <b>${got.length} / ${ach.length}</b> 已解锁 · ${groups.length} 款游戏${names ? ' · ' + esc(names) + ((got.length || ach.length) > 6 ? ' …' : '') : ''}`
      : '🏆 还没读取他的成就 · 选一款游戏后点「读取成就」';
    return `
    <div class="mini-item discover-row">
      <div class="mi-main"><b>${esc(p.name || p.steamId64)} <span class="mini-tag">${p.level === 2 ? '朋友的朋友' : '直接好友'}</span></b>
        <small>${esc(p.steamId64)} · ${esc(p.state || '状态未知')}${p.level === 2 ? ' · 经 ' + esc(p.viaName || '好友') + ' 发现' : ''}</small>
        <small class="fa-brief">${brief}</small></div>
      <div class="discover-actions">
        <button class="btn primary tiny" data-disc-ach="${esc(p.steamId64)}" data-disc-name="${esc(p.name || '')}">他有什么成就</button>
        <button class="btn ghost tiny" data-disc-game="${esc(p.steamId64)}">玩法+弹窗</button>
        <button class="btn ghost tiny" data-disc-add="${esc(p.steamId64)}" data-disc-name="${esc(p.name || '')}">加入名册</button>
      </div>
    </div>`;
  }).join('') + slMoreBtn('discover', all.length, 5, '显示更多好友')
    : '<div class="mini-empty">还没有发现好友。点上面的「从 Steam 重新发现」；若对方好友列表设为私密，Steam 不会公开关系链。</div>';
}
async function loadDiscover(refresh = false) {
  const offMode = DEMO || (OFF && OFF.online === false);
  if (offMode) {
    const snap = OFF && OFF.snapshot ? OFF.snapshot() : (window.SL_OFFLINE_DATA || null);
    DISCOVER = snap?.discoveredFriends || null;
  } else {
    try {
      const depth = $('#discoverDepth')?.checked === false ? '0' : '1';
      const path = refresh ? `/api/friend/discover?depth=${depth}&refresh=1` : '/api/friend/discover/cached';
      DISCOVER = await api(path);
    } catch (e) { DISCOVER = { ok: false, note: '读取失败：' + e.message, direct: [], extended: [] }; }
  }
  fillDiscoverGames();
  renderDiscover();
}
$('#btnDiscoverFriends')?.addEventListener('click', async () => {
  const b = $('#btnDiscoverFriends');
  if (b) { b.disabled = true; b.textContent = '正在自动扫描…'; }
  try {
    /* 服务端直连 Steam 社区不带登录态，扫不到公开好友。改由已登录网页端自动巡航采集，
       这里只触发巡航 + 立刻用本机缓存刷新，不再发那个必然失败的网络请求。 */
    await post('/api/friend/fof/auto', { enabled: true, rescan: true }).catch(() => {});
    await loadDiscover(false);
    toast('已启动自动扫描：网页端会依次打开好友列表页和游戏库页，列表每秒刷新');
  } catch (e) { toast('启动自动扫描失败：' + e.message); }
  if (b) { b.disabled = false; b.textContent = '⟳ 立即自动扫描（网页端）'; }
});
$('#discoverGame')?.addEventListener('change', () => { const i = $('#discoverAppid'); if (i) i.value = ''; });
$('#discoverGame')?.addEventListener('focus', fillDiscoverGames);
document.addEventListener('click', async (e) => {
  const ach = e.target.closest('[data-disc-ach]');
  if (ach) {
    const list = [...(DISCOVER?.direct || []), ...(DISCOVER?.extended || [])];
    const p = list.find(x => String(x.steamId64) === ach.getAttribute('data-disc-ach'));
    openFaPanel(ach.getAttribute('data-disc-ach'), ach.getAttribute('data-disc-name') || p?.name || '这位好友');
    return;
  }
  const oneGame = e.target.closest('[data-disc-game]');
  if (oneGame) {
    const appid = currentDiscoverAppid();
    if (!appid) { toast('请先选一款游戏，或填一个 AppID（例如 730）'); return; }
    const sel = $('#discoverGame');
    const gname = sel && sel.value ? (sel.options[sel.selectedIndex]?.text || '') : '';
    openGameDetail(appid, gname, oneGame.getAttribute('data-disc-game'));
    setTimeout(loadFriendAch, 1200);
    return;
  }
  const faOpen = e.target.closest('[data-fa-open]');
  if (faOpen) {
    const id = faOpen.getAttribute('data-fa-open');
    const friend = (F?.friends || []).find(x => String(x.steamId64) === String(id));
    openFaPanel(id, friend?.name || FA_SEL.name || id);
    return;
  }
  const faGame = e.target.closest('[data-fa-refresh-game]');
  if (faGame) {
    const b = faGame; b.disabled = true; b.textContent = '读取中…';
    const r = await fetchFriendAchOne(faGame.getAttribute('data-fa-refresh-game'), true);
    b.disabled = false; b.textContent = '⟳ 重新读取';
    toast(r.ok ? `✓ 已更新 ${r.total} 条成就（${r.unlocked} 条已解锁）` : ('读取失败：' + (r.reason || r.error || '')));
    return;
  }
  const add = e.target.closest('[data-disc-add]');
  if (add) {
    try {
      await post('/api/friend/discover/add', { steamId64: add.getAttribute('data-disc-add'), name: add.getAttribute('data-disc-name') || '' });
      toast('已加入好友名册');
      F = await api('/api/friends'); renderFriends();
    } catch (err) { toast('加入失败：' + err.message); }
  }
});
$('#faOnlyUnlocked')?.addEventListener('change', renderFaPanel);
$('#btnFaClose')?.addEventListener('click', () => { FA_SEL = { id: '', name: '' }; renderFaPanel(); });
$('#btnFaReadCurrent')?.addEventListener('click', async () => {
  const appid = currentDiscoverAppid();
  if (!FA_SEL.id) { toast('请先点某位好友的「他有什么成就」'); return; }
  if (!appid) { toast('请先选一款游戏，或填一个 AppID（例如 730）'); return; }
  const b = $('#btnFaReadCurrent'); if (b) { b.disabled = true; b.textContent = '正在从 Steam 读取…'; }
  const r = await fetchFriendAchOne(appid, true);
  if (b) { b.disabled = false; b.textContent = '⟳ 读取所选游戏的成就'; }
  toast(r.ok ? `✓ 读到 ${r.total} 条成就（${r.unlocked} 条已解锁），已列在上面` : ('读取失败：' + (r.reason || r.error || '')));
});
$('#btnFaRefreshAll')?.addEventListener('click', async () => {
  if (!FA_SEL.id) { toast('请先点某位好友的「他有什么成就」'); return; }
  const { groups } = friendAchGroups(FA_SEL.id);
  const extra = currentDiscoverAppid();
  const ids = [...new Set([...groups.map(g => g.appid), ...(extra ? [extra] : [])])];
  if (!ids.length) { toast('没有可刷新的游戏，先选一款游戏再点「读取所选游戏的成就」'); return; }
  const b = $('#btnFaRefreshAll'); if (b) { b.disabled = true; b.textContent = '正在刷新…'; }
  let ok = 0, total = 0;
  for (const appid of ids) { const r = await fetchFriendAchOne(appid, true); if (r.ok) { ok++; total += r.total || 0; } }
  if (b) { b.disabled = false; b.textContent = '↻ 刷新他全部成就'; }
  toast(`已刷新 ${ok} / ${ids.length} 款游戏，共 ${total} 条成就`);
});
setTimeout(() => loadFriendAch(), 1200);
setInterval(loadFriendAch, 60000);
setTimeout(() => loadDiscover(false), 1400);

/* ==================================================================== */
/*  朋友的朋友：游玩时长 + 什么时候玩了哪款游戏                          */
/* ==================================================================== */
let PT = null, FPT = null, FPT_SEL = { id: '', name: '' };

async function loadPlaytimeSummary() {
  if (DEMO || (OFF && OFF.online === false)) {
    PT = { ok: false, people: [], stats: {}, count: 0 };
  } else {
    try { PT = await api('/api/friend/playtime'); }
    catch (e) { PT = { ok: false, people: [], stats: {}, count: 0, note: '读取失败：' + e.message }; }
  }
  renderPlaytimeSummary();
}
function renderPlaytimeSummary() {
  const box = $('#ptList'); if (!box) return;
  const onlyFof = $('#ptOnlyFof')?.checked === true;
  const people = (PT?.people || []).filter(p => !onlyFof || p.level === 2);
  const st = PT?.stats || {};
  if ($('#ptTag')) $('#ptTag').textContent = PT?.generatedAtIso
    ? `已读 ${PT.scannedCount || 0} 人 · 朋友的朋友 ${PT.extendedCount || 0}` : '未扫描';
  const keyHint = PT?.keyHint || '';
  if ($('#ptNote')) $('#ptNote').textContent =
    (keyHint ? '⚠️ ' + keyHint + '  ' : '') + (PT?.generatedAtIso
      ? `上次扫描：${fmtAchTime(PT.generatedAtIso)} · ${PT.hasKey ? 'Steam Web API（含最后游玩时间）' : 'Steam 社区公开页（不含最后游玩时间）'} · 关系链共 ${PT.count || 0} 人`
      : (PT?.note || '还没扫描。先点上方「从 Steam 重新发现」拿到关系链，再点「扫描关系链游玩时长」。'));
  if ($('#ptKpi')) $('#ptKpi').innerHTML =
    kpi('关系链总时长', (st.totalHours || 0) + ' h', '', `${PT?.count || 0} 人合计`, 'rgba(47,109,246,.16)', '◷') +
    kpi('近两周合计', (st.recent2wHours || 0) + ' h', '', '关系链所有人', 'rgba(16,179,156,.16)', '↗') +
    kpi('朋友的朋友', (st.extendedHours || 0) + ' h', '', `${st.extendedCount || 0} 人 · 二度关系`, 'rgba(122,99,245,.16)', '👥');
  const shown = slShown(people, 'ptPeople', 5);
  box.innerHTML = people.length ? shown.map(p => `<div class="mini-item pt-row">
      <div class="mi-main"><b>${esc(p.name || p.steamId64)} <span class="pt-pill ${p.level === 2 ? 'fof' : ''}">${p.level === 2 ? '朋友的朋友' : '直接好友'}</span></b>
        <small>${esc(p.steamId64)}${p.viaName ? ' · 经 ' + esc(p.viaName) + ' 发现' : ''}${p.private ? ' · 资料私密' : ''}${p.notScanned ? ' · 未读取时长' : ''}</small>
        <div class="pt-line"><span>累计 <b>${p.totalHours || 0} h</b></span><span>近两周 <b>${p.recent2wHours || 0} h</b></span>
          <span>玩过 <b>${p.playedGames || 0}</b> / ${p.games || 0} 款</span>${p.lastPlayedLabel ? `<span>最后玩 <b>${esc(p.lastPlayedLabel)}</b></span>` : ''}</div></div>
      <div class="discover-actions"><button class="btn primary tiny" data-pt-open="${esc(p.steamId64)}" data-pt-name="${esc(p.name || '')}">看明细</button></div>
    </div>`).join('') + slMoreBtn('ptPeople', people.length, 5, '显示更多好友')
    : '<div class="mini-empty">还没有游玩时长数据。点「扫描关系链游玩时长」即可读取（对方资料私密时会标注）。</div>';
}

async function openFpt(id, name, refresh = false) {
  FPT_SEL = { id: String(id), name: name || '' };
  const panel = $('#friendPlaytimePanel'); if (panel) panel.hidden = false;
  if ($('#fptTitle')) $('#fptTitle').textContent = `${name || id} · 游玩时长与记录`;
  if ($('#fptBody')) $('#fptBody').innerHTML = '<div class="mini-empty">正在读取 Steam…</div>';
  try {
    FPT = await api(`/api/friend/playtime/detail?steamId64=${encodeURIComponent(id)}${refresh ? '&refresh=1' : ''}`);
  } catch (e) { FPT = { ok: false, name: name || id, reason: '读取失败：' + e.message, games: [], timeline: [], totals: {} }; }
  renderFpt();
  if (panel && !panel.hidden) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function renderFpt() {
  const d = FPT || {}, body = $('#fptBody'); if (!body) return;
  const t = d.totals || {};
  if ($('#fptTitle')) $('#fptTitle').textContent = `${d.name || FPT_SEL.name || FPT_SEL.id} · 游玩时长与记录`;
  if ($('#fptTag')) $('#fptTag').textContent = d.private ? '资料私密' : `${t.playedGames || 0} 款玩过 / 累计 ${t.totalHours || 0} h`;
  if ($('#fptNote')) $('#fptNote').textContent = d.private
    ? (d.reason || 'Steam 不公开这个人的游戏库。')
    : `${d.source || ''} · 读取于 ${d.fetchedAtIso ? fmtAchTime(d.fetchedAtIso) : '—'} · ${d.note || ''}${d.fromCache ? ' · 本机缓存' : ''}`;
  if (d.private) {
    body.innerHTML = `<div class="mini-empty">${esc(d.reason || '这个人的游戏库设为私密，Steam 不返回游玩时长。')}</div>`;
    return;
  }
  /* 两个长列表默认各只显示 5 条，页面不再被拉得老长；点任意一条看这一天玩了多久 */
  const gamesAll = (d.games || []).filter(g => Number(g.playtimeMin) > 0);
  const tlAll = d.timeline || [];
  const games = slShown(gamesAll, 'ptGames', 5);
  const tl = slShown(tlAll, 'ptTimeline', 5);
  let html = `<div class="kpi-grid kpi-3" style="margin-bottom:12px">
      ${kpi('累计游玩', (t.totalHours || 0) + ' h', '', `${t.playedGames || 0} 款玩过`, 'rgba(47,109,246,.16)', '◷')}
      ${kpi('近两周', (t.recent2wHours || 0) + ' h', '', '最近 14 天', 'rgba(16,179,156,.16)', '↗')}
      ${kpi('最后游玩', esc(t.lastPlayedLabel || '—'), '', t.lastPlayedIso ? fmtAchTime(t.lastPlayedIso) : 'Steam 未提供', 'rgba(122,99,245,.16)', '⏱')}</div>`;
  html += `<h3 class="sec-h">什么时候玩了什么（${tlAll.length} 条）<small class="fine"> · 点任意一条看这一天的时长明细</small></h3>`;
  html += tl.length
    ? `<div class="pt-timeline">${tl.map(x => `<div class="pt-tl-item pt-rec" data-pt-rec="1"
        data-pt-game="${esc(x.name || '（本机上线记录）')}"
        data-pt-min="${Number(x.playtimeHours || 0) * 60}"
        data-pt-when="${esc(x.atLabel || (x.atIso ? fmtAchTime(x.atIso) : '—'))}"
        data-pt-extra="${esc(x.source || (x.appid ? 'AppID ' + x.appid : ''))}${x.text ? ' · ' + esc(x.text) : ''}">
      <span class="pt-tl-when">${esc(x.atLabel || (x.atIso ? fmtAchTime(x.atIso) : '—'))}</span>
      <span class="pt-tl-main"><b>${esc(x.name || '（本机上线记录）')}</b><small>${esc(x.source || (x.appid ? 'AppID ' + x.appid : ''))}${x.text ? ' · ' + esc(x.text) : ''}</small></span>
      <span class="pt-tl-val">${x.playtimeHours !== undefined ? x.playtimeHours + ' h' : ''}</span></div>`).join('')}</div>`
      + slMoreBtn('ptTimeline', tlAll.length, 5, '显示更多记录')
    : '<div class="mini-empty">Steam 没有提供「最后游玩时间」，无法拼出时间线（资料私密或社区页不含该字段）。</div>';
  html += `<h3 class="sec-h" style="margin-top:16px">每款游戏玩了多久（${gamesAll.length} 款）</h3>`;
  html += games.length
    ? `<div class="mini-list">${games.map(g => `<div class="mini-item pt-rec" data-pt-rec="1"
        data-pt-game="${esc(g.name)}" data-pt-min="${Number(g.playtimeMin) || 0}"
        data-pt-when="${esc(g.lastPlayedLabel || '累计时长')}" data-pt-extra="AppID ${esc(g.appid)}">
      <div class="mi-main"><b>${esc(g.name)}</b><small>AppID ${esc(g.appid)}${g.playtime2wksHours ? ' · 近两周 +' + g.playtime2wksHours + ' h' : ''}${g.lastPlayedLabel ? ' · 最后 ' + esc(g.lastPlayedLabel) : ''}</small></div>
      <span class="mi-val num">${g.playtimeHours} h</span></div>`).join('')}</div>`
      + slMoreBtn('ptGames', gamesAll.length, 5, '显示更多游戏')
    : '<div class="mini-empty">没有读到游戏时长。</div>';
  body.innerHTML = html;
}

$('#btnPtScan')?.addEventListener('click', async () => {
  if (DEMO) { toast('离线演示模式：请先启动本地服务'); return; }
  const b = $('#btnPtScan'); if (b) { b.disabled = true; b.textContent = '正在读取 Steam…'; }
  try {
    const r = await post('/api/friend/playtime/scan', { limit: 40, refresh: false, onlyExtended: $('#ptOnlyFof')?.checked === true });
    await loadPlaytimeSummary();
    toast(r.ok ? `已读取 ${r.scanned} 人（私密 ${r.private} · 本机兜底 ${r.localCount || 0} · 失败 ${r.failed}）` : (r.reason || '扫描未完成'));
  } catch (e) { toast('扫描失败：' + e.message); }
  if (b) { b.disabled = false; b.textContent = '⟳ 扫描关系链游玩时长'; }
});
$('#btnPtScanAll')?.addEventListener('click', async () => {
  if (DEMO) { toast('离线演示模式：请先启动本地服务'); return; }
  const b = $('#btnPtScanAll'); if (b) { b.disabled = true; b.textContent = '全量重扫中…'; }
  try {
    const r = await post('/api/friend/playtime/scan', { limit: 120, refresh: true, onlyExtended: false });
    await loadPlaytimeSummary();
    toast(r.ok ? `已全量重扫 ${r.scanned} 人` : (r.reason || '扫描未完成'));
  } catch (e) { toast('重扫失败：' + e.message); }
  if (b) { b.disabled = false; b.textContent = '全量重扫'; }
});
$('#ptOnlyFof')?.addEventListener('change', renderPlaytimeSummary);
$('#btnFptClose')?.addEventListener('click', () => {
  const p = $('#friendPlaytimePanel'); if (p) p.hidden = true;
  FPT_SEL = { id: '', name: '' };
});
$('#btnFptRefresh')?.addEventListener('click', () => {
  if (!FPT_SEL.id) { toast('先点某人的「看明细」'); return; }
  openFpt(FPT_SEL.id, FPT_SEL.name, true);
});
document.addEventListener('click', e => {
  const t = e.target.closest('[data-pt-open]');
  if (t) { openFpt(t.getAttribute('data-pt-open'), t.getAttribute('data-pt-name') || ''); }
});

/* 点任意一条游玩记录 → 「这一天玩了多久」：游戏名 + 天 / 小时 / 分钟 / 秒 */
function playBreakdown(min) {
  const sec = Math.max(0, Math.round((Number(min) || 0) * 60));
  return {
    sec,
    d: Math.floor(sec / 86400),
    h: Math.floor((sec % 86400) / 3600),
    m: Math.floor((sec % 3600) / 60),
    s: sec % 60,
    totalH: Math.floor(sec / 3600)
  };
}
function openPtDay(game, min, when, extra) {
  const b = playBreakdown(min), box = $('#ptDayBody'), mask = $('#ptDayModal');
  if (!box || !mask) return;
  box.innerHTML = `<div class="mini-item"><div class="mi-main"><b>${esc(game)}</b>
      <small>${esc(when || '记录时间未知')}${extra ? ' · ' + esc(extra) : ''}</small></div></div>
    <div class="pt-day-grid">
      <div class="stat-box"><b class="num">${b.d}</b><small>天</small></div>
      <div class="stat-box"><b class="num">${b.h}</b><small>小时</small></div>
      <div class="stat-box"><b class="num">${b.m}</b><small>分钟</small></div>
      <div class="stat-box"><b class="num">${b.s}</b><small>秒</small></div>
    </div>
    <p class="fine">按 Steam 记录到的游玩时长换算：共 ${b.sec} 秒 ≈ ${b.totalH} 小时 ${b.m} 分钟${b.s ? ' ' + b.s + ' 秒' : ''}。</p>`;
  mask.classList.remove('hidden');
}
function closePtDay() { $('#ptDayModal')?.classList.add('hidden'); }
document.addEventListener('click', e => {
  const t = e.target.closest('[data-pt-rec]'); if (!t) return;
  openPtDay(t.getAttribute('data-pt-game') || '（本机上线记录）',
    Number(t.getAttribute('data-pt-min') || 0),
    t.getAttribute('data-pt-when') || '',
    t.getAttribute('data-pt-extra') || '');
});
$('#btnPtDayClose')?.addEventListener('click', closePtDay);
$('#ptDayModal')?.addEventListener('click', e => { if (e.target.id === 'ptDayModal') closePtDay(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePtDay(); });
setTimeout(loadPlaytimeSummary, 1800);

/* ==================================================================== */
/*  缓存管理：按块勾选，只删选中的那一块                                 */
/* ==================================================================== */
let CACHE = null;
function cacheSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
const RISK_LABEL = { safe: '可安全删', caution: '留意', danger: '谨慎' };
async function loadCache() {
  if (DEMO || (OFF && OFF.online === false)) {
    if ($('#cacheBlockList')) $('#cacheBlockList').innerHTML = '<div class="mini-empty">当前是离线版，缓存文件在本机服务上，需等在线版启动后才能在这里选择性删除。</div>';
    if ($('#cacheTotalTag')) $('#cacheTotalTag').textContent = '离线';
    return;
  }
  try { CACHE = await api('/api/cache/blocks'); } catch { CACHE = null; }
  renderCache();
}
function renderCache() {
  if (!$('#cacheBlockList')) return;
  if (!CACHE) { $('#cacheBlockList').innerHTML = '<div class="mini-empty">缓存列表读取失败，点「刷新列表」重试。</div>'; return; }
  $('#cacheTotalTag').textContent = `共 ${cacheSize(CACHE.totalBytes)}`;
  $('#cacheBlockList').innerHTML = CACHE.blocks.map(b => `
    <label class="cache-row">
      <input type="checkbox" class="cache-block-cb" value="${esc(b.id)}" ${b.count ? '' : 'disabled'}>
      <div class="c-main">
        <div class="c-top"><b>${esc(b.label)}</b><span class="cache-risk ${esc(b.risk)}">${RISK_LABEL[b.risk] || ''}</span>
          <span class="cache-size">${cacheSize(b.bytes)} · ${b.count} 个文件</span></div>
        <small>${esc(b.desc)}</small>
      </div>
    </label>`).join('');
  const games = CACHE.gameDetails || [];
  $('#cacheGameCount').textContent = games.length + ' 款';
  $('#cacheGameList').innerHTML = games.length ? games.map(g => `
    <label class="cache-game-row">
      <input type="checkbox" class="cache-game-cb" value="${esc(g.appid)}">
      <div class="c-main"><b>${esc(g.name || ('AppID ' + g.appid))}</b>
        <small>${esc(g.gameplay ? g.gameplay.slice(0, 46) : '（暂无玩法）')} · 成就 ${g.achievementTotal} 条 · ${cacheSize(g.bytes)}</small></div>
    </label>`).join('') : '<div class="mini-empty">还没有任何游戏详情缓存。</div>';
}
async function doCacheDelete(ids, appids, label) {
  if (!ids.length) { toast('请先勾选要删除的缓存块'); return; }
  const blocks = (CACHE?.blocks || []).filter(b => ids.includes(b.id));
  const lines = blocks.map(b => `· ${b.label}（${b.count} 个文件，${cacheSize(b.bytes)}）`);
  const risky = blocks.filter(b => b.risk === 'danger').map(b => b.label);
  let msg = `将只删除你勾选的 ${blocks.length} 块缓存：\n\n${lines.join('\n')}\n\n` +
    (appids.length ? `游戏详情只删这 ${appids.length} 款。\n\n` : '') +
    (risky.length ? `⚠ 其中有「谨慎」项：${risky.join('、')}\n\n` : '') + '确定删除吗？此操作不可撤销。';
  if (!window.confirm(msg)) return;
  try {
    const r = await post('/api/cache/delete', { blocks: ids, appids });
    if (r.error) { toast('删除失败：' + r.error); return; }
    CACHE = r.remaining || null;
    renderCache();
    $('#cacheHint').textContent = `已删除 ${r.count} 个文件，释放 ${cacheSize(r.bytesFreed)}。其余缓存保持原样。`;
    toast(`已删除选中的 ${label}，释放 ${cacheSize(r.bytesFreed)}`);
  } catch (e) { toast('删除失败：' + e.message); }
}
$('#btnCacheRefresh')?.addEventListener('click', loadCache);
$('#btnCacheSelectNone')?.addEventListener('click', () => { document.querySelectorAll('.cache-block-cb').forEach(x => x.checked = false); });
$('#btnCacheDelete')?.addEventListener('click', () => {
  const ids = [...document.querySelectorAll('.cache-block-cb:checked')].map(x => x.value);
  doCacheDelete(ids, [], '缓存块');
});
$('#btnCacheGameNone')?.addEventListener('click', () => { document.querySelectorAll('.cache-game-cb').forEach(x => x.checked = false); });
$('#btnCacheDeleteGames')?.addEventListener('click', () => {
  const appids = [...document.querySelectorAll('.cache-game-cb:checked')].map(x => x.value);
  if (!appids.length) { toast('请先勾选要删除的游戏'); return; }
  doCacheDelete(['game-details'], appids, '游戏详情');
});
loadCache();

/* ==================================================================== */
/*  更新中心：每分钟自动更新 + 一键更新 + 精确到秒的更新日志             */
/* ==================================================================== */
let UPDATE = null;
function renderUpdate() {
  const box = $('#updateLog'); if (!box) return;
  const offMode = DEMO || (OFF && OFF.online === false);
  const log = Array.isArray(UPDATE?.log) ? UPDATE.log : [];
  const last = UPDATE?.last || log[0] || null;
  if ($('#updateLastTime')) $('#updateLastTime').textContent = last?.time || '—';
  if ($('#updateNextTime')) $('#updateNextTime').textContent = offMode ? '离线 · 不自动更新' : (UPDATE?.nextTime || '—');
  if ($('#updateTotal')) $('#updateTotal').textContent = String(UPDATE?.total ?? log.length);
  const badge = $('#updateStatusBadge');
  if (badge) {
    const state = offMode ? 'off' : (UPDATE?.running ? 'busy' : (last ? (last.ok ? 'ok' : 'fail') : 'idle'));
    const text = offMode ? '离线（只读日志）' : UPDATE?.running ? '正在更新…' : last ? (last.ok ? '运行正常' : '上次更新失败') : '等待首次更新';
    badge.className = 'status-pill is-' + state;
    badge.innerHTML = '<i></i>' + text;
  }
  const fail = $('#updateFailNote');
  if (fail) {
    fail.hidden = offMode || !last || !!last.ok;
    if (!fail.hidden) fail.textContent = `⚠ 上次自动更新没成功（${last.time || ''} · ${last.summary || ''}）。按「一键更新」即可立刻重新更新，不用重启软件。`;
  }
  const btn = $('#btnOneClickUpdate');
  if (btn) btn.disabled = offMode || !!UPDATE?.running;
  if ($('#updateHint')) $('#updateHint').textContent = offMode
    ? '当前是离线版，显示的是最后一次固化进离线文件的更新日志；一键更新需要在线版启动后才能使用。'
    : `每 ${UPDATE?.intervalSec || 60} 秒自动更新并刷新日志；点击「一键更新」会立即重跑全部步骤。`;
  box.innerHTML = log.length ? log.map(r => `
    <div class="update-entry ${r.ok ? 'ok' : 'fail'}">
      <div class="ue-head">
        <b class="ue-time">${esc(r.time || '')}</b>
        <span class="tag">${esc(r.trigger || '')}</span>
        <span class="ue-result">${r.ok ? '✓ 成功' : '✕ 有失败项'}</span>
        <span class="ue-dur">${((Number(r.durationMs) || 0) / 1000).toFixed(1)} s</span>
      </div>
      <div class="ue-summary">${esc(r.summary || '')}</div>
      <div class="ue-steps">${(r.steps || []).map(s => `
        <div class="ue-step ${s.ok ? 'ok' : 'fail'}"><span>${s.ok ? '✓' : '✕'}</span><b>${esc(s.name)}</b><small>${esc(s.detail || '')}</small><em>${Number(s.ms) || 0} ms</em></div>`).join('')}</div>
    </div>`).join('')
    : '<div class="mini-empty">还没有更新记录。服务启动后会每分钟自动更新一次；也可以现在点「一键更新」立刻生成第一条。</div>';
}
async function loadUpdate() {
  const offMode = DEMO || (OFF && OFF.online === false);
  if (offMode) {
    const snap = OFF && OFF.snapshot ? OFF.snapshot() : (window.SL_OFFLINE_DATA || null);
    UPDATE = snap?.updateLog || null;
  } else {
    try { UPDATE = await api('/api/update/log'); } catch { UPDATE = null; }
  }
  renderUpdate();
}
$('#btnOneClickUpdate')?.addEventListener('click', async () => {
  const b = $('#btnOneClickUpdate');
  if (b) { b.disabled = true; b.textContent = '正在更新…'; }
  try {
    const r = await post('/api/update/run', {});
    if (r.offlineQueued) { toast('离线版不能一键更新，请启动在线版'); }
    else {
      UPDATE = r.status || UPDATE;
      const rec = r.record;
      toast(rec?.ok ? '一键更新成功' : ('更新有失败项：' + (rec?.summary || '请看日志')));
    }
  } catch (e) { toast('一键更新失败：' + e.message); }
  finally {
    if (b) { b.disabled = false; b.textContent = '⟳ 一键更新'; }
    renderUpdate();
  }
});
$('#btnUpdateRefresh')?.addEventListener('click', loadUpdate);
setInterval(loadUpdate, 60000);      // 日志每分钟刷新一次
setTimeout(loadUpdate, 1500);

/* ==================================================================== */
/*  浏览器扫描页（每秒同步）                                            */
/* ==================================================================== */
function fillBrowser() {
  if (!B) return;
  RESTORING = true;
  if ($('#bFriendCode') && !$('#bFriendCode').value) $('#bFriendCode').value = B.friendCode || '';
  if ($('#bSteamId64')) $('#bSteamId64').value = B.steamId64 || '';
  setTimeout(() => { RESTORING = false; }, 80);
}

/* 每秒重绘时，内容没变就不动 DOM：否则封面图会一秒闪一次 */
function slSetHTML(el, html) {
  if (!el || el._slHTML === html) return;
  el._slHTML = html;
  el.innerHTML = html;
}
/* 浏览器扫描页底部三栏（游戏库 / 愿望单 / 购物车）：
   与游戏库页的清单一样带封面、名字、AppID，点任意一行可看玩法和成就 */
function miniList(el, arr, empty, spec = false) {
  if (!el) return;
  const list = Array.isArray(arr) ? arr : [];
  const html = list.length
    ? list.slice(0, 100).map(x => blRow(x, false, true, spec)).join('')
    : `<div class="mini-empty">${esc(empty)}</div>`;
  slSetHTML(el, html);
}

/* ---------------- 浏览器扫描结果 → 游戏库页 / 愿望单页 ---------------- */
function blItems(arr) { return Array.isArray(arr) ? arr : []; }
function blRow(x, addBtn = false, compact = false, spec = false) {
  const id = esc(String(x.appid || ''));
  const raw = String(x.name || '').trim();
  const name = esc(raw || ('AppID ' + x.appid));
  const hint = compact ? '🎮 玩法 / 成就 ›' : '🎮 玩法 / 我的成就 ›';
  return `<div class="mini-item bl-row${compact ? ' bl-compact' : ''}" data-bl-game="${id}" data-bl-name="${name}" title="点击查看这个游戏的玩法和我的成就">
    ${blThumb(x)}
    <div class="mi-main"><b class="bl-game">${name}</b><small class="bl-id">AppID ${id}${raw ? '' : ' · 名称补全中…'}</small></div>
    ${spec ? wishSpecHTML(String(x.appid || ''), raw) : ''}
    <button class="bl-hint bl-detail-btn" data-bl-game="${id}" data-bl-name="${name}" title="点击查看这个游戏的玩法与我的成就">${hint}</button>
    ${addBtn ? `<button class="btn ghost tiny" data-bl-add="${id}" data-bl-name="${name}">＋ 加入监控</button>` : ''}
  </div>`;
}
function renderBrowserLibrary() {
  if (!$('#blOwned')) return;
  const owned = blItems(B?.owned), wish = blItems(B?.wishlist), cart = blItems(B?.cart);
  const fill = (sel, arr, empty, withBtn, spec = false) => {
    const el = $(sel); if (!el) return;
    slSetHTML(el, arr.length
      ? arr.slice(0, 100).map(x => blRow(x, withBtn, false, spec)).join('')
      : `<div class="mini-empty">${esc(empty)}</div>`);
  };
  fill('#blOwned', owned, '还没有已拥有数据；打开 Steam 库页面，或用本机游戏库兜底。', false);
  fill('#blWish', wish, '还没有愿望单数据；在浏览器打开 Steam 愿望单页即可同步。', false, true);
  fill('#blCart', cart, '购物车为空，或还没打开 Steam 购物车页。', false);
  fill('#blWatchList', wish, '还没有扫描到愿望单；在浏览器打开 Steam 愿望单页即可同步。', true, true);
  if ($('#blOwnedTag')) $('#blOwnedTag').textContent = String(owned.length);
  if ($('#blWishTag')) $('#blWishTag').textContent = String(wish.length);
  if ($('#blCartTag')) $('#blCartTag').textContent = String(cart.length);
  if ($('#blWatchTag')) $('#blWatchTag').textContent = wish.length + ' 款';
  if ($('#browserLibTag')) {
    if (B?.offline) $('#browserLibTag').textContent = '离线快照';
    else if (B?.collectorActive) $('#browserLibTag').textContent = '每秒同步中';
    else if (owned.length) {
      const ago = B?.collectedAt ? Math.max(0, Math.round((Date.now() - B.collectedAt) / 1000)) : null;
      $('#browserLibTag').textContent = `已保留 ${owned.length} 款` + (ago != null ? ` · 上次同步 ${ago} 秒前` : '');
    } else $('#browserLibTag').textContent = '等待浏览器同步';
  }
}
async function blAddToWatch(appid, name) {
  try {
    const r = await post('/api/watchlist/add', { appid, name, source: '浏览器扫描愿望单' });
    if (!r || !r.ok) { toast('加入失败：' + ((r && r.error) || '未知错误')); return false; }
    WATCH = r.status || WATCH;
    if (typeof fillWatchLocal === 'function') fillWatchLocal();
    if (typeof renderWatch === 'function') renderWatch();
    toast('已加入监控：' + (name || appid));
    return true;
  } catch (e) { toast('失败：' + e.message); return false; }
}
document.addEventListener('click', async (e) => {
  /* 先处理行内按钮：否则点「加入监控」会连带把整行的详情弹窗也打开 */
  const add = e.target.closest('[data-bl-add]');
  if (add) { await blAddToWatch(add.getAttribute('data-bl-add'), add.getAttribute('data-bl-name') || ''); return; }
  const all = e.target.closest('#btnBlWatchAddAll');
  if (all) {
    const list = blItems(B?.wishlist).slice(0, 30);
    if (!list.length) { toast('还没有扫描到愿望单游戏'); return; }
    all.disabled = true;
    let n = 0;
    for (const x of list) if (await blAddToWatch(x.appid, x.name || '')) n++;
    all.disabled = false;
    toast('已加入 ' + n + ' 款到监控清单');
    return;
  }
  const refresh = e.target.closest('#btnBlRefreshMeta');
  if (refresh) {
    refresh.disabled = true; refresh.textContent = '补全中…';
    try { await post('/api/game/meta/refresh', {}); toast('已重新排队补全游戏名与封面，几秒后自动刷新'); }
    catch (err) { toast('补全请求失败：' + err.message); }
    refresh.disabled = false; refresh.textContent = '⟳ 补全名字 / 封面';
    return;
  }
  const g = e.target.closest('[data-bl-game]');
  if (g) {
    const appid = g.getAttribute('data-bl-game');
    const name = g.getAttribute('data-bl-name') || '';
    if (typeof openGameDetail === 'function') openGameDetail(appid, name);
    return;
  }
});

function renderBrowser() {
  const kpi = $('#browserKpi'); if (!kpi) return;
  const v = B?.verified;
  const detectedNow = !!(B?.detectedNow || B?.loggedIn);
  kpi.innerHTML =
    kpi_('浏览器登录', detectedNow ? '已识别' : '未识别', '', B?.detected ? '已发现 Steam 网页（实时标签探测）' : (B?.loggedIn ? (B?.loggedInSource || '采集器已上报') : '用「调试模式打开 Steam」即可实时识别'), 'rgba(47,109,246,.16)', '◉') +
    kpi_('已购买（权威）', B?.storeOwned || 0, '款', v ? 'Steam 商店 rgOwnedApps' : '等待商店清单', 'rgba(16,179,156,.16)', '✓') +
    kpi_('愿望单', B?.storeWishlist ?? B?.totals?.wishlist ?? 0, '款', '愿望单 / 页面扫描', 'rgba(122,99,245,.16)', '☆') +
    kpi_('购物车', B?.totals?.cart ?? B?.storeCart ?? 0, '款', '仅购物车项 · 推荐位已排除', 'rgba(226,148,37,.16)', '▤');

  const sinceSec = B?.collectedAt ? Math.max(0, Math.round((Date.now() - B.collectedAt) / 1000)) : null;
  const active = sinceSec !== null && sinceSec < 5;
  if ($('#collectorTag')) $('#collectorTag').textContent = active ? '每秒采集中' : '等待采集器';
  if ($('#syncDot')) $('#syncDot').classList.toggle('live', active);
  if ($('#syncText')) $('#syncText').textContent = B?.collectedAt
    ? `${active ? '● 每秒实时同步中' : '上次同步'} · ${sinceSec} 秒前 · 已收到 ${B.polls || 0} 次心跳 · 面板每 1 秒刷新`
    : '尚未收到采集器数据：在「浏览器扫描」页复制采集脚本，到已登录 Steam 的浏览器控制台运行一次即可自动每秒同步';
  if ($('#verifiedTag')) $('#verifiedTag').textContent = v ? '已校验购买' : '未校验';
  if ($('#verifiedHint') && v) {
    $('#verifiedHint').innerHTML = `<b>已拿到 Steam 商店的权威清单</b>：当前真正买过 <b>${B.storeOwned}</b> 款，愿望单 ${B.storeWishlist} 款，购物车 ${B?.totals?.cart ?? B.storeCart} 款。库价值现在只统计这份清单，没买过的（愿望单 / Demo / 家庭共享）不再算钱。`;
  }
  if ($('#verifiedSummary')) $('#verifiedSummary').innerHTML = B?.history?.length
    ? B.history.slice(0, 6).map(x => `<div class="mini-item"><div class="mi-main"><b>${esc(x.page || '页面扫描')}</b>
        <small>${timeStr(x.iso)} · 页面 ${x.owned + x.wishlist + x.cart} 条 · 商店已购买 ${x.storeOwned || 0} 款</small></div></div>`).join('')
    : '<div class="mini-empty">还没有同步记录。</div>';
  if ($('#browserDetectList')) $('#browserDetectList').innerHTML = (B?.browsers || []).map(x =>
    `<div class="mini-item"><div class="mi-main"><b>${esc(x.name)} · ${x.found ? (x.markerFound ? '发现 Steam 标记' : '已检测') : '未安装'}</b>
      <small>${esc(x.note || '')}</small></div><span class="mi-val ${x.markerFound ? 'up' : ''}">${x.markerFound ? '●' : '○'}</span></div>`).join('');

  // ★ 实时标签探测（CDP）：打开 Steam 网页即「识别到」
  if ($('#debugTag')) {
    const detected = !!B?.detected;
    $('#debugTag').textContent = detected ? '● 已识别 Steam 网页' : (B?.debuggerAttached ? '监听中 · 未开 Steam' : '未启用');
    $('#debugTag').classList.toggle('up', detected);
  }
  if ($('#debugNote')) $('#debugNote').textContent = B?.debugNote || '';
  if ($('#debugTabs')) {
    const tabs = B?.openTabs || [];
    $('#debugTabs').innerHTML = tabs.length
      ? tabs.map(t => {
          const isSteam = /steam/i.test(t.url || t.title || '');
          const label = (t.title || t.url || '').slice(0, 70);
          return `<div class="mini-item"><div class="mi-main"><b>${esc(label)}</b><small>${esc(t.url || '')}</small></div><span class="mi-val ${isSteam ? 'up' : ''}">${isSteam ? 'Steam · 已注入采集' : '其他'}</span></div>`;
        }).join('')
      : '<div class="mini-empty">还没有连接到浏览器，或当前没有打开的标签页。</div>';
  }

  if ($('#bOwnedTag')) $('#bOwnedTag').textContent = B?.totals?.owned ?? 0;
  if ($('#bWishTag')) $('#bWishTag').textContent = B?.totals?.wishlist ?? 0;
  if ($('#bCartTag')) $('#bCartTag').textContent = B?.totals?.cart ?? 0;
  /* 购物车状态说明：让用户一眼看到来源、被过滤掉的推荐位、以及数据是不是刚更新过 */
  if ($('#cartSourceNote')) {
    const n = Number(B?.totals?.cart || 0);
    const src = B?.cartSource ? ` · 来源：${B.cartSource}` : '';
    const filt = B?.cartFilteredCount ? ` · 已排除 ${B.cartFilteredCount} 个推荐位` : '';
    const ago = B?.cartAt ? ` · ${Math.max(0, Math.round((Date.now() - B.cartAt) / 1000))} 秒前更新` : '';
    $('#cartSourceNote').textContent = n
      ? `共 ${n} 款购物车游戏${src}${filt}${ago}。「为您推荐 / 猜你喜欢」等推荐位已排除。`
      : (B?.cartConfirmedEmpty
        ? '购物车是空的（页面已确认）。'
        : '还没扫到购物车：打开 Steam 购物车页，或让采集器读取商店购物车清单即可。推荐位一律不会算进来。');
  }
  miniList($('#browserOwned'), B?.owned, '还没有游戏库数据，打开 Steam 商店 / 库页面即可同步。');
  miniList($('#browserWishlist'), B?.wishlist, '还没有愿望单数据，打开愿望单页面即可同步。', true);
  miniList($('#browserCart'), B?.cart, '购物车为空或还没扫描。');
  if ($('#navBrowser')) $('#navBrowser').textContent = B?.loggedIn ? '已识别' : '—';
}
function kpi_(label, value, unit, sub, color, ico) { return kpi(label, value, unit, sub, color, ico); }

let browserTick = 0;
function startBrowserPoll() {
  setInterval(async () => {
    browserTick++;
    // ★ 每秒拉一次服务端状态、每秒重绘：浏览器扫描不再「看着不更新」
    //   离线时不发无效请求，直接用本机快照渲染
    if (!DEMO && (!OFF || OFF.online)) {
      try { B = await api('/api/browser/status'); } catch {}
    }
    if ($('#page-browser')?.classList.contains('active')) renderBrowser();
    renderBrowserLibrary();   // 游戏库页 / 愿望单页也跟着每秒同步浏览器扫描结果
    /* 总览「游戏总数」= 浏览器扫描提取到的已拥有款数，跟着每秒更新 */
    if ($('#kpiGrid') && $('#page-overview')?.classList.contains('active')) $('#kpiGrid').innerHTML = overviewKpiHTML();
    // 隐藏识别倒计时也跟着每秒走
    if ($('#page-private')?.classList.contains('active')) renderHidden();
  }, 1000);
}

/* ==================================================================== */
/*  设置保存页                                                          */
/* ==================================================================== */
function renderSettings() {
  if (!$('#settingsInventory')) return;
  const u = UI || {};
  const items = [
    ['外观主题', u.theme === 'dark' ? '深色' : '白色（默认）'],
    ['连接模式', u.mode === 'manual' ? '手动' : '自动'],
    ['当前页签', PAGE_META[u.page]?.[0] || '总览'],
    ['隐私名称脱敏', u.mask !== false ? '开启' : '关闭'],
    ['游戏筛选 / 排序', `${u.filter || 'all'} · ${u.sort || 'playtime'}`],
    ['表单草稿', Object.keys(u.draft || {}).length + ' 项'],
    ['提示音 / 弹窗 / 邮箱 / 微信开关', '由 config.json 长期保存'],
    ['Steam 隐藏游戏自动同步', H?.enabled === false ? '已暂停' : `每 ${H?.intervalSec || 60} 秒 · 已识别 ${H?.count || 0} 款`],
    ['浏览器扫描刷新', '每 1 秒'],
    ['离线模式', OFF?.online ? '在线 · 本机快照持续固化' : `离线 · 待同步 ${OFF?.pendingCount() || 0} 条`],
    ['钉钉通知', DT?.connected ? '已绑定' : '未绑定'],
    ['好友档案', `${FP?.count || 0} 份已保存`],
    ['上次保存', u.savedAt ? timeStr(new Date(u.savedAt).toISOString()) : '—']
  ];
  $('#settingsInventory').innerHTML = items.map(([k, v]) =>
    `<div class="mini-item"><div class="mi-main"><b>${esc(k)}</b><small>${esc(v)}</small></div><span class="mi-val">已保存</span></div>`).join('');
  if ($('#settingsSavedTag')) $('#settingsSavedTag').textContent = u.savedAt ? '已落盘' : '等待首次保存';
  if ($('#settingsHint')) $('#settingsHint').textContent = '当前主题：' + (u.theme === 'dark' ? '深色' : '白色');
  if ($('#navSettings')) $('#navSettings').textContent = '永久';
}

/* ==================================================================== */
/*  新页面的按钮交互                                                    */
/* ==================================================================== */
$('#btnWechatLogin')?.addEventListener('click', async () => {
  if (DEMO) { toast('离线演示模式'); return; }
  const btn = $('#btnWechatLogin'); btn.disabled = true; btn.textContent = '正在绑定…';
  try {
    const r = await post('/api/wechat/connect', {
      channel: $('#wChannel')?.value || 'serverchan',
      key: $('#wKey')?.value || '',
      minIntervalSec: Number($('#wMinInterval')?.value || 60),
      onOnline: $('#wOnOnline')?.checked, onOffline: $('#wOnOffline')?.checked,
      onWishlist: $('#wOnWishlist')?.checked, verify: true
    });
    WECHAT = r.status || WECHAT;
    if (r.test?.ok) toast('已绑定，测试消息已发到你的微信');
    else toast('已保存 Key，但测试消息未送达：' + (r.test?.reason || '未知原因'));
    fillWechat(); renderWechat();
  } catch (e) { toast('绑定失败：' + e.message); }
  finally { btn.disabled = false; btn.textContent = '登录微信'; }
});
$('#btnWechatLogout')?.addEventListener('click', async () => {
  if (DEMO) return;
  try { const r = await post('/api/wechat/disconnect'); WECHAT = r.status || WECHAT; fillWechat(); renderWechat(); toast('已退出微信推送（本机 Key 已清除）'); }
  catch (e) { toast('退出失败：' + e.message); }
});
$('#btnWechatTest')?.addEventListener('click', async () => {
  if (DEMO) return;
  try { const r = await post('/api/wechat/test'); toast(r.ok ? '测试消息已发到你的微信' : '未送达：' + (r.reason || '')); await refreshAux(); }
  catch (e) { toast('测试失败：' + e.message); }
});

$('#btnFriendClientPoll')?.addEventListener('click', async () => {
  try {
    const r = await post('/api/steam-client/poll');
    if (r.offlineQueued) { toast('离线中：已排队，服务恢复后自动同步'); return; }
    toast(r.ok ? `已从 Steam 客户端读取 ${r.mapped} 位好友${r.changed ? '（状态有变化，已自动更新）' : ''}` : '未读到：' + (r.error || '请打开 Steam「好友与聊天」窗口'));
    await loadFriendDiagnosis();
    try { F = await api('/api/friends?refresh=1'); checkFriendNotifications(); renderFriends(); renderHeader(); } catch {}
  } catch (e) { toast('读取失败：' + e.message); }
});
$('#btnFriendDiagRefresh')?.addEventListener('click', async () => { await loadFriendDiagnosis(); toast('已重新诊断'); });

$('#btnCopyCollector')?.addEventListener('click', async () => {
  try { const js = await api('/api/browser/collector'); await copy(js, '采集脚本'); toast('已复制：在已登录 Steam 的浏览器按 F12 → 控制台粘贴回车'); }
  catch (e) { toast('复制失败：' + e.message); }
});
$('#btnCopyBookmark')?.addEventListener('click', async () => {
  try { const js = await api('/api/browser/collector'); await copy('javascript:' + encodeURIComponent(js), '书签版脚本'); toast('已复制书签地址：新建书签，网址粘贴这段即可'); }
  catch (e) { toast('复制失败：' + e.message); }
});
$('#btnOpenSteamStore')?.addEventListener('click', () => window.open('https://store.steampowered.com/', '_blank', 'noopener'));
$('#btnDebugLaunch')?.addEventListener('click', async () => {
  if (DEMO) { toast('离线演示模式'); return; }
  const btn = $('#btnDebugLaunch'); if (btn) { btn.disabled = true; btn.textContent = '正在打开…'; }
  try {
    const r = await post('/api/browser/debug/launch');
    if (r.ok) toast('已用调试模式打开 Steam，登录一次后就会自动识别并导入');
    else toast('打开失败：' + (r.error || '未知原因'));
    await refreshAux();
  } catch (e) { toast('失败：' + e.message); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '▶ 用调试模式打开 Steam（自动识别+导入）'; } }
});
$('#btnDebugAttach')?.addEventListener('click', async () => {
  if (DEMO) return;
  const port = $('#debugPort')?.value.trim() || 9222;
  try { const r = await post('/api/browser/debug/attach', { port: Number(port) }); toast(r.ok ? '已连接调试端口 ' + port : '连接失败：' + (r.error || '')); await refreshAux(); }
  catch (e) { toast('失败：' + e.message); }
});
$('#btnDebugDetach')?.addEventListener('click', async () => {
  if (DEMO) return;
  try { await post('/api/browser/debug/detach'); toast('已断开调试监听'); await refreshAux(); } catch (e) { toast('失败：' + e.message); }
});
$('#btnBrowserClear')?.addEventListener('click', async () => {
  if (DEMO) return;
  try { await post('/api/browser/clear'); B = await api('/api/browser/status'); fillBrowser(); renderBrowser(); toast('扫描结果已清空'); }
  catch (e) { toast('清空失败：' + e.message); }
});
$('#btnFriendCode')?.addEventListener('click', async () => {
  const code = $('#bFriendCode')?.value.trim();
  if (!code) { toast('请先填好友码'); return; }
  if (DEMO) { toast('离线演示模式'); return; }
  try {
    const r = await post('/api/browser/friend-code', { code });
    if ($('#bSteamId64')) $('#bSteamId64').value = r.steamId64;
    queueUi({ draft: { bFriendCode: code, bSteamId64: r.steamId64 } });
    toast(`好友码 ${r.friendCode} → SteamID64 ${r.steamId64}，已保存`);
    await load(true);
  } catch (e) { toast('换算失败：' + e.message); }
});
$('#btnScanLibrary')?.addEventListener('click', async () => { await load(true); toast('已重新扫描本机库'); });

$('#btnWhiteTheme')?.addEventListener('click', () => { applyTheme('light', true); renderAll(); toast('已恢复白色背景'); });
$('#btnDarkTheme')?.addEventListener('click', () => { applyTheme('dark', true); renderAll(); toast('已切换到深色'); });
$('#btnExportSettings')?.addEventListener('click', async () => {
  try {
    const s = await api('/api/ui-settings');
    const blob = new Blob([JSON.stringify({ app: 'SteamLens', version: 2, settings: s.settings }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'steamlens-settings.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('设置备份已导出');
  } catch (e) { toast('导出失败：' + e.message); }
});
$('#btnImportSettings')?.addEventListener('click', () => $('#settingsFile')?.click());
$('#settingsFile')?.addEventListener('change', async e => {
  const f = e.target.files?.[0]; if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    const r = await post('/api/ui-settings/import', j);
    UI = r.settings; restoreUiState(UI); renderAll();
    toast('设置已导入并恢复');
  } catch (err) { toast('导入失败：' + err.message); }
  e.target.value = '';
});
$('#btnResetUi')?.addEventListener('click', async () => {
  try {
    const r = await post('/api/ui-settings/reset');
    UI = r.settings; restoreUiState(UI);
    applyTheme('light'); go('overview'); renderAll();
    toast('已恢复默认：白色背景 + 全部界面设置重置');
  } catch (e) { toast('重置失败：' + e.message); }
});

/* ==================================================================== */
/*  钉钉通知                                                            */
/* ==================================================================== */
let FP_ACTIVE = null, FP_LOADING = false;
let FP_ACTIVE_ID = '', FP_SEARCH = '', FP_SORT = 'time', FP_LIVE_FAILS = 0;

function setField(id, val) {
  const el = $('#' + id); if (!el || val === undefined || val === null) return;
  if (el.type === 'checkbox') el.checked = (val === true || val === 'true' || val === 1 || val === '1');
  else el.value = String(val);
}
function fillDingtalk() {
  if (!DT) return;
  setField('dWebhook', '');
  setField('dSecret', '');
  setField('dKeyword', DT.keyword || '');
  setField('dOnOnline', DT.onOnline !== false);
  setField('dOnOffline', DT.onOffline !== false);
  setField('dOnWishlist', DT.onWishlist !== false);
  setField('dEnabled', DT.enabled !== false);
}
function renderDingtalk() {
  if (!$('#dingtalkStatusBadge')) return;
  const s = DT || {};
  const on = !!s.connected;
  $('#dingtalkStatusBadge').className = 'status-pill' + (on ? ' on' : '');
  $('#dingtalkStatusBadge').innerHTML = `<i></i>${on ? '已绑定' : (s.webhookSet ? '配置待验证' : '未绑定')}`;
  if ($('#dWebhook')) $('#dWebhook').placeholder = s.webhookMasked
    ? `已保存：${s.webhookMasked} · 留空表示不修改` : 'https://oapi.dingtalk.com/robot/send?access_token=…';
  if ($('#dSecret')) $('#dSecret').placeholder = s.secretSet
    ? `已保存加签密钥 ${s.secretMasked} · 留空表示不修改` : '机器人安全设置选了「加签」才需要';
  const diag = s.diagnosis || [];
  if ($('#dingtalkDiagnosis')) $('#dingtalkDiagnosis').innerHTML = diag.length
    ? diag.map(d => `<div class="diag-line ${d.level}"><i>${d.level === 'error' ? '!' : d.level === 'warn' ? '·' : '✓'}</i><span>${esc(d.text)}</span></div>`).join('')
    : '';
  const hist = s.history || [];
  if ($('#dingtalkHistoryTag')) $('#dingtalkHistoryTag').textContent = hist.length + ' 条';
  if ($('#dingtalkHistory')) $('#dingtalkHistory').innerHTML = hist.length
    ? hist.slice(0, 8).map(x => `<div class="mini-item"><div class="mi-main"><b>${esc(x.title)}</b>
        <small>${timeStr(x.iso)} · ${x.ok ? '已送达' : esc(x.reason || '未送达')}</small></div>
        <span class="mi-val ${x.ok ? 'up' : ''}">${x.ok ? '✓' : '—'}</span></div>`).join('')
    : '<div class="mini-empty">还没有钉钉推送记录。</div>';
  if ($('#dingtalkChannels')) $('#dingtalkChannels').innerHTML = [
    ['推送方向', s.direction || '只推到你自己的钉钉群'],
    ['安全设置', s.secretSet ? '已配置加签（HMAC-SHA256）' : (s.keyword ? `关键词「${s.keyword}」` : '未加签 / 未设关键词')],
    ['成功判定', '解析 errcode，只有 0 才算送达'],
    ['凭证保存', '本机 config.json · 重启不丢']
  ].map(([k, v]) => `<div class="mini-item"><div class="mi-main"><b>${esc(k)}</b><small>${esc(v)}</small></div></div>`).join('');
}

$('#btnDingtalkLogin')?.addEventListener('click', async () => {
  const btn = $('#btnDingtalkLogin'); btn.disabled = true; btn.textContent = '正在绑定…';
  try {
    const r = await post('/api/dingtalk/connect', {
      webhook: $('#dWebhook')?.value || '', secret: $('#dSecret')?.value || '',
      keyword: $('#dKeyword')?.value || '',
      onOnline: $('#dOnOnline')?.checked, onOffline: $('#dOnOffline')?.checked,
      onWishlist: $('#dOnWishlist')?.checked, verify: true
    });
    DT = r.status || DT;
    if (r.offlineQueued) toast('已保存到本机，服务恢复后自动同步到钉钉配置');
    else if (r.test?.ok) toast('已绑定，测试消息已发到你的钉钉');
    else toast('已保存配置，但测试未送达：' + (r.test?.reason || r.diagnosis?.find(x => x.level === 'error')?.text || '未知原因'));
    fillDingtalk(); renderDingtalk();
  } catch (e) { toast('绑定失败：' + e.message); }
  finally { btn.disabled = false; btn.textContent = '登录钉钉'; }
});
$('#btnDingtalkLogout')?.addEventListener('click', async () => {
  try { const r = await post('/api/dingtalk/disconnect'); DT = r.status || DT; fillDingtalk(); renderDingtalk(); toast(r.offlineQueued ? '已排队，服务恢复后自动退出' : '已退出钉钉推送（本机 Webhook 已清除）'); }
  catch (e) { toast('退出失败：' + e.message); }
});
$('#btnDingtalkTest')?.addEventListener('click', async () => {
  const btn = $('#btnDingtalkTest'); btn.disabled = true;
  try {
    const r = await post('/api/dingtalk/test');
    toast(r.offlineQueued ? '离线已排队，服务恢复后自动发送' : (r.ok ? '测试消息已发到你的钉钉' : '未送达：' + (r.reason || '')));
    await refreshAux(); DT = (await api('/api/dingtalk/status').catch(() => DT)) || DT; renderDingtalk();
  } catch (e) { toast('测试失败：' + e.message); }
  finally { setTimeout(() => { btn.disabled = false; }, 3200); }
});

/* ==================================================================== */
/*  离线模式                                                            */
/* ==================================================================== */
/* ------------------- 离线接管：在线版起不来时由离线版代发通知 ------------------- */
function takeoverOutbox() {
  const snap = (OFF && OFF.snapshot) ? OFF.snapshot() : (window.SL_OFFLINE_DATA || null);
  return (snap && Array.isArray(snap.notifyOutbox)) ? snap.notifyOutbox : [];
}
function renderOfflineTakeover() {
  const card = $('#offlineTakeover');
  if (!card) return;
  const isFile = location.protocol === 'file:';
  const online = OFF ? !!OFF.online : true;
  const show = isFile && !online;         // 只在「离线文件 + 服务未启动」时接管
  card.hidden = !show;
  if (!show) return;
  const outbox = takeoverOutbox();
  const list = $('#takeoverList');
  if (list) {
    list.innerHTML = outbox.length
      ? outbox.slice(0, 30).map(n => `<div class="mini-item"><div class="mi-main"><b>${esc(n.title || '通知')}</b><small>${esc(n.body || '')}${n.iso ? ' · ' + esc(timeStr(n.iso)) : ''}</small></div><span class="mi-val">${esc(n.type || '当日')}</span></div>`).join('')
      : '<div class="mini-item"><div class="mi-main"><b>暂无已记录的通知</b><small>在线版运行期间产生的通知会记录在这里；离线快照更新后打开即可看到。</small></div></div>';
  }
  const hint = $('#takeoverHint');
  if (hint && !hint.textContent) hint.textContent = outbox.length ? `共 ${outbox.length} 条已记录通知（显示最近 30 条）` : '';
}
function initOfflineTakeover() {
  const d = $('#btnTakeoverDesktop');
  if (d) d.addEventListener('click', async () => {
    const hint = $('#takeoverHint');
    if (!('Notification' in window)) { if (hint) hint.textContent = '当前浏览器不支持桌面通知，请改用「转发到 Webhook」。'; return; }
    let perm = Notification.permission;
    if (perm === 'default') { try { perm = await Notification.requestPermission(); } catch (e) {} }
    if (perm !== 'granted') { if (hint) hint.textContent = '桌面通知权限被拒绝，请在浏览器地址栏放行通知后再试。'; return; }
    const outbox = takeoverOutbox();
    if (!outbox.length) { if (hint) hint.textContent = '没有可弹出的通知。'; return; }
    outbox.slice(0, 30).forEach((n, i) => setTimeout(() => {
      try { new Notification(n.title || 'SteamLens', { body: n.body || '' }); } catch (e) {}
    }, i * 350));
    if (hint) hint.textContent = `已弹出 ${Math.min(outbox.length, 30)} 条桌面通知。`;
  });
  const f = $('#btnTakeoverForward');
  if (f) f.addEventListener('click', async () => {
    const hint = $('#takeoverHint');
    const url = ($('#takeoverWebhook')?.value || '').trim();
    if (!url) { if (hint) hint.textContent = '请先填写 Webhook 完整 URL。'; return; }
    const outbox = takeoverOutbox();
    if (!outbox.length) { if (hint) hint.textContent = '没有可转发的通知。'; return; }
    if (hint) hint.textContent = '正在转发…';
    let ok = 0, fail = 0;
    for (const n of outbox.slice(0, 30)) {
      try {
        const r = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: n.title || 'SteamLens', body: n.body || '', text: (n.title || '') + '\n' + (n.body || ''), iso: n.iso || '' })
        });
        if (r && (r.ok || r.type === 'opaque')) ok++; else fail++;
      } catch (e) { fail++; }
    }
    if (hint) hint.textContent = `转发完成：成功 ${ok} 条，失败 ${fail} 条。`;
  });
  const inp = $('#takeoverWebhook');
  if (inp) {
    try { const saved = localStorage.getItem('sl-takeover-webhook'); if (saved) inp.value = saved; } catch (e) {}
    inp.addEventListener('change', () => { try { localStorage.setItem('sl-takeover-webhook', inp.value.trim()); } catch (e) {} });
  }
}

function renderOffline() {
  if (!$('#offlineInventory')) return;
  const st = OFF?.status() || {};
  const online = !!st.online;
  const badge = $('#offlineStatusBadge');
  if (badge) { badge.className = 'status-pill' + (online ? ' on' : ''); badge.innerHTML = `<i></i>${online ? '在线 · 已同步' : '离线 · 本机数据'}`; }
  const pending = st.pendingCount || 0;
  const items = [
    ['当前状态', online ? '服务在线，实时数据' : '服务未连接，正在使用本机快照'],
    ['本机快照时间', st.snapshotAtIso ? timeStr(st.snapshotAtIso) : '尚无快照'],
    ['快照内容', '游戏库 / 时长 / 价值 / 好友 / 通知设置 / 隐藏清单 / 浏览器扫描'],
    ['待同步改动', pending ? `${pending} 条（服务恢复后自动合并）` : '无'],
    ['上次同步', st.lastSyncAt ? timeStr(new Date(st.lastSyncAt).toISOString()) : '—'],
    ['离线数据位置', '浏览器本机 + assets/offline-data.js + data/offline-snapshot.json']
  ];
  $('#offlineInventory').innerHTML = items.map(([k, v]) =>
    `<div class="mini-item"><div class="mi-main"><b>${esc(k)}</b><small>${esc(v)}</small></div><span class="mi-val">本机</span></div>`).join('');
  const hdr = $('#statusBadge');
  if (hdr && !online) hdr.innerHTML = '<span class="dot warn"></span><span>离线 · 本机数据</span>';
  if ($('#offlineHint')) $('#offlineHint').textContent = online
    ? '服务器在线，改动直接写入服务端；同时持续固化本机快照，随时可离线打开。'
    : '服务器未连接：你的改动会排队存在本机，服务恢复后自动同步；也可以先导出文件备份。';
  renderOfflineNotes();
  renderOfflinePack();
}
/* 离线包统计：壁纸有没有真的打包进去、占多大、放哪里，一目了然 */
function renderOfflinePack() {
  const el = $('#offlinePackStat'); if (!el) return;
  const snap = (OFF && OFF.snapshot && OFF.snapshot()) || window.SL_OFFLINE_DATA || null;
  const pk = snap && snap.wallpaperPack;
  if (!pk) {
    el.innerHTML = '<div class="mini-empty">还没打包过壁纸。点上面「📦 导出离线版」，壁纸会一起复制进 <code>SteamLens-离线版\\wallpapers\\</code>。</div>';
    return;
  }
  const rows = [
    ['打包时间', pk.generatedAt ? new Date(pk.generatedAt).toLocaleString('zh-CN') : '—'],
    ['壁纸数量', `${pk.items || 0} 款 · 完整带 ${pk.fullMedia || 0} 款 · 仅预览图 ${pk.previewOnly || 0} 款 · 网页目录 ${pk.webDirs || 0} 个`],
    ['占用空间', `${pk.packedMB || 0} MB${pk.budgetMB ? `（预算 ${pk.budgetMB} MB）` : '（完整打包）'}`],
    ['打包策略', pk.full ? '完整打包：全部壁纸本体' : '智能打包：当前款 + 按体积从小到大装满预算，其余显示预览图'],
    ['离线包位置', pk.packDir || 'D:\\SteamLens\\SteamLens-离线版']
  ];
  el.innerHTML = rows.map(([k, v]) =>
    `<div class="mini-item"><div class="mi-main"><b>${esc(k)}</b><small>${esc(String(v))}</small></div><span class="mi-val">本机</span></div>`).join('');
}
async function renderOfflineNotes() {
  if (!$('#offlineNotes')) return;
  let notes = [];
  if (OFF && !OFF.online) notes = OFF.localNotes();
  else notes = await api('/api/offline/notes').then(r => r.notes || []).catch(() => OFF?.localNotes() || []);
  $('#offlineNotes').innerHTML = notes.length
    ? notes.slice(0, 8).map(n => `<div class="mini-item"><div class="mi-main"><b>${esc(n.text.slice(0, 60))}</b><small>${timeStr(n.iso)} · ${esc(n.source || '')}</small></div></div>`).join('')
    : '<div class="mini-empty">还没有随手记。</div>';
}
$('#btnOfflineExport')?.addEventListener('click', () => {
  try { OFF.exportFile(); toast('全部本机数据已导出为 JSON 文件'); }
  catch (e) { toast('导出失败：' + e.message); }
});
$('#btnOfflineImport')?.addEventListener('click', () => $('#offlineFile')?.click());
$('#offlineFile')?.addEventListener('change', async e => {
  const f = e.target.files?.[0]; if (!f) return;
  try { const r = OFF.importFile(await f.text()); toast(`已导入本机数据：快照 + ${r.queued} 条待同步`); renderOffline(); }
  catch (err) { toast('导入失败：' + err.message); }
  e.target.value = '';
});
$('#btnOfflineSync')?.addEventListener('click', async () => {
  try {
    const r = await OFF.sync();
    if (r.ok) { toast(`已同步 ${r.applied} 条离线改动到在线版`); await load(true); renderOffline(); }
    else toast('同步失败：服务器可能还没启动 — ' + (r.error || '请稍后再试'));
  } catch (e) { toast('同步失败：' + e.message); }
});
$('#btnOfflineSnapshot')?.addEventListener('click', async () => {
  try { await post('/api/offline/refresh'); toast('已把当前在线数据固化到本机文件'); renderOffline(); }
  catch (e) { toast('固化失败：' + e.message); }
});
$('#btnOfflineBuild')?.addEventListener('click', async () => {
  if (wpOffline()) { toast('离线版不能给自己打包；请先启动在线版（start.bat）再点这里'); return; }
  const btn = $('#btnOfflineBuild');
  const budgetMB = Number($('#offlinePackBudget')?.value ?? 1200);
  const full = budgetMB === 0;
  const old = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = full ? '⏳ 正在打包全部壁纸（约 5.6 GB）…' : `⏳ 正在打包壁纸（约 ${budgetMB} MB）…`; }
  try {
    /* ① 把壁纸本体复制进 SteamLens-离线版\wallpapers\（相对路径，整个文件夹可拷走）
       ② 重新固化快照，让离线 HTML 带上最新的数据与资源清单 */
    const r = await post('/api/offline/wallpaper-pack', { full, budgetMB });
    await post('/api/offline/refresh').catch(() => {});
    /* 把服务端刚写好的快照（含资源清单）拉到本机，离线页统计立刻刷新 */
    try { const snap = await api('/api/offline/snapshot'); OFF.saveSnapshot(snap); } catch {}
    renderOffline();
    loadWallpaper();
    toast(`已打包 ${r.items || 0} 款壁纸（${r.packedMB || 0} MB）到 SteamLens-离线版\\，双击里面那份 SteamLens-Offline.html 就能用`);
  } catch (e) { toast('打包失败：' + e.message); }
  finally { if (btn) { btn.disabled = false; btn.textContent = old; } }
});
$('#btnOfflineOpen')?.addEventListener('click', async () => {
  try { const r = await post('/api/offline/reveal', {}); toast('已打开：' + (r.dir || 'SteamLens-离线版')); }
  catch (e) { toast('打开文件夹失败：' + e.message); }
});
$('#btnOfflineNote')?.addEventListener('click', () => {
  const t = $('#offlineNoteText')?.value.trim(); if (!t) { toast('先写点内容'); return; }
  OFF.addNote(t); $('#offlineNoteText').value = '';
  renderOfflineNotes(); toast(OFF.online ? '已保存并排队同步' : '已存到本机，服务恢复后自动合并');
});

/* ==================================================================== */
/*  好友档案                                                            */
/* ==================================================================== */
function renderFriendProfiles() {
  if (!$('#friendProfileList')) return;
  const profiles = FP?.profiles || (F?.profiles?.profiles) || [];
  const friends = F?.friends || [];
  const libs = FL?.friends || {};
  if ($('#friendProfileTag')) {
    $('#friendProfileTag').textContent = `每秒更新 · ${Object.keys(libs).length || profiles.length} 份库中游戏 / ${friends.length} 位好友`;
  }
  $('#friendProfileList').innerHTML = friends.length
    ? `<div class="fp-grid">${slShown(friends, 'fpChips', 5).map(f => {
        const lb = libs[String(f.steamId64)];
        const n = lb ? (lb.appids || []).length : (f.profile?.libraryGames || 0);
        const brief = n ? `${n} 款库中游戏 · ${f.profile?.totalHours || 0} h` : '点这里从 Steam 读取档案';
        return `<button class="fp-chip" data-fp="${f.steamId64}">
        <span class="fp-chip-av">${f.avatar ? `<img src="${esc(f.avatar)}" onerror="this.remove()">` : esc(String(f.name || '?').slice(0, 1))}</span>
        <span class="fp-chip-main"><b>${esc(f.name)}</b><small>${esc(brief)}</small></span>
      </button>`;
      }).join('')}${slMoreBtn('fpChips', friends.length, 5, '显示更多好友')}</div>`
    : '<div class="mini-empty">好友名册为空。保持 Steam 客户端「好友与聊天」窗口开着即可自动带出好友。</div>';
  if (FP_ACTIVE) { renderFriendProfileDetail(FP_ACTIVE); renderFriendProfileGames(FP_ACTIVE); }
  updateFriendLibraryStatus(FP?.library || FL);
  // 首屏自动展开第一位好友的库中游戏，不必手动点
  if (!FP_ACTIVE_ID && friends.length) {
    FP_ACTIVE_ID = String(friends[0].steamId64);
    refreshFriendProfileLive();
  }
}

function updateFriendLibraryStatus(s) {
  const el = $('#friendLibraryStatus'); if (!el) return;
  const connected = s && s.connected !== false && s.ok !== false;
  if (!connected) {
    el.className = 'diag-line warn';
    el.innerHTML = '<i>!</i><span>还没连上 Steam 客户端：'
      + esc(s?.error || FL?.error || '请保持 Steam 与「好友与聊天」窗口开着')
      + '。当前显示保存在本机的数据。</span>';
    return;
  }
  const cnt = s?.friendCount ?? FL?.count ?? Object.keys(FL?.friends || {}).length;
  const apps = s?.totalApps ?? FL?.totalApps ?? 0;
  el.className = 'diag-line ok';
  el.innerHTML = '<i>✓</i><span>Steam 客户端已连接（端口 ' + esc(String(s?.port || FL?.port || '—'))
    + '）· 每秒读取 1 次 · 已读 ' + esc(String(s?.polls ?? '—')) + ' 次 · '
    + esc(String(cnt)) + ' 位好友 / ' + esc(String(apps)) + ' 款库中游戏'
    + (s?.error ? ' · ' + esc(s.error) : '') + '</span>';
}

function renderFriendProfileDetail(p) {
  if (!$('#friendProfileDetail')) return;
  if (!p) { $('#friendProfileDetail').innerHTML = ''; return; }
  if (!p.ok && (p.private || p.reason)) {
    $('#friendProfileDetail').innerHTML = `<div class="notice glass" style="margin-top:14px"><div class="notice-icon">◐</div>
      <div><h2>${esc(p.name || '这位好友')} 的游戏库暂不可见</h2><p>${esc(p.reason || '')}</p></div></div>`;
    return;
  }
  const t = p.totals || {};
  const hist = p.history || {};
  const tagText = p.live ? '每秒更新' : (p.fromCache ? '本机缓存' : '刚从 Steam 更新');
  $('#friendProfileDetail').innerHTML = `
    <div class="card-head" style="margin-top:18px"><h2>${esc(p.name || p.steamId64)} 的档案</h2>
      <span class="tag">${tagText} · ${esc(timeStr(p.fetchedAtIso || p.servedAtIso))}</span></div>
    ${p.stateLabel ? `<div class="diag-line ${p.personastate > 0 ? 'ok' : ''}"><i>●</i><span>当前 ${esc(p.stateLabel)}${p.currentGame ? ' · 正在玩 ' + esc(p.currentGame) : (p.lastGame ? ' · 最近在玩 ' + esc(p.lastGame) : '')}</span></div>` : ''}
    <div class="kpi-grid kpi-3">
      ${kpi('库中游戏', t.games ?? 0, '款', `玩过 ${t.playedGames ?? 0} 款 · 免费 ${t.freeGames ?? 0} 款`, 'rgba(47,109,246,.16)', '▤')}
      ${kpi('总游戏时长', t.totalHours ?? 0, '小时', `平均每款 ${t.avgHoursPerGame ?? 0} 小时`, 'rgba(122,99,245,.16)', '◷')}
      ${kpi('账号库价值', shortMoney(t.valueCents || 0), '', esc(p.valueNote || ''), 'rgba(16,179,156,.16)', '¥')}
    </div>
    <div class="grid-2" style="margin-top:14px">
      <div><div class="card-head"><h2 style="font-size:12px">玩得最多的游戏</h2></div>
        <div class="mini-list">${(p.topGames || []).slice(0, 8).map(g => `<div class="mini-item"><div class="mi-main"><b>${esc(g.name)}</b><small>AppID ${esc(g.appid)}${g.priceCents ? ' · 标价 ' + shortMoney(g.priceCents) : ''}</small></div><span class="mi-val">${g.playtimeKnown === false ? '时长 —' : (g.playtimeHours ?? 0) + ' h'}</span></div>`).join('') || '<div class="mini-empty">暂无游戏数据。</div>'}</div></div>
      <div><div class="card-head"><h2 style="font-size:12px">在本机的上线记录</h2></div>
        <div class="mini-list">
          <div class="mini-item"><div class="mi-main"><b>${hist.logins ?? 0} 次上线</b><small>累计在线 ${((hist.onlineMinutes || 0) / 60).toFixed(1)} 小时 · 记录 ${hist.trackedDays ?? 0} 天</small></div></div>
          ${(hist.events || []).slice(0, 6).map(e => `<div class="mini-item"><div class="mi-main"><b>${esc(e.text)}</b><small>${timeStr(e.iso)}</small></div></div>`).join('') || '<div class="mini-empty">还没有上线事件。</div>'}
        </div>
        <p class="fine" style="margin-top:8px">${esc(p.privacyNote || '')}</p>
      </div>
    </div>
    ${p.warning ? `<p class="fine" style="color:var(--amber);margin-top:10px">${esc(p.warning)}</p>` : ''}
    ${p.note ? `<p class="fine" style="margin-top:6px">${esc(p.note)}</p>` : ''}
    ${friendAchBlock(p.steamId64)}`;
}

/** 完整「库中的游戏」列表：每秒只重绘行，搜索框在静态 HTML 里，不会丢焦点 */
function renderFriendProfileGames(p) {
  const box = $('#fpLibraryTools'); if (!box) return;
  const all = (p && p.ok && Array.isArray(p.games)) ? p.games : [];
  box.hidden = !all.length;
  if (box.hidden) return;
  const q = FP_SEARCH.trim().toLowerCase();
  let rows = q
    ? all.filter(g => String(g.name || '').toLowerCase().includes(q) || String(g.appid || '').includes(q))
    : all.slice();
  const cmp = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
  if (FP_SORT === 'name') rows.sort(cmp);
  else if (FP_SORT === 'appid') rows.sort((a, b) => Number(a.appid) - Number(b.appid));
  else if (FP_SORT === 'price') rows.sort((a, b) => (Number(b.priceCents) || 0) - (Number(a.priceCents) || 0) || cmp(a, b));
  else rows.sort((a, b) => (Number(b.playtimeMin) || 0) - (Number(a.playtimeMin) || 0) || cmp(a, b));
  if ($('#fpGameCount')) $('#fpGameCount').textContent = String(all.length);
  if ($('#fpLiveTag')) $('#fpLiveTag').textContent = p.live
    ? `每秒更新 · ${p.secondsSinceSync ?? 0} 秒前同步` : '本机快照（离线）';
  const noImg = DEMO || (OFF && !OFF.online);
  $('#fpGameRows').innerHTML = rows.length ? rows.map(g => {
    const playing = !!p.currentGame && String(g.name) === String(p.currentGame);
    const cdn = steamCdn(g.appid);
    const icon = g.icon
      ? `<img src="${esc(g.icon)}" data-local="${esc(cdn)}" loading="lazy" onerror="slCoverFallback(this)">`
      : (noImg ? '' : `<img src="${esc(cdn)}" data-local="${esc(`/api/game/cover?appid=${g.appid}`)}" loading="lazy" onerror="slCoverFallback(this)">`);
    const hours = g.playtimeKnown === false ? '时长 —' : `${g.playtimeHours ?? 0} h`;
    const price = Number(g.priceCents) > 0 ? shortMoney(Number(g.priceCents)) : (g.priceKnown ? '免费 / 无价' : '暂无标价');
    return `<div class="fp-game-row${playing ? ' is-playing' : ''}" data-appid="${g.appid}" data-name="${esc(g.name || '')}" data-friend="${esc(FP_ACTIVE_ID || '')}" title="点击查看这个游戏的玩法与成就">
      <div class="fp-game-ico">${icon || esc(String(g.name || '?').slice(0, 1))}</div>
      <div class="fp-game-main"><b title="${esc(g.name)}">${esc(g.name)}</b><small>AppID ${esc(g.appid)}${playing ? ' · 正在玩' : ''} · 玩法 / 成就 ›</small></div>
      <div class="fp-game-meta"><b>${hours}</b><small>${price}</small></div>
    </div>`;
  }).join('') : '<div class="fp-game-empty">没有匹配的游戏，换个关键词试试。</div>';
}

/** 服务关闭时，用本机快照里的库中游戏构造档案（离线版也能看） */
function offlineLive(id) {
  const lib = FL?.friends?.[String(id)];
  const saved = (FP?.profiles || []).find(x => String(x.steamId64) === String(id));
  if (!lib && !saved) return null;
  const games = (lib?.games || []).map(g => ({
    appid: String(g.appid), name: String(g.name || `App ${g.appid}`),
    icon: g.iconUrl || (String(g.icon || '').startsWith('http') ? g.icon : ''),
    playtimeMin: 0, playtimeHours: 0, playtimeKnown: false,
    priceCents: Number(g.priceCents) || 0, priceKnown: !!g.priceKnown
  }));
  const valueCents = games.reduce((s, g) => s + (g.priceCents > 0 ? g.priceCents : 0), 0);
  return {
    ok: true, live: false, steamId64: String(id),
    name: lib?.name || saved?.name || `Steam ${String(id).slice(-6)}`,
    avatar: lib?.avatar || saved?.avatar || '',
    stateLabel: '', currentGame: '', servedAtIso: new Date().toISOString(),
    fetchedAtIso: FL?.iso || saved?.fetchedAtIso || '',
    libraryCount: games.length, hasApiProfile: !!saved,
    totals: { games: games.length, totalHours: saved?.totalHours || 0, playedGames: 0,
      valueCents, valueYuan: Math.round(valueCents) / 100, pricedCount: games.filter(g => g.priceKnown).length,
      freeGames: 0, avgHoursPerGame: 0 },
    games, topGames: games.slice(0, 10),
    history: { events: [], logins: 0, onlineMinutes: 0, trackedDays: 0, eventCount: 0 },
    valueNote: '按本机价格缓存估算。', privacyNote: '',
    warning: '当前是离线模式：显示保存在本机的库中游戏快照；服务恢复后会自动重新每秒更新。'
  };
}

/** 每秒从本机拉一次好友档案（不联网、不写盘），只更新档案区与游戏列表 */
async function refreshFriendProfileLive() {
  if (!FP_ACTIVE_ID || FP_LOADING) return;
  let p = null;
  if (OFF && !OFF.online) {
    p = offlineLive(FP_ACTIVE_ID);
  } else {
    try {
      p = await api(`/api/friend-profile?steamId64=${encodeURIComponent(FP_ACTIVE_ID)}&live=1`);
      FP_LIVE_FAILS = 0;
      if (p?.libraryStatus) updateFriendLibraryStatus(p.libraryStatus);
    } catch {
      FP_LIVE_FAILS++;
      if (FP_LIVE_FAILS > 2) p = offlineLive(FP_ACTIVE_ID);
    }
  }
  if (!p) return;
  FP_ACTIVE = p;
  renderFriendProfileDetail(p);
  renderFriendProfileGames(p);
  if (p.ok && $('#friendProfileTag')) {
    $('#friendProfileTag').textContent = `每秒更新 · ${p.totals?.games ?? 0} 款库中游戏 · ${p.secondsSinceSync ?? 0} 秒前同步`;
  }
}
setInterval(refreshFriendProfileLive, 1000);

async function openFriendProfile(id, refresh = false) {
  if (!id || FP_LOADING) return;
  const changed = FP_ACTIVE_ID !== String(id);
  FP_ACTIVE_ID = String(id);
  /* 打开某位好友的档案时，也自动把他的关系链 / 游戏库排到扫描队首（只在换人时触发） */
  if (changed && !refresh) post('/api/friend/fof/auto', { enabled: true, kick: FP_ACTIVE_ID }).catch(() => {});
  dossierTick();   // 切到这位好友时，档案里的时长 / 朋友的朋友 / 徽章立刻跟着切换
  FP_SEARCH = '';
  if ($('#fpGameSearch')) $('#fpGameSearch').value = '';
  FP_LOADING = true;
  try {
    if (OFF && !OFF.online) {
      FP_ACTIVE = offlineLive(id) || {
        ok: false, private: true, name: '离线',
        reason: '本机快照里还没有这位好友的库中游戏。服务器恢复后会自动重新读取。'
      };
      renderFriendProfileDetail(FP_ACTIVE); renderFriendProfileGames(FP_ACTIVE);
      toast('离线模式：显示保存在本机的库中游戏快照');
      return;
    }
    if ($('#friendProfileDetail')) $('#friendProfileDetail').innerHTML = '<div class="mini-empty">正在从 Steam 客户端读取这位好友的库中游戏…</div>';
    const body = { steamId64: id, refresh };
    const pasted = $('#fpPasted')?.value.trim();
    if (pasted) body.pasted = pasted;
    const r = await post('/api/friend-profile', body);
    if (r.offlineQueued) {
      toast('离线状态：服务恢复后再点一次即可');
      FP_ACTIVE = offlineLive(id) || { ok: false, private: true, name: '离线', reason: '服务恢复后会自动读取好友库。' };
      renderFriendProfileDetail(FP_ACTIVE); renderFriendProfileGames(FP_ACTIVE);
      return;
    }
    FP_ACTIVE = r; renderFriendProfileDetail(r); renderFriendProfileGames(r);
    FP = await api('/api/friend-profiles').catch(() => FP);
    F = await api('/api/friends').catch(() => F);
    FL = await api('/api/friend-library/list').catch(() => FL);
    renderFriendProfiles();
    toast(r.ok ? `已读到 ${r.name || '好友'} 的库：${r.totals?.games || 0} 款 / ¥${r.totals?.valueYuan || 0}` : (r.reason || '档案不可读'));
    await refreshFriendProfileLive();
  } catch (e) { toast('读取好友档案失败：' + e.message); }
  finally { FP_LOADING = false; }
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-fp]'); if (!b) return;
  openFriendProfile(b.dataset.fp, true);
});
$('#fpPastedToggle')?.addEventListener('change', e => {
  if ($('#fpPastedBox')) $('#fpPastedBox').hidden = !e.target.checked;
});
$('#fpGameSearch')?.addEventListener('input', e => {
  FP_SEARCH = String(e.target.value || '');
  renderFriendProfileGames(FP_ACTIVE);
});
$('#fpGameSort')?.addEventListener('change', e => {
  FP_SORT = String(e.target.value || 'time');
  renderFriendProfileGames(FP_ACTIVE);
});
$('#btnFriendLibraryRefresh')?.addEventListener('click', async () => {
  if (OFF && !OFF.online) { toast('离线模式：显示保存在本机的数据'); return; }
  toast('正在请 Steam 客户端重新读取好友游戏库…');
  try {
    const r = await post('/api/friend-library/refresh', { steamId64: FP_ACTIVE_ID || '' });
    toast(r.ok ? `已重新读取：${r.totalApps ?? 0} 款游戏` : ('未成功：' + (r.error || '')));
    FL = await api('/api/friend-library/list').catch(() => FL);
    await refreshFriendProfileLive();
  } catch (e) { toast('刷新失败：' + e.message); }
});
$('#btnFriendProfileAll')?.addEventListener('click', async () => {
  const ids = (F?.friends || []).slice(0, 12).map(f => f.steamId64);
  if (!ids.length) { toast('好友名册为空'); return; }
  toast(`开始批量刷新 ${ids.length} 位好友的档案…`);
  for (const id of ids) {
    try { await post('/api/friend-profile', { steamId64: id, refresh: false }); } catch {}
  }
  FP = await api('/api/friend-profiles').catch(() => FP);
  F = await api('/api/friends').catch(() => F);
  FL = await api('/api/friend-library/list').catch(() => FL);
  renderFriendProfiles(); toast('批量刷新完成');
});

/* ==================================================================== */
/*  个性化：我的照片壁纸（小红车 project.json 完整原图）+ 自定义开场视频      */
/*  以及「开发者开场动画优先，个性化自动让位」的统一开关逻辑                  */
/*  放在 boot() 之前，保证启动时这些常量已经初始化，不会踩到 TDZ。           */
/* ==================================================================== */
const PERSONAL_PHOTO_ID = 'sl-my-photo';
const PB_KEY = 'sl-personal-boot-video';
let PERSONAL = { photo: { exists: false }, video: { exists: false }, limits: {} };
let PB_RUNNING = false;

function pbEnabled() {
  try { return localStorage.getItem(PB_KEY) === '1'; } catch { return false; }
}
function pbSetEnabled(on) {
  try { if (on) localStorage.setItem(PB_KEY, '1'); else localStorage.removeItem(PB_KEY); } catch {}
  const chk = $('#chkBootVideo'); if (chk) chk.checked = !!on;
  pbSyncUI();
}
function pbSyncUI() {
  const on = pbEnabled(), has = !!PERSONAL?.video?.exists;
  const tag = $('#bootVideoTag');
  if (tag) tag.textContent = on ? (has ? '已启用' : '已启用 · 缺视频') : '未启用';
  const hint = $('#bootVideoHint');
  if (hint) hint.textContent = has
    ? `已保存：${PERSONAL.video.name}（${PERSONAL.video.sizeMB} MB）。${on ? '下次打开 / 刷新软件时播放，播完才进入界面。' : '开关关闭，不会播放。'}若开发者开场动画也启用，只会播开发者那个，本开关会自动关掉。`
    : `还没选视频。点「📂 选择视频」上传一段本机视频（只支持视频文件，最大 ${PERSONAL?.limits?.videoMB || 512} MB）。`;
  const pt = $('#photoWpTag');
  if (pt) pt.textContent = PERSONAL?.photo?.exists ? `已保存 · ${PERSONAL.photo.sizeMB} MB` : '未设置';
}
async function personalRefresh() {
  try { PERSONAL = await api('/api/personal/status'); }
  catch { PERSONAL = { photo: { exists: false }, video: { exists: false }, limits: {} }; }
  const pv = $('#photoWpPreview');
  if (pv) {
    pv.innerHTML = PERSONAL?.photo?.exists
      ? `<img src="${esc(PERSONAL.photo.mediaUrl)}" alt="我的照片壁纸"><p class="fine">已保存为小红车同款本地壁纸（ID <b>${esc(PERSONAL.photo.itemId)}</b>），软件走<b>完整原图</b>通道加载，不是缩略图。<br>文件：${esc(PERSONAL.photo.name)} · ${PERSONAL.photo.sizeMB} MB</p>`
      : '<p class="fine">还没选照片。选一张后点「🖼 用这张照片做壁纸」即可。</p>';
  }
  const ph = $('#photoWpHint');
  if (ph) ph.textContent = PERSONAL?.photo?.exists
    ? `照片只保存在本机 ${PERSONAL.photo.dir}，不写进 Steam 目录、不上传任何地方。`
    : `支持 PNG / JPG / WEBP / BMP / GIF，最大 ${PERSONAL?.limits?.photoMB || 64} MB。`;
  const chk = $('#chkBootVideo'); if (chk) chk.checked = pbEnabled();
  pbSyncUI();
}
function personalExt(name) {
  const m = String(name || '').match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : '';
}
async function personalUpload(file, kind) {
  const url = `/api/personal/upload?kind=${kind}&ext=${encodeURIComponent(personalExt(file.name))}`;
  const r = await fetch(url, { method: 'POST', body: file, cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
  PERSONAL = j;
  return j;
}

/* ---------------- 我的照片壁纸：原图落盘 + 立刻按小红车方式应用 ---------------- */
$('#btnPhotoPick')?.addEventListener('click', () => $('#photoWpFile')?.click());
$('#photoWpFile')?.addEventListener('change', e => {
  const f = e.target.files?.[0]; if (!f) return;
  if (!/^image\//.test(f.type || '')) { toast('照片壁纸只能放图片文件'); e.target.value = ''; return; }
  const pv = $('#photoWpPreview');
  if (pv) {
    pv.innerHTML = `<img src="${URL.createObjectURL(f)}" alt="待上传的照片"><p class="fine">待应用：<b>${esc(f.name)}</b>（${(f.size / 1048576).toFixed(1)} MB）。点「🖼 用这张照片做壁纸」保存成小红车同款项目并立即应用。</p>`;
  }
});
$('#btnPhotoApply')?.addEventListener('click', async () => {
  const f = $('#photoWpFile')?.files?.[0];
  if (!f) { toast('先点「📂 选择照片」选一张'); return; }
  const btn = $('#btnPhotoApply');
  if (btn) { btn.disabled = true; btn.textContent = '正在保存…'; }
  try {
    await personalUpload(f, 'photo');
    if (!wpOffline()) { try { WP = await api('/api/wallpaper/status'); } catch {} }
    /* 高清 + 不压暗 + 不模糊：照片保持原始分辨率，不再像预览图那样发虚 */
    await wpSet({ enabled: true, id: PERSONAL_PHOTO_ID, src: 'local', crisp: true, dim: 0, blur: 0, ui: 16 });
    await personalRefresh();
    toast('照片已按小红车格式保存，并用完整原图设为壁纸');
  } catch (e) { toast('照片壁纸设置失败：' + e.message); }
  finally {
    if (btn) { btn.disabled = false; btn.textContent = '🖼 用这张照片做壁纸'; }
    const input = $('#photoWpFile'); if (input) input.value = '';
  }
});
$('#btnPhotoRemove')?.addEventListener('click', async () => {
  try {
    PERSONAL = await post('/api/personal/remove', { kind: 'photo' });
    if (WP?.config?.id === PERSONAL_PHOTO_ID) await wpSet({ enabled: false, id: '', src: 'local' });
    await personalRefresh();
    toast('照片壁纸已移除');
  } catch (e) { toast('移除失败：' + e.message); }
});

/* ---------------- 自定义开场动画：只能放视频，播完才进软件 ---------------- */
function personalVideoUrl() {
  if (wpOffline()) return String(window.SL_WP_BASE || '') + 'media/boot-video.mp4';
  return '/api/personal/video?v=' + Date.now();
}
function playPersonalBootVideo() {
  const mask = $('#personalBootVideo'), v = $('#pbVideo');
  if (!mask || !v || PB_RUNNING) return false;
  PB_RUNNING = true;
  mask.hidden = false;
  document.body.classList.add('boot-locked');
  let finished = false, guard = 0;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(guard);
    try { v.pause(); } catch {}
    v.removeEventListener('loadeddata', onLoad);
    v.removeEventListener('ended', finish);
    v.removeEventListener('error', finish);
    mask.removeEventListener('click', finish);
    document.removeEventListener('keydown', onKey);
    v.removeAttribute('src');
    try { v.load(); } catch {}
    mask.hidden = true;
    document.body.classList.remove('boot-locked');
    PB_RUNNING = false;
  };
  const onKey = e => { if (e.key === 'Escape') finish(); };
  const onLoad = () => {
    /* 先试着带声音自动播；浏览器拦自动播放就退回静音，再不行直接进软件 */
    v.muted = false;
    const p = v.play();
    if (p && p.catch) p.catch(() => {
      v.muted = true;
      const q = v.play();
      if (q && q.catch) q.catch(finish);
    });
  };
  v.addEventListener('loadeddata', onLoad);
  v.addEventListener('ended', finish);
  v.addEventListener('error', finish);     // 离线版没有这个视频时直接进软件，不卡住
  mask.addEventListener('click', finish);
  document.addEventListener('keydown', onKey);
  guard = setTimeout(finish, 90000);       // 兜底：再长也不让用户被卡在黑屏
  v.src = personalVideoUrl();
  v.load();
  return true;
}
window.addEventListener('pagehide', () => {
  const m = $('#personalBootVideo');
  if (m && !m.hidden) { m.hidden = true; document.body.classList.remove('boot-locked'); PB_RUNNING = false; }
});
$('#btnBootVideoPick')?.addEventListener('click', () => $('#bootVideoFile')?.click());
$('#bootVideoFile')?.addEventListener('change', async e => {
  const f = e.target.files?.[0]; if (!f) return;
  /* 用户要求「开场动画只能放视频」：图片 / 文本 / 其它一律拒绝，不落盘 */
  if (!/^video\//.test(f.type || '')) { toast('开场动画只能放视频文件'); e.target.value = ''; return; }
  const hint = $('#bootVideoHint');
  if (hint) hint.textContent = `正在保存 ${f.name}（${(f.size / 1048576).toFixed(1)} MB）…`;
  try {
    await personalUpload(f, 'video');
    /* 开发者动画开着时保持让位：只存视频、不自动启用 */
    if (bootSplashEnabled()) { pbSetEnabled(false); toast('视频已保存；开发者开场动画已启用，个性化开场动画保持关闭'); }
    else { pbSetEnabled(true); toast('开场视频已保存并启用，下次打开软件时播放'); }
    await personalRefresh();
  } catch (er) { toast('视频保存失败：' + er.message); await personalRefresh(); }
  finally { e.target.value = ''; }
});
$('#chkBootVideo')?.addEventListener('change', e => {
  if (e.target.checked && !PERSONAL?.video?.exists) { e.target.checked = false; toast('先选一段视频再启用'); return; }
  if (e.target.checked && bootSplashEnabled()) {
    e.target.checked = false;
    toast('开发者开场动画已启用，个性化开场动画会自动关掉');
    return;
  }
  pbSetEnabled(e.target.checked);
  toast(e.target.checked ? '已启用：下次打开 / 刷新软件时播放，播完进入界面' : '已关闭自定义开场视频');
});
$('#btnBootVideoPreview')?.addEventListener('click', () => {
  if (!PERSONAL?.video?.exists) { toast('先选一段视频'); return; }
  playPersonalBootVideo();
});
$('#btnBootVideoRemove')?.addEventListener('click', async () => {
  try {
    PERSONAL = await post('/api/personal/remove', { kind: 'video' });
    pbSetEnabled(false);
    await personalRefresh();
    toast('开场视频已删除');
  } catch (e) { toast('删除失败：' + e.message); }
});
personalRefresh();   // 页面加载即回填状态，不依赖 boot() 的时序

/* ==================================================================== */
/*  只删软件上的好友：以 Steam 好友名单为准，绝不动 Steam 好友关系          */
/* ==================================================================== */
let FC_DATA = null;
async function friendCleanOpen() {
  const mask = $('#friendCleanModal'); if (!mask) return;
  mask.classList.remove('hidden');
  const body = $('#friendCleanBody');
  if (body) body.innerHTML = '<div class="mini-empty">正在识别 Steam 好友名单…</div>';
  try { FC_DATA = await api('/api/friends/clean/analyze'); }
  catch (e) {
    FC_DATA = null;
    if (body) body.innerHTML = `<div class="mini-empty">识别失败：${esc(e.message)}</div>`;
    return;
  }
  friendCleanRender();
}
function friendCleanRender() {
  const d = FC_DATA, body = $('#friendCleanBody'); if (!d || !body) return;
  const src = (d.sources || []).map(s => `${s.name} ${s.count} 位`).join(' · ') || '尚未识别到';
  let html = `<div class="fc-sum">
      <span class="tag">Steam 好友 ${d.rosterCount} 位（保留）</span>
      <span class="tag warn">软件里多出来 ${(d.orphans || []).length} 位</span>
      <span class="tag">已删 ${(d.removed || []).length} 位</span></div>
    <p class="fine">识别依据：${esc(src)}${d.fresh ? '' : '（使用上次确认的名单）'}。勾选的人<b>只会从 SteamLens 软件里移除</b>，Steam 好友关系不变。</p>`;
  html += `<div class="fc-sec">✓ 保留的 Steam 好友（${(d.keep || []).length}）</div>`;
  html += (d.keep || []).map(x => `<div class="fc-row"><b>${esc(x.name)}</b><small>${esc(x.steamId64)}</small></div>`).join('')
    || '<div class="mini-empty">还没识别到 Steam 好友名单。</div>';
  html += `<div class="fc-sec">可以删掉的「其他好友」（${(d.orphans || []).length}）· 默认全选</div>`;
  html += (d.orphans || []).map(x => `<label class="fc-row">
      <input type="checkbox" checked data-fc-id="${esc(x.steamId64)}">
      <b>${esc(x.name)}</b><small>${esc(x.source)} · ${esc(x.steamId64)}</small></label>`).join('')
    || '<div class="mini-empty">没有非 Steam 好友，软件里的列表已经和 Steam 一致。</div>';
  if ((d.removed || []).length) {
    html += `<div class="fc-sec">已从软件删除（${d.removed.length}）· 可一键恢复</div>`;
    html += d.removed.slice(0, 20).map(x => `<div class="fc-row"><b>${esc(x.name)}</b><small>${esc(x.reason || '')}</small></div>`).join('');
  }
  body.innerHTML = html;
}
async function friendCleanApply(mode, ids) {
  try {
    const r = await post('/api/friends/clean/remove', mode === 'orphans' ? { mode: 'orphans' } : { ids });
    if (!r.ok) { toast(r.error || '删除失败'); return; }
    F = await api('/api/friends?refresh=1').catch(() => F);
    friendCacheSave(true);
    renderFriends(); renderHeader();
    FC_DATA = await api('/api/friends/clean/analyze').catch(() => null);
    friendCleanRender();
    toast(`已从软件删除 ${r.removedCount} 位好友（Steam 好友关系不变）`);
  } catch (e) { toast('删除失败：' + e.message); }
}
function friendCleanClose() { $('#friendCleanModal')?.classList.add('hidden'); }
$('#btnDeleteFriends')?.addEventListener('click', friendCleanOpen);
$('#btnFriendCleanClose')?.addEventListener('click', friendCleanClose);
$('#friendCleanModal')?.addEventListener('click', e => { if (e.target.id === 'friendCleanModal') friendCleanClose(); });
$('#btnFriendCleanApply')?.addEventListener('click', () => {
  const ids = [...document.querySelectorAll('#friendCleanBody [data-fc-id]:checked')]
    .map(x => x.getAttribute('data-fc-id'));
  if (!ids.length) { toast('先勾选要删掉的好友'); return; }
  friendCleanApply('ids', ids);
});
$('#btnFriendCleanAll')?.addEventListener('click', () => friendCleanApply('orphans'));
$('#btnFriendCleanRestore')?.addEventListener('click', async () => {
  try {
    const r = await post('/api/friends/clean/restore', {});
    F = await api('/api/friends?refresh=1').catch(() => F);
    friendCacheSave(true);
    renderFriends(); renderHeader();
    FC_DATA = await api('/api/friends/clean/analyze').catch(() => null);
    friendCleanRender();
    toast(`已恢复 ${r.restoredCount} 位好友到软件列表`);
  } catch (e) { toast('恢复失败：' + e.message); }
});
/* 每张好友卡片右上角的 ✕：单独把这位从软件里移除 */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-fdel]'); if (!b) return;
  const id = b.getAttribute('data-fdel');
  if (!confirm('只从 SteamLens 软件里移除这位好友？\n\nSteam 上的好友关系不会有任何变化；之后可以在「🗑 删掉好友」里恢复。')) return;
  friendCleanApply('ids', [id]);
});
/* 设置页那个旧的「清理非好友」统一走同一个弹窗，避免两套逻辑 */
const pruneBtn = $('#btnPruneFriends');
if (pruneBtn) {
  pruneBtn.onclick = () => friendCleanOpen();
  pruneBtn.removeAttribute('data-old-prune');
}

/* ==================================================================== */
/*  档案整合：玩了多久 / 什么时候玩了什么 / 朋友的朋友 / 徽章             */
/*  数据全部来自本机聚合接口，不联网、不等 Key，所以「看明细」能秒开       */
/* ==================================================================== */
let DOS_LOADING = false;
async function dossierTick() {
  if (!FP_ACTIVE_ID || DOS_LOADING || document.hidden) return;
  DOS_LOADING = true;
  try {
    const d = await api(`/api/friend/dossier?steamId64=${encodeURIComponent(FP_ACTIVE_ID)}`);
    if (String(d?.steamId64 || '') !== FP_ACTIVE_ID) return;
    dossierRender(d);
  } catch {} finally { DOS_LOADING = false; }
}
function dossierRender(d) {
  const tag = $('#fpDossierTag');
  if (tag) tag.textContent = '每秒更新 · ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const kb = $('#fpDossierTime');
  if (kb) kb.innerHTML =
    kpi('本机累计在线', (d.totalHours || 0) + ' h', '', `${d.eventCount || 0} 条上线记录`, 'rgba(47,109,246,.16)', '◷') +
    kpi('库中游戏', (d.gameCount || 0) + ' 款', '', d.hasLibrary ? '本机已读取' : '库未读', 'rgba(16,179,156,.16)', '▸') +
    kpi('朋友的朋友', (d.fofCount || 0) + ' 人', '', d.discoverAt ? '关系链已扫描' : '尚未扫描', 'rgba(122,99,245,.16)', '👥');
  const tl = $('#fpDossierTimeline');
  if (tl) {
    const rows = Array.isArray(d.timeline) ? d.timeline : [];
    tl.innerHTML = rows.length
      ? rows.slice(0, 8).map(x => `<div class="mini-item fd-rec" data-pt-rec="1"
          data-pt-game="${esc(x.name || '上线记录')}" data-pt-min="${Math.round((Number(d.totalMin) || 0) / Math.max(1, d.eventCount || 1))}"
          data-pt-when="${esc(x.atLabel)}" data-pt-extra="${esc(x.source)}">
          <div class="mi-main"><b>${esc(x.name || x.text || '上线记录')}</b>
          <small>${esc(x.atLabel)} · ${esc(x.text || x.source)}</small></div></div>`).join('')
        + (rows.length > 8 ? `<p class="fine">共 ${rows.length} 条记录，这里显示最近 8 条。</p>` : '')
      : '<div class="mini-empty">还没有这位好友的上线 / 玩游戏记录。他上线或开始玩游戏时，软件会自动把时间记到本机。</div>';
  }
  const ft = $('#fpFofTag'); if (ft) ft.textContent = `${d.fofCount || 0} 人`;
  const fl = $('#fpFofList');
  if (fl) fl.innerHTML = (d.fof || []).length
    ? d.fof.slice(0, 10).map(p => `<div class="mini-item"><div class="mi-main">
        <b>${esc(p.name || p.steamId64)}</b><small>${esc(p.steamId64)} · 库中 ${p.gameCount || 0} 款${
        (p.games || []).length ? '：' + esc(p.games.slice(0, 4).map(g => g.name).join('、')) : ''}</small></div></div>`).join('')
    : '<div class="mini-empty">还没扫到他的朋友的朋友。已开启自动扫描，软件会自己打开 Steam 网页端好友列表页采关系链、再逐个采他们的游戏库；本档案每秒刷新，采到就出现。</div>';
  const fn = $('#fpFofNote');
  if (fn) {
    const as = d.autoScan;
    const base = d.fofSource?.at
      ? `上次从浏览器采集：${timeStr(d.fofSource.at)}，采到 ${d.fofSource.count} 人。`
      : '还没从浏览器采到好友列表。';
    const auto = as
      ? `自动扫描${as.enabled ? (as.connected ? '运行中' : '等待浏览器') : '已关闭'} · 好友列表 ${as.scanned?.fof || 0} 次 / 游戏库 ${as.scanned?.library || 0} 次 · 待扫 ${as.queued || 0}${as.note ? ' · ' + String(as.note) : ''}。`
      : '';
    fn.textContent = base + auto + `关系链扫描时间：${d.discoverAt ? String(d.discoverAt).replace('T', ' ').slice(0, 19) : '未扫描'}。`;
  }
  const bt = $('#fpBadgeTag'); if (bt) bt.textContent = `${d.badges?.count || 0} 枚`;
  const bl = $('#fpBadgeList');
  if (bl) bl.innerHTML = (d.badges?.badges || []).length
    ? d.badges.badges.slice(0, 20).map(b => `<div class="mini-item"><div class="mi-main">
        <b>🏅 ${esc(b.name)}</b><small>${b.level ? '等级 ' + esc(b.level) : ''}${b.xp ? ' · ' + esc(b.xp) + ' XP' : ''}</small></div></div>`).join('')
    : '<div class="mini-empty">还没有徽章记录。点好友卡片「👥 朋友的朋友」弹窗里的「打开他的徽章页」即可采集。</div>';
}
setInterval(dossierTick, 1000);

async function openFofPage(id) {
  if (!/^\d{17}$/.test(String(id || ''))) { toast('先选一位好友'); return; }
  try {
    const r = await post('/api/friend/fof/auto', { enabled: true, kick: String(id) });
    toast(r?.connected
      ? '已把他排到自动扫描队首：网页端会自己打开好友列表页，再采这些人的游戏库'
      : '已排队；请先在已登录 Steam 的浏览器里连接一次（浏览器扫描页可一键启动）');
  } catch (e) { toast('启动自动扫描失败：' + e.message); }
}
$('#btnFpFofScan')?.addEventListener('click', () => openFofPage(FP_ACTIVE_ID));
$('#btnFnFofOpen')?.addEventListener('click', () => openFofPage(FN_ID));

/* ---------------- 自动巡航：打开 / 关闭（状态以服务端为准，服务重启不丢） ---------------- */
async function autoCruiseRefresh() {
  try {
    const s = await api('/api/friend/fof/auto');
    const on = !!s.enabled;
    const chk = $('#chkAutoCruise'); if (chk) chk.checked = on;
    const tag = $('#autoCruiseTag');
    if (tag) tag.textContent = !on ? '已关闭' : (s.connected ? '运行中' : '等待浏览器');
    const dot = $('#autoCruiseDot'); if (dot) dot.classList.toggle('live', on && !!s.connected);
    const note = $('#autoCruiseNote');
    if (note) {
      const bits = [String(s.hint || '')];
      bits.push(`商店 ${s.scanned?.shop || 0} 次 · 好友列表 ${s.scanned?.fof || 0} 次 · 徽章 ${s.scanned?.badges || 0} 次 · 游戏库 ${s.scanned?.library || 0} 次 · 待扫 ${s.queued || 0}`);
      if (s.lastShop) bits.push(`上次商店：已购 ${s.lastShop.owned} / 愿望单 ${s.lastShop.wishlist} / 购物车 ${s.lastShop.cart}`);
      if (typeof s.badgeCount === 'number') bits.push(`已存徽章档案 ${s.badgeCount} 人`);
      if (s.note) bits.push(String(s.note));
      if (s.lastError) bits.push('提示：' + String(s.lastError));
      note.textContent = bits.join(' · ');
    }
  } catch {
    const note = $('#autoCruiseNote');
    if (note) note.textContent = '读不到本机服务，恢复后会自动继续（离线版没有服务端巡航）。';
  }
}
$('#chkAutoCruise')?.addEventListener('change', async e => {
  const want = !!e.target.checked;
  try {
    await post('/api/friend/fof/auto', { enabled: want });
    toast(want ? '自动巡航已打开' : '自动巡航已关闭');
    autoCruiseRefresh();
  } catch (err) {
    toast('设置失败：' + err.message);
    e.target.checked = !want;
  }
});
$('#btnAutoCruiseRescan')?.addEventListener('click', async () => {
  try {
    await post('/api/friend/fof/auto', { enabled: true, rescan: true });
    toast('已重新开始一轮自动巡航'); autoCruiseRefresh();
  } catch (err) { toast('重扫失败：' + err.message); }
});
setInterval(autoCruiseRefresh, 3000);
autoCruiseRefresh();
/* 「朋友的朋友」关系链列表也改成每秒刷新（只读本机缓存，不联网） */
let DISC_TICK = false;
setInterval(async () => {
  if (DISC_TICK || document.hidden || typeof loadDiscover !== 'function') return;
  const page = document.querySelector('#page-friends');
  if (page && !page.classList.contains('active')) return;
  DISC_TICK = true;
  try { await loadDiscover(false); } catch {} finally { DISC_TICK = false; }
}, 1000);

/* ==================================================================== */
/*  启动：先恢复服务端设置，再拉数据，最后一次性全量回填所有页面          */
/* ==================================================================== */
(async function boot() {
  /* 打开软件先把上次关闭时保存的好友记录渲染出来，再去 Steam 更新；
     不等网络、不等 Steam 客户端冷启动，界面一上来就有好友。 */
  try { friendCacheHydrate(); } catch {}
  /* 开场动画优先级：开发者启动页 > 个性化自定义视频 > 直接进软件。
     两者同时开着时只播开发者那个，并且把个性化开关自动关掉（用户明确要求）。 */
  try {
    if (bootSplashEnabled()) {
      if (pbEnabled()) pbSetEnabled(false);
      playBootSplash('boot');
    } else if (pbEnabled()) {
      playPersonalBootVideo();
    }
  } catch {}
  if (new URLSearchParams(location.search).get('overlay') === '1') {
    document.body.classList.add('overlay-mode');
  }
  // 1) 服务端设置为准（白色默认）；离线时改用本机快照里的界面设置
  try { UI = (await api('/api/ui-settings')).settings || null; } catch { UI = OFF?.snapshot()?.uiSettings || null; }
  restoreUiState(UI || { theme: 'light' });
  /* 回填结束后再以 localStorage 为准同步一次开场视频开关，
     保证「开发者优先 → 个性化自动关掉」在界面上也是关着的。 */
  try { const c = $('#chkBootVideo'); if (c) c.checked = pbEnabled(); pbSyncUI(); } catch {}

  // 2) 拉取真实数据（失败时自动用本机快照）
  await load(false);

  // 3) 一次性回填所有页面（不只当前打开的那一页）
  RESTORING = true;
  try {
    await fillConfig();
    fillFriendConfig(); fillAccount(); fillNotify(); fillWechat(); fillQq(); fillBrowser(); fillDingtalk();
  } finally {
    setTimeout(() => { RESTORING = false; }, 150);
  }

  // 4) 恢复页签
  const hash = location.hash.replace('#', '');
  const page = (hash && PAGE_META[hash]) ? hash : (UI?.page && PAGE_META[UI.page] ? UI.page : 'overview');
  go(page);
  renderAll();
  startBrowserPoll();
  setSaveBadge('ok');

  // 壁纸启动兜底：服务刚起来时素材清单可能还没扫完，延迟再拉一次配置并强制唤醒播放，
  // 避免「第一次启动壁纸停在第一帧、必须刷新页面才动」。
  setTimeout(async () => {
    try { await loadWallpaper(); } catch {}
    try { applyWallpaper(); } catch {}
  }, 900);
  setTimeout(() => { try { applyWallpaper(); } catch {} }, 2600);

  // 总览每分钟自动更新一次：服务端每 60 秒也从本机 Steam 客户端重新提取一遍，
  // 这里把总览 / 库价值 / 顶栏一起重绘（不重绘表单，避免打断正在输入的内容）。
  setInterval(async () => {
    if (document.hidden) return;
    try {
      await load(false);
      renderHeader(); renderOverview(); renderValue();
    } catch {}
  }, 60000);

  // 6) 好友上线自动显示：服务端每 3 秒直读 Steam 客户端，前端每 5 秒跟上
  setInterval(async () => {
    if (document.hidden) return;
    try { await loadFriendDiagnosis(); } catch {}
    try {
      const f = await api('/api/friends');
      if (f) { F = f; checkFriendNotifications(); renderFriends(); renderHeader(); }
    } catch {}
  }, 5000);

  // 5) 离线守护：每 4 秒探测服务；恢复后自动合并离线改动并切回实时数据
  if (OFF) {
    initOfflineTakeover();
    renderOfflineTakeover();
    OFF.startWatcher((up, pending) => {
      renderOffline();
      renderOfflineTakeover();
      if (!up) {
        const b = $('#statusBadge');
        if (b) b.innerHTML = `<span class="dot warn"></span><span>离线 · 本机数据${pending ? ' · 待同步 ' + pending : ''}</span>`;
      }
    }, async (res) => {
      toast(`服务已恢复：已合并 ${res.applied || 0} 条离线改动`);
      await load(true);
      renderOffline();
    });
  }
})();

/* ==================================================================== */
/*  愿望单监控：添加游戏 / 价格 / 折扣 / 上线提醒 / 每分钟自动运行       */
/* ==================================================================== */
const watchOff = () => DEMO || (OFF && OFF.online === false);
async function loadWatch() {
  if (!watchOff()) {
    try { WATCH = await api('/api/watchlist/status'); } catch { /* 回退本机快照 */ }
  }
  if (!WATCH) {
    const snap = OFF && OFF.snapshot ? OFF.snapshot() : (window.SL_OFFLINE_DATA || null);
    WATCH = (snap && snap.watchStatus) || { ok: true, items: [], alerts: [], autoEnabled: true, total: 0 };
  }
  fillWatchLocal();
  renderWatch();
}
function fillWatchLocal() {
  const sel = $('#watchLocalSelect'); if (!sel) return;
  const cur = sel.value;
  const games = (S && Array.isArray(S.games)) ? S.games : [];
  const inList = new Set((WATCH?.items || []).map(x => String(x.appid)));
  sel.innerHTML = '<option value="">从本机 Steam 游戏库选…</option>'
    + games.filter(g => !inList.has(String(g.appid))).slice(0, 400)
      .map(g => `<option value="${esc(g.appid)}">${esc(g.name || ('AppID ' + g.appid))}</option>`).join('');
  if (cur) sel.value = cur;
}
/** 监控清单 / 搜索结果的小封面：商店精确图 → 本机 Steam 封面 → ▦ 占位，绝不显示破图 */
function watchThumbImg(it) {
  const id = String(it.appid || '');
  const off = DEMO || (OFF && !OFF.online);
  const cdn = String(it.cover || it.price?.headerImage || steamCdn(id));
  const img = off
    ? `<img src="${esc(cdn)}" loading="lazy" onerror="this.remove()">`
    : `<img src="${esc(cdn)}" data-local="${esc(`/api/game/cover?appid=${id}`)}" loading="lazy" onerror="slCoverFallback(this)">`;
  return `<span>▦</span>${img}`;
}
function watchRowHtml(it) {
  const dis = watchOff() ? 'disabled' : '';
  const p = it.price || {};
  const price = p.isFree ? '免费'
    : (p.finalCents != null ? '¥' + (Number(p.finalCents) / 100).toFixed(2) : '价格待查');
  const orig = (Number(p.initialCents) > Number(p.finalCents))
    ? '<s>¥' + (Number(p.initialCents) / 100).toFixed(2) + '</s>' : '';
  const disc = Number(p.discount) > 0 ? `<span class="watch-disc">-${esc(p.discount)}%</span>` : '';
  const label = p.statusLabel || '等待首次检查';
  const pending = /即将推出|测试版|未上架|抢先体验/.test(label);
  return `<div class="watch-row ${it.enabled === false ? 'is-off' : ''}">
    <div class="watch-ico watch-cover" data-bl-game="${esc(it.appid)}" data-bl-name="${esc(it.name || '')}" title="点击查看玩法与我的成就">${watchThumbImg(it)}</div>
    <div class="watch-main">
      <div class="watch-title"><b data-bl-game="${esc(it.appid)}" data-bl-name="${esc(it.name || '')}" class="watch-game-name" title="点击查看玩法与我的成就">${esc(it.name || ('AppID ' + it.appid))}</b>
        <span class="watch-tag ${pending ? 'pending' : ''}">${esc(label)}</span>
        ${it.owned ? '<span class="watch-tag owned">已拥有</span>' : ''}
        ${it.enabled === false ? '<span class="muted-tag">已静音 · 不再提醒</span>' : ''}</div>
      <div class="watch-price"><b>${price}</b> ${orig} ${disc}
        <small>AppID ${esc(it.appid)} · ${esc(it.source || '手动添加')}${p.checkedAtLocal ? ' · 查于 ' + esc(p.checkedAtLocal) : ''}${p.online === false ? ' · 本机缓存价' : ''}</small></div>
      <div class="watch-rules">
        <label>降到 ¥<input type="number" min="0" step="1" data-watch-rule="targetYuan" data-watch-id="${esc(it.appid)}" value="${Number(it.targetYuan || 0)}" ${dis}></label>
        <label>折扣 ≥ <input type="number" min="0" max="100" step="1" data-watch-rule="discountPct" data-watch-id="${esc(it.appid)}" value="${Number(it.discountPct || 0)}" ${dis}>%</label>
        <label class="switch"><input type="checkbox" data-watch-rule="watchRelease" data-watch-id="${esc(it.appid)}" ${it.watchRelease ? 'checked' : ''} ${dis}><span></span><b>上线提醒</b></label>
        <label class="switch"><input type="checkbox" data-watch-rule="enabled" data-watch-id="${esc(it.appid)}" ${it.enabled !== false ? 'checked' : ''} ${dis}><span></span><b>启用</b></label>
        <button class="btn ghost tiny" data-watch-mute="${esc(it.appid)}" data-watch-on="${it.enabled === false ? '1' : '0'}" data-watch-name="${esc(it.name || '')}" title="${it.enabled === false ? '重新开启这款游戏的提醒' : '不再提醒这款游戏，并删掉它的提醒记录'}" ${dis}>${it.enabled === false ? '↺ 恢复提醒' : '✕ 不再提醒'}</button>
        <button class="btn ghost tiny" data-watch-refresh="${esc(it.appid)}" ${dis}>⟳ 查这款</button>
        <button class="btn ghost tiny" data-watch-del="${esc(it.appid)}" ${dis}>移除清单</button>
      </div>
    </div></div>`;
}
function renderWatch() {
  if (!$('#watchList')) return;
  const items = WATCH?.items || [];
  const alerts = WATCH?.alerts || [];
  $('#watchTag').textContent = items.length + ' 款';
  if ($('#navWatch')) $('#navWatch').textContent = String(items.length);
  if ($('#watchAuto')) $('#watchAuto').checked = WATCH?.autoEnabled !== false;
  if ($('#watchLastCheck')) $('#watchLastCheck').textContent = WATCH?.lastCheckLocal
    ? '上次自动检查 ' + WATCH.lastCheckLocal + '（精确到秒）· 每 60 秒一次'
    : '等待首次自动检查…';
  $('#watchList').innerHTML = items.length ? items.map(watchRowHtml).join('')
    : '<div class="mini-empty">清单还是空的。上面搜一款游戏、从本机库选一款，或填 AppID 加进来；加进来就会自动查价格、每分钟自动监控。</div>';
  if ($('#watchAlertTag')) $('#watchAlertTag').textContent = alerts.length + ' 条';
  const labels = { target: '到达目标价', discount: '达到目标折扣', release: '正式上线' };
  $('#watchAlerts').innerHTML = alerts.length ? alerts.slice(0, 30).map(a => `
    <div class="mini-item"><div class="mi-main"><b>${esc(labels[a.kind] || a.kind)} · ${esc(a.name)}</b>
      <small>${esc(a.localTime || (a.iso || '').replace('T', ' ').slice(0, 19))} · 现价 ¥${(Number(a.finalCents || 0) / 100).toFixed(2)}${a.discount ? ' · -' + esc(a.discount) + '%' : ''} · ${esc(a.statusLabel || '')}</small></div></div>`).join('')
    : '<div class="mini-empty">还没有提醒。设置目标价 / 折扣 / 上线提醒后，跨过提醒线时会写在这里并推送给你。</div>';
}
function renderWatchResults(r) {
  const box = $('#watchSearchResults'); if (!box) return;
  WATCH_RESULTS = r?.items || [];
  if ($('#watchSearchNote')) $('#watchSearchNote').textContent = r?.note || (WATCH_RESULTS.length ? `找到 ${WATCH_RESULTS.length} 款 · ${r.online ? '已包含 Steam 商店搜索结果' : '来自本机游戏库 / 缓存'}` : '');
  box.innerHTML = WATCH_RESULTS.length ? WATCH_RESULTS.map(x => `
    <div class="mini-item"><div class="watch-ico watch-cover">${watchThumbImg(x)}</div>
      <div class="mi-main"><b>${esc(x.name)}</b><small>AppID ${esc(x.appid)} · ${esc(x.source)}${x.owned ? ' · 本机已拥有' : ''}</small></div>
      <button class="btn primary tiny" data-watch-add="${esc(x.appid)}" data-watch-name="${esc(x.name)}" data-watch-source="${esc(x.source)}">加入监控</button>
    </div>`).join('') : '<div class="mini-empty">没有搜到结果，可以直接填 AppID 加入。</div>';
}
async function watchAdd(appid, name, source) {
  if (watchOff()) { toast('离线版只能查看已保存的清单，联网后可添加'); return; }
  try {
    const r = await post('/api/watchlist/add', { appid, name, source });
    if (!r.ok) { toast('加入失败：' + (r.error || '')); return; }
    WATCH = r.status || WATCH; fillWatchLocal(); renderWatch();
    toast(`已加入「${name || appid}」，并自动查了一次价格`);
  } catch (e) { toast('加入失败：' + e.message); }
}
async function watchSearch() {
  if (watchOff()) { toast('离线版用本机游戏库下拉添加即可，联网后才能搜 Steam 商店'); return; }
  const q = String($('#watchSearchInput')?.value || '').trim();
  if (!q) { toast('先填游戏名或 AppID'); return; }
  const b = $('#btnWatchSearch'); if (b) { b.disabled = true; b.textContent = '搜索中…'; }
  if ($('#watchSearchNote')) $('#watchSearchNote').textContent = '正在搜本机游戏库与 Steam 商店…';
  try { renderWatchResults(await api('/api/watchlist/search?term=' + encodeURIComponent(q))); }
  catch (e) { if ($('#watchSearchNote')) $('#watchSearchNote').textContent = '搜索失败：' + e.message; }
  if (b) { b.disabled = false; b.textContent = '⌕ 搜索'; }
}
$('#btnWatchSearch')?.addEventListener('click', watchSearch);
$('#watchSearchInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') watchSearch(); });
$('#btnWatchAddLocal')?.addEventListener('click', () => {
  const sel = $('#watchLocalSelect'); if (!sel || !sel.value) { toast('先从下拉里选一款本机游戏'); return; }
  watchAdd(sel.value, sel.options[sel.selectedIndex]?.text || '', '本机 Steam 游戏库');
});
$('#btnWatchAddAppid')?.addEventListener('click', () => {
  const v = String($('#watchAppidInput')?.value || '').trim();
  if (!/^\d+$/.test(v)) { toast('AppID 应为纯数字，例如 730'); return; }
  watchAdd(v, '', '手动填 AppID');
});
$('#btnWatchImportOwned')?.addEventListener('click', async () => {
  if (watchOff()) { toast('离线版不能批量导入'); return; }
  const r = await post('/api/watchlist/import-owned', { limit: 30 });
  if (r.status) WATCH = r.status;
  fillWatchLocal(); renderWatch();
  toast(`已把本机 ${r.added || 0} 款已拥有的游戏加入监控`);
});
$('#btnWatchCheck')?.addEventListener('click', async () => {
  if (watchOff()) { toast('离线版只能看已保存的价格'); return; }
  const b = $('#btnWatchCheck'); if (b) { b.disabled = true; b.textContent = '正在检查…'; }
  try {
    const r = await post('/api/watchlist/check', {});
    if (r.status) WATCH = r.status;
    renderWatch(); toast(r.message || '检查完成');
  } catch (e) { toast('检查失败：' + e.message); }
  if (b) { b.disabled = false; b.textContent = '⟳ 立即检查价格与上线状态'; }
});
$('#watchAuto')?.addEventListener('change', async () => {
  if (watchOff()) return;
  try { await post('/api/watchlist/auto', { enabled: $('#watchAuto').checked }); toast($('#watchAuto').checked ? '已开启每分钟自动监控' : '已暂停自动监控（仍可手动检查）'); } catch { /* */ }
});
document.addEventListener('click', async (e) => {
  const add = e.target.closest('[data-watch-add]');
  if (add) { watchAdd(add.getAttribute('data-watch-add'), add.getAttribute('data-watch-name'), add.getAttribute('data-watch-source')); return; }
  const mute = e.target.closest('[data-watch-mute]');
  if (mute) {
    if (watchOff()) { toast('离线版不能修改提醒设置'); return; }
    const turnOn = mute.getAttribute('data-watch-on') === '1';
    const name = mute.getAttribute('data-watch-name') || '';
    try {
      const r = await post('/api/watchlist/mute', { appid: mute.getAttribute('data-watch-mute'), muted: !turnOn });
      if (r.status) WATCH = r.status;
      renderWatch();
      toast(turnOn ? `已恢复《${name}》的提醒` : `《${name}》不再提醒，已删掉它的提醒记录`);
    } catch (err) { toast('失败：' + err.message); }
    return;
  }
  const del = e.target.closest('[data-watch-del]');
  if (del) {
    const r = await post('/api/watchlist/remove', { appid: del.getAttribute('data-watch-del') });
    if (r.status) WATCH = r.status;
    fillWatchLocal(); renderWatch(); toast('已从监控清单移除'); return;
  }
  const one = e.target.closest('[data-watch-refresh]');
  if (one) {
    one.disabled = true; one.textContent = '查询中…';
    const r = await post('/api/watchlist/refresh', { appid: one.getAttribute('data-watch-refresh') });
    if (r.status) WATCH = r.status;
    renderWatch(); toast(r.ok ? '已查到最新价格与发售状态' : ('查询失败：' + (r.error || '')));
    return;
  }
});
document.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-watch-rule]'); if (!el || watchOff()) return;
  const rule = el.getAttribute('data-watch-rule');
  const appid = el.getAttribute('data-watch-id');
  const patch = { appid };
  if (rule === 'targetYuan' || rule === 'discountPct') patch[rule] = Number(el.value) || 0;
  else patch[rule] = !!el.checked;
  const r = await post('/api/watchlist/rule', patch);
  if (r.status) WATCH = r.status;
  renderWatch();
});
setTimeout(loadWatch, 1600);
setInterval(loadWatch, 60000);

/* ===================== 系统对比（搜 Steam 游戏 + 设备需求对比） ===================== */
let SYS_PC = null;
let SYS_RESULTS = [];

/** 读取并展示我的电脑配置 */
async function sysCheckLoadPc() {
  const tag = $('#sysPcTag'), box = $('#sysPcBox'), at = $('#sysPcAt');
  if (!tag) return;
  tag.textContent = '检测中…';
  if (box) box.innerHTML = '<div class="mini-empty">正在读取本机硬件（OS / CPU / GPU / 内存 / 系统盘）…</div>';
  try { SYS_PC = await api('/api/pc-specs'); }
  catch (e) { SYS_PC = null; }
  if (!SYS_PC || !SYS_PC.os || !SYS_PC.os.name) {
    tag.textContent = '检测失败';
    if (box) box.innerHTML = '<div class="mini-empty">未能读取本机硬件。点「重新检测我的电脑」重试；若仍失败，可能需要以管理员身份运行本程序。</div>';
    return;
  }
  tag.textContent = '已检测';
  const t = SYS_PC.detectedAt ? new Date(SYS_PC.detectedAt) : null;
  if (at) at.textContent = t ? '检测于 ' + t.toLocaleString('zh-CN') : '';
  const pc = SYS_PC;
  if (box) box.innerHTML = `
    <div class="sys-pc-grid">
      <div class="sys-pc-cell"><span class="k">操作系统</span><b>${esc(pc.os.name)} ${esc(pc.os.arch || '')}</b></div>
      <div class="sys-pc-cell"><span class="k">处理器</span><b>${esc(pc.cpu && pc.cpu.name || '—')}${pc.cpu && pc.cpu.threads ? ' · ' + pc.cpu.threads + ' 线程' : ''}</b></div>
      <div class="sys-pc-cell"><span class="k">内存</span><b>${pc.ramGB} GB</b></div>
      <div class="sys-pc-cell"><span class="k">显卡</span><b>${esc(pc.gpu && pc.gpu.name || '—')}${pc.gpu && pc.gpu.vramGB ? ' · ' + pc.gpu.vramGB + ' GB' : ''}</b></div>
      <div class="sys-pc-cell"><span class="k">系统盘剩余</span><b>${pc.diskFreeGB} GB</b></div>
    </div>`;
}

/** 像愿望单一样搜索 Steam 游戏（本机库 + Steam 商店） */
async function sysCheckSearch() {
  const q = String($('#sysSearchInput')?.value || '').trim();
  if (!q) { toast('先填游戏名或 AppID'); return; }
  const b = $('#btnSysSearch'); if (b) { b.disabled = true; b.textContent = '搜索中…'; }
  if ($('#sysSearchNote')) $('#sysSearchNote').textContent = '正在搜本机游戏库与 Steam 商店…';
  try {
    const r = await api('/api/watchlist/search?term=' + encodeURIComponent(q));
    let items = r?.items || [];
    // 前端再保险去重：按 appid 过滤，避免出现同款游戏被渲染成多张重叠的卡片
    const seen = new Set();
    items = items.filter(x => { const id = String(x.appid); if (seen.has(id)) return false; seen.add(id); return true; });
    SYS_RESULTS = items;
    renderSysResults();
    sysCompareAll();
  } catch (e) {
    if ($('#sysSearchNote')) $('#sysSearchNote').textContent = '搜索失败：' + e.message;
    SYS_RESULTS = []; renderSysResults();
  }
  if (b) { b.disabled = false; b.textContent = '⌕ 搜索'; }
}

function renderSysResults() {
  const box = $('#sysResults'); if (!box) return;
  if ($('#sysResultTag')) $('#sysResultTag').textContent = SYS_RESULTS.length + ' 款';
  const all = $('#btnSysCompareAll'); if (all) all.disabled = !SYS_RESULTS.length;
  if ($('#sysSearchNote') && SYS_RESULTS.length)
    $('#sysSearchNote').textContent = `找到 ${SYS_RESULTS.length} 款 · 已自动与你的电脑配置对比，结论见每款右侧徽标；点「收起 / 展开」看明细`;
  box.innerHTML = SYS_RESULTS.length ? SYS_RESULTS.map(sysResultRow).join('')
    : '<div class="mini-empty">搜一款游戏，或填 AppID（如 730），结果会自动和你的电脑配置对比。</div>';
}

function sysResultRow(x) {
  const id = esc(x.appid);
  return `<div class="sys-card" data-sys-appid="${id}" data-sys-name="${esc(x.name)}">
    <div class="mini-item">
      <div class="watch-ico watch-cover" data-bl-game="${id}" data-bl-name="${esc(x.name || '')}" title="点击查看玩法与我的成就">${watchThumbImg(x)}</div>
      <div class="mi-main"><b data-bl-game="${id}" data-bl-name="${esc(x.name || '')}" style="cursor:pointer">${esc(x.name)}</b><small>AppID ${id} · ${esc(x.source)}${x.owned ? ' · 本机已拥有' : ''} <span class="sys-badge unknown" id="sysBadge-${id}">对比中…</span></small></div>
      <button class="btn ghost tiny" data-sys-toggle="${id}" data-sys-name="${esc(x.name)}">收起</button>
    </div>
    <div class="sys-detail" id="sysDetail-${id}">对比中…</div>
  </div>`;
}

/** 单款对比：拉取系统需求并与已自动提取的电脑配置对比，填充明细 + 结论徽标 */
async function sysCompareOne(appid, name) {
  const detail = $('#sysDetail-' + appid); if (!detail) return;
  detail.hidden = false;
  if (!detail.dataset.loaded) detail.innerHTML = '<div class="mini-empty">正在读取系统需求并对比你的电脑…</div>';
  if (!SYS_PC) { try { await sysCheckLoadPc(); } catch { /* */ } }
  try {
    const r = await api('/api/game/sysreq?appid=' + encodeURIComponent(appid) + '&name=' + encodeURIComponent(name || ''));
    detail.innerHTML = sysCompareHtml(r);
    detail.dataset.loaded = '1';
    setSysBadge(appid, r.comparison);
  } catch (e) {
    detail.innerHTML = '<div class="mini-empty">对比失败：' + esc(e.message) + '</div>';
    setSysBadge(appid, null, '对比失败');
  }
  updateToggleLabel(appid);
}

/** 对比全部：并发逐项拉取并自动展开（无需手动点击） */
async function sysCompareAll() {
  if (!SYS_RESULTS.length) return;
  const b = $('#btnSysCompareAll'); if (b) { b.disabled = true; b.textContent = '对比中…'; }
  const items = SYS_RESULTS.slice(0, 15);
  if (!SYS_PC) { try { await sysCheckLoadPc(); } catch { /* */ } }
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const x = items[i++];
      const detail = $('#sysDetail-' + x.appid);
      if (!detail) continue;
      detail.hidden = false;
      if (!detail.dataset.loaded) detail.innerHTML = '<div class="mini-empty">对比中…</div>';
      try {
        const r = await api('/api/game/sysreq?appid=' + encodeURIComponent(x.appid) + '&name=' + encodeURIComponent(x.name || ''));
        detail.innerHTML = sysCompareHtml(r);
        detail.dataset.loaded = '1';
        setSysBadge(x.appid, r.comparison);
      } catch (e) {
        detail.innerHTML = '<div class="mini-empty">对比失败：' + esc(e.message) + '</div>';
        setSysBadge(x.appid, null, '对比失败');
      }
      updateToggleLabel(x.appid);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (b) { b.disabled = false; b.textContent = '🔄 重新对比'; }
}

/* 单款明细收起 / 展开：已自动对比过则直接切换，未加载则现拉 */
async function sysToggleDetail(appid, name) {
  const detail = $('#sysDetail-' + appid); if (!detail) return;
  if (detail.hidden) {
    detail.hidden = false;
    if (!detail.dataset.loaded) await sysCompareOne(appid, name);
    updateToggleLabel(appid);
  } else {
    detail.hidden = true;
    updateToggleLabel(appid);
  }
}
function updateToggleLabel(appid) {
  const btn = document.querySelector('[data-sys-toggle="' + String(appid).replace(/"/g, '\\"') + '"]');
  const detail = $('#sysDetail-' + appid);
  if (btn) btn.textContent = (detail && detail.hidden) ? '展开' : '收起';
}
function verdictBadgeParts(cmp) {
  if (!cmp || !cmp.verdict) return ['unknown', '无配置数据'];
  const map = { pass: ['ok', '✅ 能玩'], ok: ['ok', '✅ 能玩'], fail: ['fail', '❌ 带不动'], warn: ['warn', '⚠️ 需确认'], min: ['warn', '⚠️ 勉强'], unknown: ['unknown', '❔ 需手动确认'] };
  return map[cmp.verdict] || ['unknown', '❔ 需手动确认'];
}
function setSysBadge(appid, cmp, fallbackText) {
  const bd = document.getElementById('sysBadge-' + appid);
  if (!bd) return;
  const parts = fallbackText ? ['unknown', fallbackText] : verdictBadgeParts(cmp);
  bd.className = 'sys-badge ' + parts[0];
  bd.textContent = parts[1];
}

/* ----- 对比结果渲染（独立页面 / 游戏详情弹窗共用） ----- */
function cleanPlain(s) {
  return String(s || '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/\s+/g, ' ').trim();
}
function reqListHtml(html) {
  if (!html) return '<li class="fine">未提供</li>';
  const items = String(html)
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/li>/gi, '\n').replace(/<li[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '').split('\n')
    .map(s => cleanPlain(s)).filter(Boolean);
  return items.length ? items.map(s => `<li>${esc(s)}</li>`).join('') : '<li class="fine">未提供</li>';
}
function buildCmpTable(cmp) {
  const rows = (cmp.rows || []).map(row => {
    const icon = ({ pass: '✅', ok: '✅', fail: '❌', min: '⚠️', unknown: '❔' })[row.status] || '❔';
    return `<div class="sys-cmp-row ${esc(row.status)}">
      <span class="c-k">${esc(row.label)}</span>
      <span class="c-pc">${esc(row.pc)}</span>
      <span class="c-req">${esc(row.reqMin)}</span>
      <span class="c-st" title="${esc(row.note || '')}">${icon}</span>
    </div>`;
  }).join('');
  const needNote = (cmp.rows || []).some(r => r.status === 'unknown' || r.status === 'min');
  return `<div class="sys-cmp-table">
    <div class="sys-cmp-head"><span>项目</span><span>我的电脑</span><span>最低要求</span><span>对比</span></div>
    ${rows}
  </div>` + (needNote ? '<p class="fine" style="margin-top:8px">⚠️ 标注「需手动确认」的项是 CPU / 显卡型号级别的粗略估算，无法 100% 精确，请以实际游玩为准。</p>' : '');
}
function sysCompareInner(r) {
  const reqs = r.requirements || {};
  const raw = reqs.raw || {};
  const cmp = r.comparison || null;
  const pc = r.pcSpecs || {};
  return {
    verdictHtml: cmp ? `<div class="sys-verdict ${esc(cmp.verdict)}">${esc(cmp.verdictText)}</div>`
      : (raw.minimum || raw.recommended ? '' : '<div class="mini-empty">没有获取到系统需求（这款游戏可能没有公开配置要求）。</div>'),
    minHtml: reqListHtml(raw.minimum),
    recHtml: reqListHtml(raw.recommended),
    compareHtml: (cmp && cmp.rows && cmp.rows.length) ? buildCmpTable(cmp) : '',
    pcText: (pc && pc.os && pc.os.name)
      ? `${pc.os.name} · ${pc.cpu && pc.cpu.name || '—'} · ${pc.ramGB}GB · ${pc.gpu && pc.gpu.name || '—'}` : ''
  };
}
/** 独立「系统对比」页面用的整块渲染 */
function sysCompareHtml(r) {
  const x = sysCompareInner(r);
  return `${x.verdictHtml}
    <div class="gd-sysreq-cols">
      <div class="gd-req-col"><div class="gd-req-title">最低配置</div><ul class="gd-req-list">${x.minHtml}</ul></div>
      <div class="gd-req-col"><div class="gd-req-title">推荐配置</div><ul class="gd-req-list">${x.recHtml}</ul></div>
    </div>
    ${x.compareHtml}`;
}

async function renderSysCheck() {
  if (!SYS_PC) await sysCheckLoadPc();
  renderSysResults();
}

/* 事件绑定 */
$('#btnSysSearch')?.addEventListener('click', sysCheckSearch);
$('#sysSearchInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') sysCheckSearch(); });
$('#btnSysDetect')?.addEventListener('click', async () => { SYS_PC = null; await sysCheckLoadPc(); });
$('#btnSysCompareAll')?.addEventListener('click', sysCompareAll);
document.addEventListener('click', e => {
  const c = e.target.closest('[data-sys-toggle]');
  if (c) { sysToggleDetail(c.getAttribute('data-sys-toggle'), c.getAttribute('data-sys-name')); return; }
});

/* ------------------------------ 识别家庭（Steam Family） ------------------------------ */
let FAM = { snapshot: null, config: null, filter: '' };

function famYuan(cents) { return cents > 0 ? '¥' + (cents / 100).toFixed(2) : '未估价'; }
function famTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }); } catch { return iso; }
}

async function renderFamily() {
  if (wpOffline()) { $('#familySummary').innerHTML = '<div class="mini-empty">离线版不支持识别家庭，请用在线版（启动 start.bat）。</div>'; return; }
  let st;
  try { st = await api('/api/family'); }
  catch (e) { $('#familySummary').innerHTML = '<div class="mini-empty">读取家庭数据失败：' + esc(e.message) + '</div>'; return; }
  FAM.snapshot = st.snapshot; FAM.config = st.config || {};
  const s = st.snapshot;

  // 令牌状态（含过期提示）
  if (st.tokenExpired) {
    $('#familyTokenStatus').innerHTML = '⚠️ 家庭访问令牌已于 ' + famTime(new Date(st.tokenExpiresAt).toISOString()) + ' 过期，请重新获取（登录 store.steampowered.com → 打开 pointssummary/ajaxgetasyncconfig → 复制 webapi_token 粘贴到上方）。';
  } else {
    $('#familyTokenStatus').textContent = st.hasToken ? '已保存家庭访问令牌 ✓' : '尚未保存家庭访问令牌（识别前必填）';
  }
  // 通知开关
  $('#famNotifyJoined').checked = FAM.config.notifyMemberJoined !== false;
  $('#famNotifyLeft').checked = FAM.config.notifyMemberLeft !== false;
  $('#famNotifyNew').checked = FAM.config.notifyNewGame !== false;

  if (!s || s.noFamily) {
    $('#familyScanStatus').textContent = (s && s.noFamily) ? '未加入家庭' : (st.hasKey ? '尚未识别' : '未连接账号');
    $('#familyLastScan').textContent = (s && s.noFamily) ? ('上次识别：' + famTime(s.scannedIso)) : '';
    const msg = (s && s.noFamily)
      ? '<div class="mini-empty"><b>你还没有加入任何 Steam 家庭</b><br><br>要先在 Steam → 设置 → 家庭 里创建或加入一个家庭，再用该账号的令牌扫描，才能看到成员、各自库与家庭库总价值。<br><br>提示：家庭访问令牌跟账号走——切到另一个 Steam 账号后，需要重新获取那个账号的 webapi_token 再扫描。</div>'
      : (st.hasKey
        ? '<div class="mini-empty">还没有识别记录。点上方「🔄 立即识别家庭」，会用你的家庭访问令牌拉取 Steam 共享家庭。</div>'
        : '<div class="mini-empty">请先在「Steam 账号」页连接你的账号（需要你是某个 Steam 家庭的成员），再来识别家庭。</div>');
    $('#familySummary').innerHTML = msg;
    $('#familyMembers').innerHTML = ''; $('#familyMembersEmpty').hidden = false;
    $('#familyMemberCount').textContent = '0';
    $('#familyLibrary').innerHTML = ''; $('#familyLibraryEmpty').hidden = false;
    $('#familyGameCount').textContent = '0';
    $('#familyEvents').innerHTML = '<div class="mini-empty">还没有家庭动态。</div>';
    return;
  }

  $('#familyScanStatus').textContent = '已识别';
  $('#familyLastScan').textContent = '上次识别：' + famTime(s.scannedIso);
  renderFamilySummary(s);
  renderFamilyMembers(s.members || []);
  renderFamilyLibrary(s.library || []);
  renderFamilyEvents(s.events || []);
}

function renderFamilySummary(s) {
  const members = s.members || [];
  const owner = members.find(m => { const r = m.role; return (typeof r === 'string' && /owner/i.test(r)) || r === 1 || r === '1' || Number(r) === 1; });
  const cards = [
    { label: '家庭成员', value: (s.memberCount || members.length) + ' 人', sub: owner ? '房主：' + esc(owner.name) : '' },
    { label: '共享游戏', value: s.totalGames + ' 款', sub: s.pricedCount + ' 款有估价' },
    { label: '家庭库总价值', value: famYuan(s.totalValueCents), sub: s.pricedCount < s.totalGames ? '含未估价游戏' : '全部已估价' },
    { label: '家庭组 ID', value: s.groupid || '—', sub: 'Steam Family 共享家庭' }
  ];
  $('#familySummary').innerHTML = '<div class="family-summary-grid">' + cards.map(c =>
    `<div class="sum-card"><div class="sum-label">${esc(c.label)}</div><div class="sum-value">${esc(c.value)}</div><div class="sum-sub">${esc(c.sub || '')}</div></div>`
  ).join('') + '</div>';
}

function renderFamilyMembers(members) {
  $('#familyMemberCount').textContent = members.length;
  $('#familyMembersEmpty').hidden = members.length > 0;
  const max = Math.max(1, ...members.map(m => m.valueCents || 0));
  $('#familyMembers').innerHTML = members.map(m => {
    const pct = Math.round(((m.valueCents || 0) / max) * 100);
    const roleRaw = m.role;
    const roleNum = Number(roleRaw);
    const isOwner = (typeof roleRaw === 'string' && /owner/i.test(roleRaw)) || (roleRaw === 1) || (roleRaw === '1') || (roleNum === 1);
    const role = isOwner ? '<span class="role owner">房主</span>' : '<span class="role">成员</span>';
    const av = m.avatar
      ? `<img class="fam-avatar" src="${esc(m.avatar)}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'fam-avatar',textContent:'${(m.name||'?').slice(0,1)}'}))">`
      : `<div class="fam-avatar">${(m.name || '?').slice(0, 1)}</div>`;
    return `<div class="family-member">
      ${av}
      <div class="fm-main">
        <div class="fm-top"><b>${esc(m.name)}</b> ${role}</div>
        <div class="fm-sub">${m.gameCount} 款游戏 · 库估值 ${famYuan(m.valueCents)}</div>
        <div class="fm-bar"><span style="width:${pct}%"></span></div>
      </div>
      ${m.error ? '<span class="tag warn" title="' + esc(m.error) + '">库不可读</span>' : ''}
    </div>`;
  }).join('');
}

function renderFamilyLibrary(library) {
  $('#familyGameCount').textContent = library.length;
  $('#familyLibraryEmpty').hidden = library.length > 0;
  const q = (FAM.filter || '').trim().toLowerCase();
  const list = q ? library.filter(g => (g.name || '').toLowerCase().includes(q)) : library;
  // 一屏最多渲染 120 张，避免卡顿；搜索时全量
  const show = (q || library.length <= 120) ? list : list.slice(0, 120);
  $('#familyLibrary').innerHTML = show.length ? show.map(g => {
    const owners = (g.owners || []).map(sid => {
      const m = (FAM.snapshot.members || []).find(x => x.steamid === sid);
      return m ? `<span class="owner-badge" title="${esc(m.name)}">${esc((m.name || '?').slice(0, 1))}</span>` : '';
    }).join('');
    const cdn = steamCdn(g.appid);
    return `<div class="family-game" data-bl-game="${esc(g.appid)}">
      <div class="fg-cover"><img src="${esc(cdn)}" loading="lazy" onerror="this.style.visibility='hidden'"></div>
      <div class="fg-main">
        <b class="fg-name">${esc(g.name || ('App ' + g.appid))}</b>
        <small class="fg-meta">${famYuan(g.priceCents)} · 最高 ${(g.playtimeMax || 0)} 分钟</small>
        <div class="fg-owners">${owners || '<span class="muted-tag">未知拥有者</span>'}</div>
      </div>
    </div>`;
  }).join('') : '<div class="mini-empty">没有匹配的游戏。</div>';
  if (!q && library.length > 120) {
    $('#familyLibrary').insertAdjacentHTML('beforeend', `<div class="fine" style="padding:8px 2px">为性能仅显示前 120 款，用上方搜索框可定位具体游戏。</div>`);
  }
}

function renderFamilyEvents(events) {
  $('#familyEvents').innerHTML = events.length ? events.map(e => {
    const icon = e.type === 'member-left' ? '⬅' : e.type === 'member-joined' ? '➡' : '🎮';
    return `<div class="mini-item"><div class="mi-main"><b>${icon} ${esc(e.text)}</b><small>${famTime(new Date(e.ts).toISOString())}</small></div></div>`;
  }).join('') : '<div class="mini-empty">还没有家庭动态。下次识别对比出变化时会记录在这里并通知你。</div>';
}

/* 事件绑定 */
$('#btnFamilyScan')?.addEventListener('click', async () => {
  const btn = $('#btnFamilyScan');
  btn.disabled = true; btn.textContent = '🔄 识别中…';
  $('#familyScanStatus').textContent = '识别中…';
  try {
    const r = await post('/api/family/scan', {});
    if (!r.ok) { toast(r.message || '识别失败'); $('#familyScanStatus').textContent = '失败'; }
    else {
      toast(r.message || '识别完成');
      await renderFamily();
      if (r.changes) {
        const n = (r.changes.joined.length + r.changes.left.length + r.changes.newGames.length);
        if (n) toast(`本次变化：+${r.changes.joined.length} 成员 / -${r.changes.left.length} 成员 / +${r.changes.newGames.length} 款游戏`);
      }
    }
  } catch (e) { toast('识别失败：' + e.message); $('#familyScanStatus').textContent = '失败'; }
  finally { btn.disabled = false; btn.textContent = '🔄 立即识别家庭'; }
});
$('#famAccessToken')?.addEventListener('keydown', e => { if (e.key === 'Enter') $('#btnFamSaveToken')?.click(); });
$('#btnFamSaveToken')?.addEventListener('click', async () => {
  const v = ($('#famAccessToken').value || '').trim();
  if (!v) { toast('先粘贴 webapi_token'); return; }
  try {
    await post('/api/family/config', { accessToken: v });
    $('#familyTokenStatus').textContent = '已保存家庭访问令牌 ✓';
    toast('令牌已保存，现在可以「立即识别家庭」');
  } catch (e) { toast('保存失败：' + e.message); }
});
$('#familyGameSearch')?.addEventListener('input', e => { FAM.filter = e.target.value; renderFamilyLibrary((FAM.snapshot && FAM.snapshot.library) || []); });
$('#btnFamSaveNotify')?.addEventListener('click', async () => {
  try {
    await post('/api/family/config', {
      notifyMemberJoined: $('#famNotifyJoined').checked,
      notifyMemberLeft: $('#famNotifyLeft').checked,
      notifyNewGame: $('#famNotifyNew').checked
    });
    toast('家庭通知设置已保存');
  } catch (e) { toast('保存失败：' + e.message); }
});
/* 自动保存：切换任一开关立即保存，无需点「保存」按钮 */
function saveFamNotify() {
  post('/api/family/config', {
    notifyMemberJoined: $('#famNotifyJoined').checked,
    notifyMemberLeft: $('#famNotifyLeft').checked,
    notifyNewGame: $('#famNotifyNew').checked
  }).then(() => { FAM.config = Object.assign(FAM.config || {}, {
    notifyMemberJoined: $('#famNotifyJoined').checked,
    notifyMemberLeft: $('#famNotifyLeft').checked,
    notifyNewGame: $('#famNotifyNew').checked
  }); toast('家庭通知设置已自动保存'); }).catch(e => toast('自动保存失败：' + e.message));
}
$('#famNotifyJoined')?.addEventListener('change', saveFamNotify);
$('#famNotifyLeft')?.addEventListener('change', saveFamNotify);
$('#famNotifyNew')?.addEventListener('change', saveFamNotify);

/* ==================================================================== */
/*  点击好友：他朋友的朋友 / 那些人库中的东西 / Steam 徽章 · 每秒更新          */
/*  单独一个面板，不抢 FP_ACTIVE_ID 档案页的状态；单一 timer + 重入锁。      */
/* ==================================================================== */
let FN_ID = '', FN_TIMER = 0, FN_LOADING = false, FN_DATA = null, FN_FAILS = 0;

function fnName(id) {
  const f = (F?.friends || []).find(x => String(x.steamId64) === id);
  return f?.name || String(id);
}
function fnGamesHtml(games, emptyText) {
  const arr = Array.isArray(games) ? games : [];
  return arr.length
    ? arr.slice(0, 20).map(g => `<span class="fn-game" title="${esc(g.name || '')}">${esc(g.name || ('App ' + (g.appid || '')))}</span>`).join('')
    : `<span class="fn-empty">${esc(emptyText)}</span>`;
}
function fnRender(d) {
  const badges = d?.badges || {};
  const bl = Array.isArray(badges.badges) ? badges.badges : [];
  const bt = $('#fnBadgeTag');
  if (bt) bt.textContent = bl.length
    ? `${badges.count ?? bl.length} 枚${badges.level != null && badges.level !== '' ? ' · Lv.' + badges.level : ''}`
    : '尚未采集';
  const bb = $('#fnBadges');
  if (bb) bb.innerHTML = bl.length
    ? bl.slice(0, 40).map(b => `<div class="fn-badge">
        <div class="fn-badge-ico">🏅</div>
        <div class="fn-badge-main"><b title="${esc(b.name)}">${esc(b.name)}</b>
        <small>${b.level ? '等级 ' + esc(b.level) : '徽章'}${b.xp ? ' · ' + esc(b.xp) + ' XP' : ''}${b.scarcity ? ' · 稀有度 ' + esc(b.scarcity) + '%' : ''}</small></div></div>`).join('')
    : `<div class="fn-empty">还没读到这位好友的徽章。点上面的「打开他的徽章页」，已登录的 Steam 网页端会自动采集；徽章只存本机，不需要 API Key。</div>`;

  const fof = Array.isArray(d?.fof) ? d.fof : [];
  const ft = $('#fnFofTag'); if (ft) ft.textContent = `${d?.fofCount ?? fof.length} 人`;
  const fb = $('#fnFof');
  if (fb) fb.innerHTML = fof.length
    ? fof.slice(0, 20).map(p => `<div class="fn-person">
        <div class="fn-person-top">
          <span class="fn-av">${p.avatar ? `<img src="${esc(p.avatar)}" loading="lazy" onerror="this.remove()">` : esc(String(p.name || '?').slice(0, 1).toUpperCase())}</span>
          <b title="${esc(p.name)}">${esc(p.name || p.steamId64)}</b>
          <span class="tag" title="${esc(p.librarySource || '尚未扫描')}">${p.hasLibrary ? p.gameCount + ' 款' : '库待扫'}</span>
        </div>
        <div class="fn-games">${fnGamesHtml(p.games, p.hasLibrary ? '库中暂无游戏记录' : '游戏库正在自动扫描中，采到后每秒自动补齐')}</div>
      </div>`).join('')
    : `<div class="fn-empty">还没扫到他的朋友的朋友。已开启自动扫描：软件会自动在已登录 Steam 的网页端打开他的好友列表页并回传，首次只需在打开的浏览器里登录一次 Steam；本面板每秒刷新，采到就会立刻出现。</div>`;

  const own = d?.ownLibrary;
  const ot = $('#fnOwnTag'); if (ot) ot.textContent = own ? `${own.gameCount ?? 0} 款` : '未读取';
  const ob = $('#fnOwn');
  if (ob) ob.innerHTML = fnGamesHtml(own?.games, '本机还没有这位好友的游戏库记录。');

  const note = $('#fnNote');
  if (note) {
    const bits = [];
    if (d?.generatedAtIso) bits.push('关系链扫描：' + esc(String(d.generatedAtIso).replace('T', ' ').slice(0, 19)));
    if (d?.badges?.at) bits.push('徽章采集：' + timeStr(d.badges.at));
    if (d?.fofSource?.at) bits.push('好友列表采集：' + timeStr(d.fofSource.at) + '（' + (d.fofSource.count || 0) + ' 人）');
    const as = d?.autoScan;
    if (as) {
      bits.push(as.enabled
        ? `自动扫描：${as.connected ? '运行中' : '等待浏览器'} · 好友列表 ${as.scanned?.fof || 0} 次 / 徽章 ${as.scanned?.badges || 0} 次 / 游戏库 ${as.scanned?.library || 0} 次 · 待扫 ${as.queued || 0}`
        : '自动扫描已关闭');
      if (as.note) bits.push(esc(String(as.note)));
    }
    bits.push('本面板每秒自动刷新一次');
    if (d?.discoverNote) bits.push(esc(d.discoverNote));
    note.innerHTML = bits.join(' · ');
  }
}
async function fnTick() {
  const mask = $('#friendPopupMask');
  /* 关闭 / 切到后台 / 上一轮还没回来，都直接跳过，避免请求堆叠 */
  if (!mask || mask.hidden || !FN_ID || FN_LOADING || document.hidden) return;
  FN_LOADING = true;
  try {
    const d = await api(`/api/friend/network?steamId64=${encodeURIComponent(FN_ID)}`);
    if (mask.hidden || String(d?.steamId64 || '') !== FN_ID) return;
    FN_DATA = d; FN_FAILS = 0;
    fnRender(d);
    const lt = $('#fnLiveTag');
    if (lt) lt.textContent = '每秒更新 · ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  } catch (e) {
    FN_FAILS++;
    if (FN_FAILS === 1) {
      const lt = $('#fnLiveTag'); if (lt) lt.textContent = '离线 / 暂不可用';
      const note = $('#fnNote'); if (note) note.textContent = '当前读不到本机服务，服务恢复后会自动继续每秒刷新。';
    }
  } finally { FN_LOADING = false; }
}
function fnOpen(id) {
  id = String(id || '').trim();
  if (!/^\d{17}$/.test(id)) return;
  const mask = $('#friendPopupMask'); if (!mask) return;
  FN_ID = id; FN_DATA = null; FN_FAILS = 0;
  const t = $('#fnTitle'); if (t) t.textContent = fnName(id) + ' · 关系与徽章';
  const link = $('#fnBadgeLink'); if (link) link.href = `https://steamcommunity.com/profiles/${id}/badges`;
  mask.hidden = false;
  fnRender({ fof: [], badges: {}, ownLibrary: null, fofCount: 0 });
  if (FN_TIMER) clearInterval(FN_TIMER);
  FN_TIMER = setInterval(fnTick, 1000);
  fnTick();
  /* 打开弹窗就自动把这位好友排到扫描队首：后端会自己打开网页端好友列表页采关系链，
     再逐个打开这些人的游戏库页采库，不需要用户手动点任何按钮。 */
  post('/api/friend/fof/auto', { enabled: true, kick: id }).catch(() => {});
}
function fnClose() {
  FN_ID = ''; FN_DATA = null;
  if (FN_TIMER) { clearInterval(FN_TIMER); FN_TIMER = 0; }
  const mask = $('#friendPopupMask'); if (mask) mask.hidden = true;
}
$('#btnFnClose')?.addEventListener('click', fnClose);
$('#friendPopupMask')?.addEventListener('click', e => { if (e.target.id === 'friendPopupMask') fnClose(); });
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-fn]');
  if (btn) { fnOpen(btn.dataset.fn); return; }
  const card = e.target.closest('[data-fn-card]');
  if (!card || e.target.closest('button, a, input, select, label')) return;
  fnOpen(card.dataset.fnCard);
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const mask = $('#friendPopupMask');
  if (mask && !mask.hidden) fnClose();
});
$('#btnFnBadgeOpen')?.addEventListener('click', async () => {
  if (!FN_ID) return;
  const url = `https://steamcommunity.com/profiles/${FN_ID}/badges`;
  try {
    const r = await post('/api/friend/badges/open', { steamId64: FN_ID });
    if (r && r.opened) toast('已打开徽章页，采集器会自动回传徽章（几秒内）');
    else { window.open(r?.url || url, '_blank', 'noopener'); toast('已打开徽章页；若没自动采集，到浏览器扫描页复制采集脚本粘贴运行一次'); }
  } catch (e) {
    window.open(url, '_blank', 'noopener');
    toast('已打开徽章页：' + e.message);
  }
});
