/**
 * SteamLens · MCP 桥（stdio JSON-RPC，零第三方依赖）
 *
 * 用途：把 Steam 统计作为「工具」暴露给支持 MCP 的桌面 AI 客户端。
 * 兼容两种 stdio 帧格式：换行分隔 JSON 与 Content-Length 帧。
 */
'use strict';

const core = require('./steam-core');
const friends = require('./friends-core');
const account = require('./account-core');
const mail = require('./mail-core');
const wishlist = require('./wishlist-core');
const hidden = require('./hidden-core');
const offline = require('./offline-core');
const dingtalk = require('./dingtalk-core');
const friendProfile = require('./friend-profile-core');
const friendLibrary = require('./friend-library-core');
const steamClient = require('./steam-client-core');
const notify = require('./notify-core');
const wechat = require('./wechat-core');
const qq = require('./qq-core');

const SERVER_INFO = { name: 'steam-lens', version: '2.0.0' };
const PROTOCOL = '2024-11-05';

const TOOLS = [
  { name: 'steam_connection', description: '查看 SteamLens 当前的连接模式、数据源、Steam 根目录、账号、口径与隐私声明。', inputSchema: { type: 'object', properties: {} } },
  { name: 'steam_overview', description: 'Steam 总览：游戏总数、累计使用时长、近14天时长、库价值估算、隐私游戏数量。', inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['auto', 'manual'], description: 'auto=自动连接本机Steam，manual=手动连接Web API' } } } },
  { name: 'steam_games', description: '列出各游戏的使用时长、近14天时长、最后游玩时间、安装状态、估价与数据来源。', inputSchema: { type: 'object', properties: { limit: { type: 'number', description: '返回条数，默认20' }, sortBy: { type: 'string', enum: ['playtime', 'recent', 'value', 'name'], description: '排序方式' }, onlyPlayed: { type: 'boolean' } } } },
  { name: 'steam_private_games', description: '列出被 Steam 隐藏或用户标记为隐私的游戏。它们的时长照常计入总量统计，名称可脱敏。', inputSchema: { type: 'object', properties: {} } },
  { name: 'steam_value_report', description: '整体 Steam 游戏库价值估算与每小时成本排行。', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'steam_progress', description: '进度/快照历史：每次扫描保存的时长快照、相比上次的新增时长与增量最多的游戏。', inputSchema: { type: 'object', properties: {} } },
  { name: 'steam_context', description: '生成一份完整的 Markdown 报告，可直接作为上下文用于让 AI 分析游戏习惯。', inputSchema: { type: 'object', properties: { mode: { type: 'string' }, maskPrivate: { type: 'boolean' } } } },
  { name: 'steam_rescan', description: '强制重新扫描本机 Steam 并写入一条新快照。', inputSchema: { type: 'object', properties: { mode: { type: 'string' } } } },
  { name: 'steam_friends', description: '查看好友当前在线状态：谁在线、谁在玩游戏、谁离线、关注的好友，以及在线人数统计。', inputSchema: { type: 'object', properties: { onlineOnly: { type: 'boolean' }, refresh: { type: 'boolean', description: '是否立即向 Steam API 刷新' } } } },
  { name: 'steam_friend_events', description: '查看好友上线/下线/开始游戏的事件时间线，回答「谁刚上线」「今天谁上线过」。', inputSchema: { type: 'object', properties: { limit: { type: 'number' }, type: { type: 'string', enum: ['online', 'offline', 'game', 'all'] } } } },
  { name: 'steam_friend_refresh', description: '立即刷新好友在线状态并记录本轮上下线事件。', inputSchema: { type: 'object', properties: {} } },
  { name: 'steam_account', description: '查看 Steam 账号只读连接状态与「真实游戏库」：账号资料、确认拥有的游戏数、愿望单数、已标记的退款数、上次同步时间。', inputSchema: { type: 'object', properties: {} } },
  { name: 'steam_wishlist', description: '列出愿望单游戏及当前价格、降价提醒阈值、跨阈值提醒历史。愿望单游戏不计入库价值。', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'steam_excluded_games', description: '列出被排除出库价值的游戏：已退款、仅愿望单、账号里已不存在的本地历史记录（疑似退款/家庭共享/免费周末），以及因此排除的金额。', inputSchema: { type: 'object', properties: {} } },
  { name: 'steam_refresh_value', description: '立即触发库价值自动刷新（补齐或重试商店标价），返回本轮任务状态。', inputSchema: { type: 'object', properties: {} } },
  { name: 'steam_notification_status', description: '查看上线通知配置：Windows 桌面弹窗、Webhook、QQ 邮箱是否已登录、愿望单降价提醒开关与最近通知记录。不返回任何密码或授权码。', inputSchema: { type: 'object', properties: {} } },
  { name: 'steam_wishlist_check', description: '立即检查一次愿望单价格；仅当价格跌破或涨回阈值时才会发送邮件提醒。', inputSchema: { type: 'object', properties: {} } },
  { name: 'steam_hidden_games', description: '列出 Steam 里被隐藏、由 SteamLens 每分钟自动识别并填入「隐私与隐藏」的游戏、识别来源与同步状态。', inputSchema: { type: 'object', properties: {} } },
  { name: 'steam_hidden_scan', description: '立即重新扫描本机 Steam 与浏览器已登录会话里的隐藏游戏，返回本轮新增/移除数量。', inputSchema: { type: 'object', properties: {} } },
  { name: 'steam_offline_status', description: '查看离线模式状态：本机快照时间、待同步的离线改动条数、上次同步结果。服务器关闭时也能用本机数据。', inputSchema: { type: 'object', properties: {} } },
  { name: 'steam_dingtalk_status', description: '查看钉钉通知通道状态、诊断问题与最近推送记录（不返回 Webhook 或密钥明文）。', inputSchema: { type: 'object', properties: {} } },
  { name: 'steam_friend_profile', description: '读取指定 SteamID64 好友的档案：游戏库总数、累计游戏时长、各游戏时长、账号库价值估算与上线记录。', inputSchema: { type: 'object', properties: { steamId64: { type: 'string' }, refresh: { type: 'boolean' } } } },
  { name: 'steam_client_friends', description: '直接读取 Steam 客户端「好友与聊天」窗口显示的好友在线状态（无需 Web API Key），并查看连接端口、同步时间与诊断；只读状态标记，不读聊天记录。', inputSchema: { type: 'object', properties: { poll: { type: 'boolean', description: '是否立即重新读取一次' } } } },
  { name: 'steam_notify_status', description: '查看好友上线 / 退出 Steam 的推送配置：总开关、下线推送开关、QQ 邮箱授权码诊断与各通道（弹窗/邮箱/微信/QQ/钉钉）开关，以及最近通知记录。', inputSchema: { type: 'object', properties: {} } },
  { name: 'steam_friend_library', description: '查看好友「库中的游戏」：直接从 Steam 客户端本机读取（每秒自动更新），可列出每位好友拥有的游戏、名称、AppID、标价与正在玩的游戏；不需要 Steam Web API Key。', inputSchema: { type: 'object', properties: { steamId64: { type: 'string', description: '可选，指定某位好友；留空列出全部' }, refresh: { type: 'boolean', description: '是否请 Steam 客户端立即刷新一次缓存' } } } },
  { name: 'steam_friend_away', description: '查看每位好友「已经离开多久」：按本机记录的下线时刻逐秒精准累计，含下线时间、离开秒数与计时来源；好友上线自动清零。', inputSchema: { type: 'object', properties: {} } },
  { name: 'steam_notify_test', description: '发送一条本机测试弹窗，验证好友上线或退出 Steam 的通知链路。只弹 Windows 桌面通知，不会给邮箱 / 微信 / QQ / 钉钉发测试消息。', inputSchema: { type: 'object', properties: { type: { type: 'string', enum: ['online', 'offline'], description: 'online=好友上线，offline=好友退出 Steam' } } } }
];

