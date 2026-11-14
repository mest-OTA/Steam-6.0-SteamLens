/**
 * SteamLens · 微信推送通道（零第三方依赖，只发给你自己）
 *
 * 边界说明：
 *  - 微信个人号没有开放给第三方程序的登录 / 发消息接口，"文件传输助手"也没有公开 API。
 *    模拟协议登录会封号、并让聊天记录暴露给本地程序，因此不做。
 *  - 合规等价方案：你在官方页用微信扫码绑定一个「只属于你」的推送通道，
 *    得到一个 Key 存在本机。之后 SteamLens 只能【单向推送】到你自己的微信，
 *    别人无法向这个通道发消息，程序也不读取任何聊天记录 / 好友 / 文件。
 *  - 效果与「给自己发一条消息」一致：好友上线、愿望单降价/回涨都会出现在你的微信里。
 *
 * 支持：Server酱³(sctapi.ftqq.com) / PushPlus / 企业微信群机器人 / 自定义 Webhook
 */
'use strict';

const { execFile } = require('node:child_process');
const core = require('./steam-core');

const CHANNELS = {
  serverchan: { name: 'Server酱³ · 微信扫码绑定', home: 'https://sct.ftqq.com/', hint: '微信扫码登录后复制 SendKey（SCT 开头）' },
  pushplus: { name: 'PushPlus · 微信扫码绑定', home: 'https://www.pushplus.plus/', hint: '微信扫码登录后复制 token（32 位）' },
  wecom: { name: '企业微信群机器人', home: 'https://work.weixin.qq.com/', hint: '群机器人 Webhook 里 key= 后面那串' },
  custom: { name: '自定义 Webhook', home: '', hint: '填完整 URL，收到 JSON {title, body, text}' }
};

const recent = new Map();
const history = [];
const MAX_HISTORY = 60;

function cfg() {
  const c = core.getConfig();
  const ch = CHANNELS[c.wechatChannel] ? c.wechatChannel : 'serverchan';
  return {
    channel: ch,
    key: String(c.wechatKey || '').trim(),
    enabled: c.wechatEnabled === true,
    onOnline: c.wechatOnOnline !== false,
    onOffline: c.wechatOnOffline !== false,
    onWishlist: c.wechatOnWishlist !== false,
    minIntervalSec: Math.min(3600, Math.max(0, Number(c.wechatMinIntervalSec) || 60))
  };
}

function maskKey(k) {
  if (!k) return '';
  if (k.length <= 8) return k.slice(0, 2) + '••••';
  return k.slice(0, 4) + '••••••••' + k.slice(-4);
}

function status() {
  const c = cfg();
  const connected = c.enabled && !!c.key;
  return {
    ok: true,
    connected,
    channel: c.channel,
    channelName: CHANNELS[c.channel].name,
    home: CHANNELS[c.channel].home,
    hint: CHANNELS[c.channel].hint,
    keyMasked: maskKey(c.key),
    keySet: !!c.key,
    enabled: c.enabled,
    onOnline: c.onOnline,
    onOffline: c.onOffline,
    onWishlist: c.onWishlist,
    minIntervalSec: c.minIntervalSec,
    direction: '只发给你自己 · 单向推送 · 不收消息 · 不读聊天记录',
    history: history.slice(0, 20),
    channels: Object.entries(CHANNELS).map(([id, v]) => ({ id, name: v.name, home: v.home, hint: v.hint }))
  };
}

/* ------------------------------ 发送 ------------------------------ */

function targetFor(c) {
  const k = encodeURIComponent(c.key);
  if (c.channel === 'serverchan') return `https://sctapi.ftqq.com/${c.key}.send`;
  if (c.channel === 'pushplus') return 'https://www.pushplus.plus/send';
  if (c.channel === 'wecom') return `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${k}`;
  return c.key; // custom: key 本身就是完整 URL
}

function payloadFor(c, title, body) {
  const text = `${title}\n\n${body}`;
  if (c.channel === 'serverchan') {
    return { type: 'form', body: new URLSearchParams({ title, desp: body }).toString() };
  }
  if (c.channel === 'pushplus') {
    return { type: 'json', body: JSON.stringify({ token: c.key, title, content: body, template: 'txt' }) };
  }
  if (c.channel === 'wecom') {
    return { type: 'json', body: JSON.stringify({ msgtype: 'text', text: { content: text } }) };
  }
  return { type: 'json', body: JSON.stringify({ title, body, text, source: 'SteamLens', ts: Date.now() }) };
}

