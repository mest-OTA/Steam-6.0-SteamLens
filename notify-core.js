/**
 * SteamLens · 上线通知（零第三方依赖）
 *
 * 通道：
 *  1. Windows 原生 Toast（WinRT，经 PowerShell）：面板关着也能弹，实测可用。
 *  2. 提示音：Toast 自带 audio + 可选 console beep。
 *  3. Webhook：Bark / Server酱 / 企业微信机器人 / 自定义 JSON，可把「上线消息」推到手机。
 *
 * 所有文本用 base64 传给 PowerShell，避免中文在命令行里乱码。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const core = require('./steam-core');
const mail = require('./mail-core');
const wechat = require('./wechat-core');
const qq = require('./qq-core');
const dingtalk = require('./dingtalk-core');
const sms = require('./sms-core');

const recent = new Map();   // 去重：key -> ts
const history = [];         // 最近通知记录（内存，重启清空）
const MAX_HISTORY = 60;

const xmlEsc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function cfg() {
  const c = core.getConfig();
  return {
    desktop: c.notifyDesktop !== false,
    sound: !!c.notifySound,
    scope: c.notifyScope === 'starred' ? 'starred' : 'all',
    webhookUrl: String(c.notifyWebhookUrl || '').trim(),
    webhookType: String(c.notifyWebhookType || 'auto').trim(),
    minIntervalSec: Math.min(3600, Math.max(0, Number(c.notifyMinIntervalSec) || 300)),
    enabled: c.friendNotify !== false,
    offlineEnabled: c.friendNotifyOffline !== false   // 好友退出 Steam 时推送，默认开启
  };
}

function pushHistory(rec) {
  history.unshift(rec);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
}
function getHistory() { return history.slice(0, 30); }

/* ------------------------------ 持久化发件箱 ------------------------------ */
/* 每一条真正发出的通知都落盘到 data/notify-outbox.json。
   用途：在线版一旦起不来 / 中途崩溃，离线版打开时可读取这里面的记录，
   用浏览器桌面通知弹出来、或一键转发到用户自己的 Webhook（QQ / 邮箱）。 */
const OUTBOX_FILE = path.join(__dirname, 'data', 'notify-outbox.json');
const OUTBOX_MAX = 200;

function recordOutbox(rec) {
  if (!rec || !rec.title) return;
  try {
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(OUTBOX_FILE, 'utf8')); } catch (e) {}
    if (!Array.isArray(arr)) arr = [];
    arr.unshift({
      ts: rec.ts, iso: rec.iso || new Date(rec.ts || Date.now()).toISOString(),
      title: rec.title, body: rec.body, type: rec.type || rec.eventType || '',
      eventType: rec.eventType || rec.type || '', channels: rec.channels || null,
      delivered: true
    });
    if (arr.length > OUTBOX_MAX) arr.length = OUTBOX_MAX;
    try { fs.mkdirSync(path.dirname(OUTBOX_FILE), { recursive: true }); } catch (e) {}
    fs.writeFileSync(OUTBOX_FILE, JSON.stringify(arr, null, 2));
  } catch (e) { /* 落盘失败不影响主流程 */ }
}

function getOutbox() {
  try { const a = JSON.parse(fs.readFileSync(OUTBOX_FILE, 'utf8')); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}

/* ------------------------------ Windows Toast ------------------------------ */

function toast(title, body, sound) {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, reason: '非 Windows' });
  const xml = `<toast scenario="reminder" activationType="protocol">`
    + `<visual><binding template="ToastGeneric"><text>${xmlEsc(title)}</text><text>${xmlEsc(body)}</text></binding></visual>`
    + (sound ? `<audio src="ms-winsoundevent:Notification.Default"/>` : `<audio silent="true"/>`)
    + `</toast>`;
  const b64 = Buffer.from(xml, 'utf8').toString('base64');
  const ps = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null;',
    `$x = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'));`,
    '$d = New-Object Windows.Data.Xml.Dom.XmlDocument; $d.LoadXml($x);',
    '$t = New-Object Windows.UI.Notifications.ToastNotification $d;',
    `$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';`,
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show($t);',
    'Write-Output OK'
  ].join(' ');
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 15000, windowsHide: true, maxBuffer: 64 * 1024 },
      (err, so) => resolve(err ? { ok: false, reason: err.message } : { ok: /OK/.test(String(so)) }));
  });
}