let stateCache = null, stateAt = 0;
async function state(mode, force = false) {
  if (!force && stateCache && Date.now() - stateAt < 20000) return stateCache;
  stateCache = await core.buildState({ mode: mode || core.getConfig().mode || 'auto', forceSnapshot: force });
  stateAt = Date.now();
  return stateCache;
}
const pick = (g, mask) => ({
  appid: g.appid, name: core.maskName(g, mask),
  hours: g.playtimeHours, minutes: g.playtimeMin,
  last14Hours: g.playtime2wksHours,
  lastPlayed: g.lastPlayed ? new Date(g.lastPlayed * 1000).toISOString() : null,
  installed: g.installed, sizeGB: g.sizeGB,
  priceCNY: g.priceCents ? Math.round(g.priceCents) / 100 : null,
  priceBasis: g.priceSource || null,
  hourlyCostCNY: g.hourlyCost,
  private: g.effectivePrivate,
  playtimeSource: g.sources.playtime || null
});

async function callTool(name, args = {}) {
  const cfg = core.getConfig();
  switch (name) {
    case 'steam_connection': {
      const s = await state(args.mode);
      return { mode: s.mode, connection: s.connection, privacy: s.privacy, totals: s.totals };
    }
    case 'steam_overview': {
      const s = await state(args.mode);
      return { generatedAt: s.generatedAt, mode: s.mode, account: s.connection.account, totals: s.totals, deltas: s.deltas };
    }
    case 'steam_games': {
      const s = await state(args.mode);
      let g = [...s.games];
      if (args.onlyPlayed) g = g.filter(x => x.playtimeMin > 0);
      const sort = args.sortBy || 'playtime';
      g.sort((a, b) => sort === 'recent' ? b.lastPlayed - a.lastPlayed
        : sort === 'value' ? (b.priceCents || 0) - (a.priceCents || 0)
        : sort === 'name' ? a.name.localeCompare(b.name) : b.playtimeMin - a.playtimeMin);
      const limit = Math.min(200, Math.max(1, Number(args.limit) || 20));
      return { total: s.games.length, returned: Math.min(limit, g.length), games: g.slice(0, limit).map(x => pick(x, cfg.maskPrivateNames)) };
    }
    case 'steam_private_games': {
      const s = await state(args.mode);
      const g = s.games.filter(x => x.effectivePrivate);
      return {
        rule: s.privacy.privateRule,
        count: g.length,
        totalHours: Math.round(g.reduce((a, x) => a + x.playtimeMin, 0) / 60 * 10) / 10,
        games: g.map(x => pick(x, cfg.maskPrivateNames))
      };
    }
    case 'steam_value_report': {
      const s = await state(args.mode);
      const limit = Math.min(50, Number(args.limit) || 15);
      const ranked = [...s.games].filter(x => x.priceCents > 0)
        .sort((a, b) => b.priceCents - a.priceCents).slice(0, limit).map(x => pick(x, cfg.maskPrivateNames));
      return { ...s.privacy, totals: s.totals, mostValuable: ranked };
    }
    case 'steam_progress': {
      const s = await state(args.mode);
      return { snapshots: s.snapshots.slice(-60), count: s.snapshots.length, deltas: s.deltas };
    }
    case 'steam_context': {
      const s = await state(args.mode);
      return { markdown: core.exportMarkdown(s, args.maskPrivate !== false && cfg.maskPrivateNames) };
    }
    case 'steam_rescan': {
      stateCache = null;
      const s = await state(args.mode, true);
      return { ok: true, generatedAt: s.generatedAt, totals: s.totals, snapshots: s.snapshots.length };
    }
    case 'steam_friends': {
      const s = await friends.refresh();
      let list = s.friends;
      if (args.onlineOnly) list = list.filter(f => f.personastate > 0);
      return {
        generatedAt: s.generatedAt, dataMode: s.dataModeLabel, mySteamId: s.mySteamId,
        totals: s.totals, warnings: s.warnings, privacy: s.privacy,
        friends: list.map(f => ({ name: f.name, steamId64: f.steamId64, state: f.stateLabel,
          game: f.game || null, lastLogoff: f.lastLogoff ? new Date(f.lastLogoff * 1000).toISOString() : null,
          starred: f.starred, source: f.source }))
      };
    }
    case 'steam_friend_events': {
      const raw = friends.loadEvents();
      const type = args.type || 'all';
      const list = (type === 'all' ? raw : raw.filter(e => e.type === type))
        .slice(-Math.min(300, Number(args.limit) || 50)).reverse();
      return { total: raw.length, returned: list.length,
        privacy: { statement: '事件由本地后台轮询对比状态生成，仅写入本机 data/friend-events.json，不上传第三方。', caveat: '精度取决于轮询间隔；Steam 私密资料可能返回有限信息。' },
        events: list };
    }
    case 'steam_friend_refresh': {
      const s = await friends.refresh();
      return { ok: true, generatedAt: s.generatedAt, totals: s.totals,
        newStarredOnline: s.newStarredOnline, warnings: s.warnings };
    }
    case 'steam_account': {
      const s = await state(args.mode);
      const t = account.getTruth();
      return {
        ...account.publicView(t), profile: t.profile,
        valueScope: s.totals.valueScope,
        totals: {
          ownedGames: s.totals.ownedGames, refundedGames: s.totals.refundedGames,
          unverifiedGames: s.totals.unverifiedGames, wishlistGames: s.totals.wishlistGames,
          excludedFromValue: s.totals.excludedFromValue, excludedValueYuan: s.totals.excludedValueYuan,
          totalValueYuan: s.totals.totalValueYuan
        },
        warning: '账号连接采用 Steam 官方只读授权（SteamID64 + Web API Key），本工具从不接收或保存 Steam 账号密码。'
      };
    }
    case 'steam_wishlist': {
      const s = await state(args.mode);
      const w = wishlist.status();
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 40));
      return {
        rule: `愿望单不计入库价值；当前价跌破 ¥${w.thresholdYuan} 会发邮件，涨回阈值以上也会提醒；首次基线低于阈值不发信。`,
        thresholdYuan: w.thresholdYuan, enabled: w.enabled, tracked: w.tracked, belowCount: w.belowCount,
        count: s.wishlist.length,
        games: s.wishlist.slice(0, limit).map(x => ({ appid: x.appid, name: x.name, priceCNY: x.priceCents ? x.priceCents / 100 : null, isFree: x.isFree })),
        recentAlerts: w.alerts.slice(0, 10)
      };
    }
    case 'steam_excluded_games': {
      const s = await state(args.mode);
      return {
        reason: s.totals.valueScope,
        count: s.excluded.length,
        excludedValueYuan: s.totals.excludedValueYuan,
        games: s.excluded.map(x => ({ ...x, priceCNY: x.priceCents / 100 })),
        breakdown: {
          refunded: s.totals.refundedGames, wishlist: s.totals.wishlistGames,
          unverified: s.totals.unverifiedGames
        }
      };
    }
    case 'steam_refresh_value': {
      const s = await state(args.mode);
      const ids = core.missingPriceIds(s.games).slice(0, 60);
      if (!ids.length) return { ok: true, needed: 0, message: '价格缓存均有效，无需刷新' };
      // 优先交给常驻服务执行（避免两个进程同时查商店）
      try {
        const port = core.getConfig().port || 8787;
        const r = await fetch(`http://127.0.0.1:${port}/api/refresh/value`, { method: 'POST', signal: AbortSignal.timeout(6000) });
        const j = await r.json();
        return { ok: true, delegatedToService: true, needed: ids.length, ...j };
      } catch {
        const res = await core.estimatePrices(ids);
        stateCache = null;
        return { ok: true, delegatedToService: false, needed: ids.length, fetched: res.fetched, failed: res.failed };
      }
    }
    case 'steam_notification_status': {
      const m = mail.status();
      const w = wishlist.status();
      return {
        friendNotify: cfg.friendNotify !== false,
        desktopToast: cfg.notifyDesktop !== false,
        notifyScope: cfg.notifyScope || 'all',
        webhookConfigured: !!cfg.notifyWebhookUrl,
        qqMail: { connected: !!(m.enabled && m.ready), user: m.user, to: m.to, authCodeSet: m.authCodeSet, onOnline: m.onOnline, quiet: m.quiet },
        wishlistAlert: { enabled: w.enabled, thresholdYuan: w.thresholdYuan, tracked: w.tracked, belowCount: w.belowCount },
        security: 'QQ 邮箱使用 SMTP 授权码（非 QQ 密码），只可发信，无法读取邮件；授权码仅保存在本机。'
      };
    }
    case 'steam_wishlist_check': {
      const r = await wishlist.checkPrices();
      stateCache = null;
      return { ok: true, checked: r.checked, changed: r.changed, message: r.message,
        alerts: r.alerts.map(a => ({ name: a.name, kind: a.kind, fromCNY: a.fromCents / 100, toCNY: a.toCents / 100, mailSent: !!a.mail?.sent })) };
    }
    case 'steam_hidden_games': {
      const st = hidden.status();
      const s = await state(args.mode);
      const ids = new Set(st.games.map(g => g.appid));
      const g = s.games.filter(x => ids.has(String(x.appid)));
      return {
        rule: st.rule, enabled: st.enabled, intervalSec: st.intervalSec,
        lastScanAt: st.lastScanAt ? new Date(st.lastScanAt).toISOString() : null,
        nextScanAt: new Date(st.nextAt).toISOString(),
        count: st.count, sources: st.sources, scanCount: st.scanCount,
        totalHours: Math.round(g.reduce((a, x) => a + x.playtimeMin, 0) / 60 * 10) / 10,
        games: g.map(x => ({ ...pick(x, cfg.maskPrivateNames), autoHidden: true, hiddenSources: x.hiddenSources }))
      };
    }
    case 'steam_hidden_scan': {
      const r = hidden.scan('MCP 手动');
      stateCache = null;
      const s = await state(args.mode, true);
      return { ok: true, total: r.total, added: r.added, removed: r.removed,
        privateGames: s.totals.privateGames, state: hidden.status() };
    }
    case 'steam_offline_status': {
      return { ...offline.status(), standaloneFile: offline.STANDALONE_FILE,
        note: '服务器关闭时双击软件同目录下的 SteamLens-Offline.html（完全自包含单文件）即可使用本机快照；服务恢复后自动合并离线改动。' };
    }
    case 'steam_client_friends': {
      const r = args.poll === false ? null : await steamClient.poll();
      return { poll: r, status: steamClient.status(), friends: friends.steamClientSummary() };
    }
    case 'steam_dingtalk_status': {
      const s = dingtalk.status();
      return { connected: s.connected, enabled: s.enabled, diagnosis: s.diagnosis,
        history: s.history.slice(0, 8), direction: s.direction };
    }
    case 'steam_friend_profile': {
      if (!args.steamId64) throw new Error('缺少 steamId64');
      return await friendProfile.profile(args.steamId64, { refresh: args.refresh !== false });
    }
    case 'steam_friend_library': {
      if (args.refresh) await friendLibrary.refresh(String(args.steamId64 || '')).catch(e => ({ error: e.message }));
      const id = String(args.steamId64 || '').trim();
      const lib = id ? friendLibrary.library(id) : null;
      return {
        status: friendLibrary.status(),
        list: friendLibrary.list(),
        library: lib ? { steamId64: lib.steamId64, name: lib.name, games: lib.games, appids: lib.appids, playingAppId: lib.playingAppId } : null,
        profile: id ? friendProfile.live(id) : null,
        note: '游戏库由 Steam 客户端本机直读，服务每秒刷新一次；不需要 API Key，不读聊天记录或凭证。'
      };
    }
    case 'steam_friend_away': {
      const a = friends.away();
      return { ...a, note: '离开时长按本机下线时刻逐秒累计，每秒刷新；好友上线自动清零。' };
    }
    case 'steam_notify_status': {
      const m = mail.status(), w = wechat.status(), q = qq.status(), d = dingtalk.status();
      return {
        config: notify.cfg(), mail: { connected: !!(m.enabled && m.ready && m.authCodeValid), authCodeValid: m.authCodeValid,
          authCodeIssue: m.authCodeIssue, onOnline: m.onOnline, onOffline: m.onOffline },
        channels: { wechat: { connected: w.connected, onOffline: w.onOffline },
          qq: { connected: q.connected, onOffline: q.onOffline },
          dingtalk: { connected: d.connected, onOffline: d.onOffline } },
        recent: notify.getHistory().slice(0, 8),
        note: '好友上线或退出 Steam 时由后台服务自动推送；所有通道只发给用户自己，不收账号密码、不读聊天记录。'
      };
    }
    case 'steam_notify_test': {
      return await notify.testNotification(args.type === 'offline' ? 'offline' : 'online');
    }
    default: throw new Error(`未知工具：${name}`);
  }
}