async function httpPost(url, type, body) {
  const headers = { 'Content-Type': type === 'form' ? 'application/x-www-form-urlencoded' : 'application/json' };
  try {
    const r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15000) });
    const txt = await r.text().catch(() => '');
    return { ok: r.ok, status: r.status, response: txt.slice(0, 300) };
  } catch (primary) {
    if (process.platform !== 'win32') throw primary;
    // Node 出站受限时回退到 Windows WinHTTP 栈
    const b64 = Buffer.from(body, 'utf8').toString('base64');
    const uB64 = Buffer.from(url, 'utf8').toString('base64');
    const ps = `$ErrorActionPreference='Stop'; `
      + `$u=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${uB64}')); `
      + `$b=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); `
      + `$ct='${headers['Content-Type']}'; `
      + `try { $r=Invoke-WebRequest -UseBasicParsing -Uri $u -Method POST -ContentType $ct -Body $b -TimeoutSec 20; Write-Output $r.Content } `
      + `catch { Write-Output ('ERR:' + $_.Exception.Message) }`;
    return new Promise(resolve => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { timeout: 28000, windowsHide: true, maxBuffer: 1024 * 1024 },
        (err, so) => {
          if (err) return resolve({ ok: false, reason: err.message });
          const out = String(so).trim();
          resolve({ ok: !out.startsWith('ERR:'), response: out.slice(0, 300), fallback: 'WinHTTP' });
        });
    });
  }
}

/**
 * 推送一条消息到用户自己的微信。
 * @param {string} title
 * @param {string} body
 * @param {object} opts { kind: 'online'|'wishlist'|'test', force, dedupeKey }
 */
async function send(title, body, opts = {}) {
  const c = cfg();
  const rec = { ts: Date.now(), iso: new Date().toISOString(), title, body, kind: opts.kind || 'test', ok: false, reason: '' };
  if (!c.key) { rec.reason = '未绑定推送 Key'; history.unshift(rec); return rec; }
  if (!c.enabled && !opts.force) { rec.reason = '微信推送已关闭'; history.unshift(rec); return rec; }
  if (opts.kind === 'online' && !c.onOnline && !opts.force) { rec.reason = '未开启「好友上线推送」'; return rec; }
  if (opts.kind === 'offline' && !c.onOffline && !opts.force) { rec.reason = '未开启「好友退出 Steam 推送」'; return rec; }
  if (opts.kind === 'wishlist' && !c.onWishlist && !opts.force) { rec.reason = '未开启「愿望单推送」'; return rec; }

  const dk = opts.dedupeKey || `${opts.kind}:${title}`;
  const last = recent.get(dk) || 0;
  if (!opts.force && Date.now() - last < c.minIntervalSec * 1000) {
    rec.reason = '去重间隔内'; return rec;
  }
  recent.set(dk, Date.now());

  try {
    const p = payloadFor(c, title, body);
    const r = await httpPost(targetFor(c), p.type, p.body);
    rec.ok = !!r.ok;
    rec.reason = r.ok ? '已发送到你的微信' : (r.response || `HTTP ${r.status || '?'}`);
    rec.channel = c.channel;
  } catch (e) { rec.reason = e.message; }
  history.unshift(rec);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  console.log(`[SteamLens 微信] ${rec.ok ? '已推送' : '失败：' + rec.reason} · ${title}`);
  return rec;
}

/* ------------------------------ 绑定 / 解绑 ------------------------------ */

function saveConfig(patch) {
  const allowed = {};
  if (patch.channel !== undefined && CHANNELS[patch.channel]) allowed.wechatChannel = patch.channel;
  if (patch.enabled !== undefined) allowed.wechatEnabled = !!patch.enabled;
  if (patch.onOnline !== undefined) allowed.wechatOnOnline = !!patch.onOnline;
  if (patch.onOffline !== undefined) allowed.wechatOnOffline = !!patch.onOffline;
  if (patch.onWishlist !== undefined) allowed.wechatOnWishlist = !!patch.onWishlist;
  if (patch.minIntervalSec !== undefined) allowed.wechatMinIntervalSec = Math.min(3600, Math.max(0, Number(patch.minIntervalSec) || 60));
  // Key：留空表示沿用已保存的（避免重进时把绑定清空）
  if (patch.key !== undefined && String(patch.key).trim()) allowed.wechatKey = String(patch.key).trim();
  if (Object.keys(allowed).length) core.saveConfig(allowed);
  return allowed;
}

async function connect(patch = {}) {
  const applied = saveConfig({ ...patch, enabled: true });
  let test = null;
  if (patch.verify !== false) {
    test = await send('SteamLens · 微信绑定成功', '这条消息只发给你自己。之后好友上线、愿望单降价或回涨时，会自动推送到这里。', { kind: 'test', force: true });
  }
  return { ok: true, applied, test, status: status() };
}

function disconnect() {
  core.saveConfig({ wechatEnabled: false, wechatKey: '' });
  return { ok: true, status: status() };
}

async function test() {
  return send('SteamLens · 测试推送', '这是一条测试消息，确认微信通道能正常送达。', { kind: 'test', force: true });
}

module.exports = { CHANNELS, cfg, status, send, connect, disconnect, test, saveConfig, httpPost };