/* ------------------------------ Webhook ------------------------------ */

function detectType(url, wanted) {
  if (wanted && wanted !== 'auto') return wanted;
  if (/api\.day\.app|bark/i.test(url)) return 'bark';
  if (/sctapi\.ftqq|sc\.ftqq|serverchan/i.test(url)) return 'serverchan';
  if (/qyapi\.weixin\.qq\.com/i.test(url)) return 'wecom';
  if (/oapi\.dingtalk|feishu|larksuite/i.test(url)) return 'wecom';
  return 'custom';
}

async function webhook(title, body, url, type) {
  if (!url) return { ok: false, reason: '未配置 URL' };
  const kind = detectType(url, type);
  const text = `${title} · ${body}`;
  let target = url, init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: null };

  if (kind === 'bark') {
    // 兼容 https://api.day.app/<key> 与完整路径两种写法
    if (!/\/[^/]+\/[^/]+\/?$/.test(url.replace(/^https?:\/\//, ''))) {
      target = url.replace(/\/$/, '') + '/' + encodeURIComponent(title) + '/' + encodeURIComponent(body);
    }
    init.body = JSON.stringify({ title, body, group: 'SteamLens' });
  } else if (kind === 'serverchan') {
    init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    init.body = new URLSearchParams({ title, desp: body }).toString();
  } else if (kind === 'wecom') {
    init.body = JSON.stringify({ msgtype: 'text', text: { content: text } });
  } else {
    init.body = JSON.stringify({ title, body, text, source: 'SteamLens', ts: Date.now() });
  }

  try {
    const r = await fetch(target, { ...init, signal: AbortSignal.timeout(12000) });
    return { ok: r.ok, status: r.status, kind };
  } catch (e) { return { ok: false, kind, reason: e.message }; }
}

/* ------------------------------ 对外入口 ------------------------------ */

/**
 * 发送好友状态变化通知：上线 或 退出 Steam（下线）。
 * @param {object} ev 事件 { steamId64, name, type: 'online'|'offline', game, text }
 * @param {object} extra { starred, force }
 */
async function notifyFriendEvent(ev, extra = {}) {
  const c = cfg();
  const type = ev.type === 'offline' ? 'offline' : (ev.type === 'online' ? 'online' : '');
  if (!type) return { sent: false, reason: '仅上线 / 退出 Steam 事件触发通知' };
  if (!c.enabled && !extra.force) return { sent: false, reason: '通知总开关已关闭' };
  if (type === 'offline' && !c.offlineEnabled && !extra.force) {
    return { sent: false, reason: '「好友退出 Steam」推送已关闭' };
  }
  if (c.scope === 'starred' && !extra.starred && !extra.force) return { sent: false, reason: '非关注好友' };

  // 上线与下线各自独立去重，好友「上线→下线→上线」不会被误判成重复消息
  const id = ev.steamId64 || ev.name;
  const key = `${id}:${type}`;
  const last = recent.get(key) || 0;
  if (!extra.force && Date.now() - last < c.minIntervalSec * 1000) {
    return { sent: false, reason: '去重间隔内' };
  }
  recent.set(key, Date.now());

  const offline = type === 'offline';
  const title = offline ? 'SteamLens · 好友退出 Steam' : 'SteamLens · 好友上线';
  const game = !offline && ev.game ? `，正在玩 ${ev.game}` : '';
  const body = offline
    ? `${ev.name || '好友'} 退出 Steam 了（已离线）`
    : `${ev.name || '好友'} 上线了${game}`;
  const dedupeKey = `${type}:${id}`;
  const results = { desktop: null, webhook: null, mail: null, wechat: null, qq: null, dingtalk: null, sms: null };

  if (c.desktop) results.desktop = await toast(title, body, c.sound);
  if (c.webhookUrl) results.webhook = await webhook(title, body, c.webhookUrl, c.webhookType);
  // 外部通道：force（面板测试）只弹本机窗口，避免反复给邮箱 / 微信 / QQ / 钉钉发测试消息
  if (!extra.force) {
    try {
      const r = await mail.send(ev, { starred: !!extra.starred, source: '本机 SteamLens 后台轮询' });
      results.mail = { sent: !!r.sent, reason: r.reason || null, to: r.to || null };
    } catch (e) { results.mail = { sent: false, reason: e.message }; }
    for (const [name, mod] of [['wechat', wechat], ['qq', qq], ['dingtalk', dingtalk]]) {
      try {
        const r = await mod.send(title, body, { kind: type, dedupeKey });
        results[name] = { ok: !!r.ok, reason: r.reason || '' };
      } catch (e) { results[name] = { ok: false, reason: e.message }; }
    }
    /* 手机号短信：好友上线 / 退出各自有独立开关，关掉就不发、不扣费 */
    try {
      const sr = await sms.send(type === 'offline' ? 'friendOffline' : 'friendOnline', body);
      results.sms = { ok: !!sr.ok, reason: sr.reason || '' };
    } catch (e) { results.sms = { ok: false, reason: e.message }; }
  }

  const rec = {
    ts: Date.now(), iso: new Date().toISOString(), title, body,
    type, eventType: type, starred: !!extra.starred, channels: results
  };
  pushHistory(rec);
  recordOutbox(rec);
  console.log(`[SteamLens 通知] ${body}`);
  return { sent: true, ...rec };
}

// 兼容旧调用名（好友上线走的还是同一条链路）
const notifyOnline = notifyFriendEvent;

async function testNotification(type = 'online') {
  const offline = type === 'offline';
  return notifyFriendEvent(offline
    ? { steamId64: 'test-offline', name: '测试好友', type: 'offline', text: '测试' }
    : { steamId64: 'test', name: '测试好友', type: 'online', game: 'Counter-Strike 2', text: '测试' },
  { starred: true, force: true });
}

/**
 * 发送 Steam 账号登录 / 退出 / 切换 通知。
 * @param {object} ev { type:'login'|'logout'|'switch', personaName, accountName, steamId64, where, device, ts }
 */
async function notifyAccountEvent(ev) {
  const c = cfg();
  if (!c.enabled) return { sent: false, reason: '通知总开关已关闭' };
  const map = { login: '登录了 Steam', logout: '退出了 Steam', switch: '切换了 Steam 账号' };
  const verb = map[ev.type] || '变更了 Steam 账号';
  const who = ev.personaName || ev.accountName || ('Steam ' + String(ev.steamId64 || '').slice(0, 8));
  const where = ev.where || (ev.device ? '本机 · ' + ev.device : '本机');
  const t = ev.ts ? new Date(ev.ts) : new Date();
  const time = t.toLocaleString('zh-CN', { hour12: false });
  const title = 'SteamLens · Steam 账号' + (ev.type === 'logout' ? '退出' : '登录');
  const body = `${who} ${verb}（${where}）· ${time}（精确到秒）`;
  const dedupeKey = `acct:${ev.type}:${ev.steamId64 || ''}`;
  const last = recent.get(dedupeKey) || 0;
  if (Date.now() - last < c.minIntervalSec * 1000) return { sent: false, reason: '去重间隔内' };
  recent.set(dedupeKey, Date.now());
  const results = { desktop: null, webhook: null, mail: null, wechat: null, qq: null, dingtalk: null, sms: null };
  if (c.desktop) results.desktop = await toast(title, body, c.sound);
  if (c.webhookUrl) results.webhook = await webhook(title, body, c.webhookUrl, c.webhookType);
  try {
    const r = await mail.send({ name: who, text: body, type: 'account' }, { source: '本机 SteamLens 账号监控' });
    results.mail = { sent: !!r.sent, reason: r.reason || null };
  } catch (e) { results.mail = { sent: false, reason: e.message }; }
  for (const [name, mod] of [['wechat', wechat], ['qq', qq], ['dingtalk', dingtalk]]) {
    try {
      const r = await mod.send(title, body, { kind: 'account', dedupeKey });
      results[name] = { ok: !!r.ok, reason: r.reason || '' };
    } catch (e) { results[name] = { ok: false, reason: e.message }; }
  }
  const rec = { ts: Date.now(), iso: new Date().toISOString(), title, body, type: ev.type, channels: results };
  pushHistory(rec);
  recordOutbox(rec);
  console.log(`[SteamLens 账号通知] ${body}`);
  return { sent: true, ...rec };
}

/**
 * 发送 Steam 家庭动态通知（成员加入 / 退出 / 共享库新增游戏）。
 * @param {object} ev { type:'member-joined'|'member-left'|'new-game', names?, ids?, games? }
 */
async function notifyFamilyEvent(ev, extra = {}) {
  const c = cfg();
  if (!c.enabled && !extra.force) return { sent: false, reason: '通知总开关已关闭' };
  const titleMap = {
    'member-joined': 'SteamLens · 家庭新成员',
    'member-left': 'SteamLens · 家庭成员退出',
    'new-game': 'SteamLens · 家庭共享库新游戏'
  };
  const bodyMap = {
    'member-joined': `家庭新增成员：${ev.names ? ev.names.join('、') : ''}`,
    'member-left': `家庭成员退出了共享家庭：${ev.names ? ev.names.join('、') : ''}`,
    'new-game': `家庭共享库新增 ${ev.games ? ev.games.length : 0} 款游戏${ev.games && ev.games.length ? '：' + ev.games.slice(0, 8).map(g => g.name).join('、') : ''}`
  };
  const title = titleMap[ev.type] || 'SteamLens · 家庭动态';
  const body = bodyMap[ev.type] || '';
  const dedupeKey = `family:${ev.type}:${(ev.ids || []).join(',')}:${(ev.games || []).map(g => g.appid).join(',')}`;
  const last = recent.get(dedupeKey) || 0;
  if (!extra.force && Date.now() - last < c.minIntervalSec * 1000) return { sent: false, reason: '去重间隔内' };
  recent.set(dedupeKey, Date.now());

  const results = { desktop: null, webhook: null, mail: null, wechat: null, qq: null, dingtalk: null, sms: null };
  if (c.desktop) results.desktop = await toast(title, body, c.sound);
  if (c.webhookUrl) results.webhook = await webhook(title, body, c.webhookUrl, c.webhookType);
  if (!extra.force) {
    try {
      const r = await mail.send({ name: body, text: body, type: 'family' }, { source: 'SteamLens 家庭识别' });
      results.mail = { sent: !!r.sent, reason: r.reason || null };
    } catch (e) { results.mail = { sent: false, reason: e.message }; }
    for (const [name, mod] of [['wechat', wechat], ['qq', qq], ['dingtalk', dingtalk]]) {
      try {
        const r = await mod.send(title, body, { kind: 'family', dedupeKey });
        results[name] = { ok: !!r.ok, reason: r.reason || '' };
      } catch (e) { results[name] = { ok: false, reason: e.message }; }
    }
  }
  const rec = { ts: Date.now(), iso: new Date().toISOString(), title, body, type: ev.type, eventType: 'family', channels: results };
  pushHistory(rec);
  recordOutbox(rec);
  console.log(`[SteamLens 家庭通知] ${body}`);
  return { sent: true, ...rec };
}

module.exports = {
  notifyFriendEvent, notifyOnline, testNotification, toast, webhook, notifyAccountEvent, notifyFamilyEvent,
  cfg, getHistory, detectType, getOutbox, recordOutbox
};