function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function error(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'); }

async function handle(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  try {
    switch (method) {
      case 'initialize':
        reply(id, { protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO,
          instructions: 'SteamLens：读取本机 Steam 使用时长、各游戏时长、隐私/隐藏游戏、库价值估算与进度快照。全部数据仅来自本机文件，除非用户显式触发估价。' });
        break;
      case 'notifications/initialized':
      case 'notifications/cancelled': break;
      case 'ping': reply(id, {}); break;
      case 'tools/list': reply(id, { tools: TOOLS }); break;
      case 'resources/list': reply(id, { resources: [] }); break;
      case 'prompts/list': reply(id, { prompts: [] }); break;
      case 'tools/call': {
        const result = await callTool(params?.name, params?.arguments || {});
        reply(id, { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }], isError: false });
        break;
      }
      default:
        if (!isNotification) error(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    if (!isNotification) error(id, -32000, e.message || String(e));
  }
}

/* stdio 帧解析：兼容 Content-Length 与换行分隔 JSON */
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  for (;;) {
    const framed = buf.match(/^Content-Length:\s*(\d+)\s*\r?\n\r?\n/i);
    if (framed) {
      const len = Number(framed[1]);
      if (buf.length < framed[0].length + len) return;
      const body = buf.slice(framed[0].length, framed[0].length + len);
      buf = buf.slice(framed[0].length + len);
      handle(body);
      continue;
    }
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line && !/^Content-Length:/i.test(line)) handle(line);
  }
});
process.stdin.on('end', () => process.exit(0));
process.stderr.write('[SteamLens MCP] ready\n');
