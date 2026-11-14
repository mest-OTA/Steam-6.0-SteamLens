/**
 * SteamLens · 缓存管理（选择性删除）
 *
 * 用户要求：不是「一键全删」，而是勾选哪一块就只删哪一块。
 * 安全约束：
 *  - 严格白名单，只能删下面 BLOCK_DEFS 明确列出的文件 / 目录；
 *  - 绝不接触凭证（config.json）、不递归删除 data 根或任何非白名单路径；
 *  - 删除前 list() 会把每一块要删的具体文件列给前端，由用户勾选并二次确认。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const GAME_DIR = path.join(DATA, 'game-details');

const BLOCK_DEFS = [
  {
    id: 'game-details', label: '游戏详情缓存（玩法 + 成就）',
    desc: '每款游戏一个 JSON，存着搜好的玩法简介和从 Steam 本地读到的成就。删掉某款后，下次点它才会重新读取/重搜。',
    risk: 'safe', kind: 'gamedir'
  },
  {
    id: 'friend-achievements', label: '好友成就缓存（Steam 社区抓取）',
    desc: '按「好友 SteamID / AppID」分开存放，内容是从 Steam 成就页读到的中文成就名、说明、图标和该好友的解锁时间。删掉后，下次点这个好友的游戏会重新从 Steam 抓取。',
    risk: 'safe', kind: 'dir', dir: 'data/friend-achievements'
  },
  {
    id: 'update-log', label: '更新日志',
    desc: 'update-log.json，每分钟自动更新与一键更新的秒级记录。删除后「更新」页的历史日志清空，之后的更新会重新累积。',
    risk: 'safe', files: ['data/update-log.json']
  },
  {
    id: 'discovered-friends', label: '好友关系链（朋友的朋友）',
    desc: 'discovered-friends.json，从 Steam 社区好友列表发现的好友名单。删除后需重新点「从 Steam 重新发现」。',
    risk: 'safe', files: ['data/discovered-friends.json']
  },
  {
    id: 'net-proxy', label: 'Steam 联网代理记录',
    desc: 'net-proxy.json，记住本机能连通 Steam 的代理端口。删除后会自动重新探测，不影响任何数据。',
    risk: 'safe', files: ['data/net-proxy.json']
  },
  {
    id: 'browser-debug', label: '浏览器调试缓存（调试模式临时浏览器）',
    desc: '「用调试模式打开 Steam」时产生的临时浏览器配置，通常占几十 MB。删掉不影响正常浏览器。',
    risk: 'safe', kind: 'dir', dir: 'data/browser-debug-profile'
  },
  {
    id: 'snapshots', label: '历史快照 / 进度曲线',
    desc: 'snapshots.json，用于库价值与时长的变化曲线。删除后历史曲线会清空，之后重新累积。',
    risk: 'caution', files: ['data/snapshots.json']
  },
  {
    id: 'prices', label: '价格与愿望单缓存',
    desc: 'prices.json、愿望单价格与降价提醒记录。删除后价格会重新抓取。',
    risk: 'safe', files: ['data/prices.json', 'data/wishlist-prices.json', 'data/wishlist-alerts.json']
  },
  {
    id: 'friend-data', label: '好友数据缓存',
    desc: '好友上线事件、好友库、好友资料与状态快照。删除后好友列表会重新从 Steam 客户端读取。',
    risk: 'caution', files: [
      'data/friend-events.json', 'data/friend-libraries.json', 'data/friend-library-names.json',
      'data/friend-profiles.json', 'data/friend-state.json', 'data/friend-stats.json',
      'data/friends-meta.json', 'data/steam-client-friends.json', 'data/browser-snapshot.json'
    ]
  },
  {
    id: 'notify-outbox', label: '通知发件箱（离线接管用）',
    desc: 'notify-outbox.json。离线版靠它补发服务器停止前记录的通知，删除后离线版不再显示历史通知。',
    risk: 'caution', files: ['data/notify-outbox.json']
  },
  {
    id: 'account-logins', label: 'Steam 登录记录',
    desc: 'account-logins.json，记录账号登录/退出/切换的时间与设备。删除后登录历史清空。',
    risk: 'caution', files: ['data/account-logins.json']
  },
  {
    id: 'qq-session', label: 'QQ 直接登录会话',
    desc: 'data/qq-direct/ 里保存的登录 token。删除后需要重新扫码 / 输账号密码登录 QQ。',
    risk: 'danger', kind: 'dir', dir: 'data/qq-direct'
  },
  {
    id: 'offline-snapshot', label: '离线版快照数据',
    desc: 'offline-snapshot.json、assets/offline-data.js 和 SteamLens-Offline.html 里内联的数据。删除后离线版打开会没有数据，需要点「立即固化快照」重建。',
    risk: 'danger', files: ['data/offline-snapshot.json', 'assets/offline-data.js']
  },
  {
    id: 'temp-diagnostics', label: '临时诊断 / 截图文件',
    desc: 'data/ 目录下以 _ 开头的临时 HTML、截图等残留文件，可安全清理。',
    risk: 'safe', kind: 'data-glob', pattern: /^_/
  },
  {
    id: 'offline-logs', label: '离线笔记与同步日志',
    desc: '随手记、离线改动同步日志。删除后随手记内容会清空。',
    risk: 'caution', files: ['data/offline-notes.json', 'data/offline-sync-log.json']
  },
  {
    id: 'state', label: '主状态数据（谨慎）',
    desc: 'state.json 是整个面板的当前数据。删除后需重启服务重新采集，图表与统计会暂时空白。一般不需要删。',
    risk: 'danger', files: ['data/state.json']
  },
  {
    id: 'ui-settings', label: '界面设置 / 隐藏标记（谨慎）',
    desc: '主题、页签、筛选、隐私隐藏与库校验标记。删除后所有界面设置回到默认，隐藏游戏标记会丢失。',
    risk: 'danger', files: ['data/ui-settings.json', 'data/hidden-games.json', 'data/library-truth.json']
  }
];

function stat(p) {
  try { return fs.statSync(p); } catch { return null; }
}
function fileSize(p) { const s = stat(p); return s && s.isFile() ? s.size : 0; }
function dirStats(p) {
  let bytes = 0, count = 0;
  if (!stat(p)) return { bytes: 0, count: 0 };
  try {
    const walk = d => {
      let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of es) {
        const q = path.join(d, e.name);
        if (e.isDirectory()) walk(q);
        else { const s = stat(q); if (s) { bytes += s.size; count++; } }
      }
    };
    walk(p);
  } catch { /* */ }
  return { bytes, count };
}
function abs(rel) { return path.resolve(ROOT, rel); }

/** 某一块当前实际存在的文件 */
function blockPaths(def) {
  const out = [];
  if (def.kind === 'gamedir') {
    if (!stat(GAME_DIR)) return out;
    try {
      for (const f of fs.readdirSync(GAME_DIR)) {
        if (/^\d+\.json$/.test(f)) out.push({ abs: path.join(GAME_DIR, f), rel: 'data/game-details/' + f, appid: f.replace(/\.json$/, '') });
      }
    } catch { /* */ }
  } else if (def.kind === 'dir') {
    const p = abs(def.dir);
    if (stat(p)) out.push({ abs: p, rel: def.dir, isDir: true });
  } else if (def.kind === 'data-glob') {
    try {
      for (const f of fs.readdirSync(DATA)) {
        if (!def.pattern.test(f)) continue;
        const p = path.join(DATA, f);
        const s = stat(p);
        if (s && s.isFile()) out.push({ abs: p, rel: 'data/' + f });
      }
    } catch { /* */ }
  } else {
    for (const rel of def.files || []) {
      const p = abs(rel);
      if (stat(p)) out.push({ abs: p, rel });
    }
  }
  return out;
}

/** 只允许删白名单计算出来的绝对路径 */
function isWhitelisted(target) {
  const t = path.resolve(target);
  for (const def of BLOCK_DEFS) {
    for (const f of blockPaths(def)) if (path.resolve(f.abs) === t) return true;
  }
  return false;
}

function list() {
  const blocks = BLOCK_DEFS.map(def => {
    const paths = blockPaths(def);
    let bytes = 0, count = 0;
    for (const p of paths) {
      if (p.isDir) { const d = dirStats(p.abs); bytes += d.bytes; count += d.count; }
      else { bytes += fileSize(p.abs); count += 1; }
    }
    return {
      id: def.id, label: def.label, desc: def.desc, risk: def.risk,
      bytes, count,
      files: paths.map(p => ({ rel: p.rel, bytes: p.isDir ? dirStats(p.abs).bytes : fileSize(p.abs), isDir: !!p.isDir }))
    };
  });
  // 游戏详情细分：每款游戏一行，可单独删
  const gameDetails = [];
  try {
    for (const f of fs.readdirSync(GAME_DIR)) {
      if (!/^\d+\.json$/.test(f)) continue;
      const p = path.join(GAME_DIR, f);
      let name = '', gameplay = '', total = 0;
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        name = j.name || ''; gameplay = j.gameplay || ''; total = (j.achievements || []).length;
      } catch { /* */ }
      gameDetails.push({
        appid: f.replace(/\.json$/, ''), name, gameplay,
        achievementTotal: total, bytes: fileSize(p), rel: 'data/game-details/' + f
      });
    }
  } catch { /* */ }
  gameDetails.sort((a, b) => String(a.name || a.appid).localeCompare(String(b.name || b.appid), 'zh-CN'));
  return { blocks, gameDetails, totalBytes: blocks.reduce((n, b) => n + b.bytes, 0) };
}

/**
 * @param {string[]} ids    勾选的块 id
 * @param {string[]} appids 游戏详情块里单独勾选的 appid（给了就只删这些，不给则删整块）
 */
function remove(ids = [], appids = []) {
  const deleted = [], skipped = [], failed = [];
  const chosen = BLOCK_DEFS.filter(d => ids.includes(d.id));
  for (const def of chosen) {
    let paths = blockPaths(def);
    if (def.id === 'game-details' && appids.length) {
      const want = new Set(appids.map(String));
      paths = paths.filter(p => want.has(String(p.appid)));
    }
    if (!paths.length) { skipped.push({ id: def.id, reason: '没有可删除的文件' }); continue; }
    for (const p of paths) {
      if (!isWhitelisted(p.abs)) { failed.push({ rel: p.rel, reason: '不在白名单内' }); continue; }
      const before = p.isDir ? dirStats(p.abs).bytes : fileSize(p.abs);
      try {
        if (p.isDir) fs.rmSync(p.abs, { recursive: true, force: true });
        else fs.unlinkSync(p.abs);
        deleted.push({ rel: p.rel, bytes: before, block: def.id });
      } catch (e) { failed.push({ rel: p.rel, reason: e.message }); }
    }
  }
  return {
    ok: failed.length === 0,
    deleted, failed, skipped,
    bytesFreed: deleted.reduce((n, d) => n + d.bytes, 0),
    count: deleted.length,
    remaining: list()
  };
}

module.exports = { list, remove, BLOCK_DEFS };
