/**
 * SteamLens · 钉钉通知通道（零第三方依赖，只推给你自己的钉钉群）
 *
 * 边界说明：
 *  - 钉钉个人号没有开放给第三方程序「扫码代登录 / 代发消息」的接口，协议模拟会封号，
 *    因此不做。合规等价方案是「钉钉群自定义机器人 Webhook」：
 *    你在钉钉里建一个只有自己的群 → 群设置 → 智能群助手 → 添加自定义机器人 →
 *    复制 Webhook 地址（和可选加签密钥）填到面板。消息单向、别人发不进来。
 *  - 支持钉钉的三种安全设置：自定义关键词 / 加签 HMAC-SHA256 / IP 白名单（白名单在钉钉侧配置）。
 *  - ★ 关键：HTTP 200 不等于送达，必须解析响应里的 errcode === 0（QQ 通道曾踩过这个坑）。
 */
'use strict';

const crypto = require('node:crypto');
const core = require('./steam-core');
const { httpPost } = require('./wechat-core');

const HOME = 'https://open.dingtalk.com/document/robots/custom-robot-access';
const QR = 'assets/dingtalk-qr.png';
const recent = new Map();
const history = [];
const MAX_HISTORY = 60;
const MIN_TEST_GAP_MS = 3000;

function maskKey(k) {
  if (!k) return '';
  if (k.length <= 10) return k.slice(0, 2) + '••••';
  return k.slice(0, 6) + '••••••••' + k.slice(-4);
}
function maskWebhook(u) {
  const m = String(u || '').match(/access_token=([^&\s]+)/i);
  if (m) return String(u).replace(m[1], maskKey(m[1]));
  return u ? String(u).slice(0, 46) + '…' : '';
}

function cfg() {
  const c = core.getConfig();
  return {
    webhook: String(c.dingtalkWebhook || '').trim(),
    secret: String(c.dingtalkSecret || '').trim(),
    keyword: String(c.dingtalkKeyword || '').trim(),
    enabled: c.dingtalkEnabled === true,
    onOnline: c.dingtalkOnOnline !== false,
    onOffline: c.dingtalkOnOffline !== false,
    onWishlist: c.dingtalkOnWishlist !== false,
    minIntervalSec: Math.min(3600, Math.max(0, Number(c.dingtalkMinIntervalSec) || 60))
  };
}

function diagnose(c = cfg()) {
  const out = [];
  if (!c.webhook) out.push({ level: 'error', text: '还没填钉钉机器人 Webhook：在钉钉群 → 智能群助手 → 添加自定义机器人，复制 Webhook 地址。' });
  else if (!/^https:\/\/oapi\.dingtalk\.com\/robot\/send/i.test(c.webhook))
    out.push({ level: 'error', text: 'Webhook 不是钉钉官方地址（应以 https://oapi.dingtalk.com/robot/send?access_token= 开头）。' });
  else if (!/access_token=/i.test(c.webhook))
    out.push({ level: 'error', text: 'Webhook 缺少 access_token 参数，请复制完整地址。' });
  if (!c.secret && !c.keyword)
    out.push({ level: 'warn', text: '未填加签密钥或自定义关键词：如果机器人在钉钉里启用了这两项安全设置，消息会被拒收。' });
  if (!c.enabled) out.push({ level: 'warn', text: '钉钉推送总开关已关闭，测试消息可用，但自动通知不会发。' });
  if (!out.some(x => x.level === 'error')) out.push({ level: 'ok', text: '通道配置完整。点「发一条测试」验证送达。' });
  const last = history.find(x => x.kind === 'test');
  if (last) out.push({ level: last.ok ? 'ok' : 'warn', text: `上次测试：${last.ok ? '已送达' : '未送达 — ' + (last.reason || '未知原因')}（${last.iso}）` });
  return out;
}

function status() {
  const c = cfg();
  const diag = diagnose(c);
  return {
    ok: true,
    connected: c.enabled && !!c.webhook && !diag.some(x => x.level === 'error'),
    ready: !diag.some(x => x.level === 'error'),
    webhookMasked: maskWebhook(c.webhook), webhookSet: !!c.webhook,
    secretMasked: maskKey(c.secret), secretSet: !!c.secret,
    keyword: c.keyword,
    enabled: c.enabled, onOnline: c.onOnline, onOffline: c.onOffline, onWishlist: c.onWishlist,
    minIntervalSec: c.minIntervalSec,
    diagnosis: diag,
    home: HOME, qr: QR,
    direction: '只推到你自己的钉钉群 · 单向 · 不读消息 · 不需要账号密码',
    history: history.slice(0, 20)
  };
}

function signedUrl(webhook, secret) {
  if (!secret) return webhook;
  const ts = Date.now();
  const sign = crypto.createHmac('sha256', secret).update(`${ts}\n${secret}`).digest('base64');
  const join = webhook.includes('?') ? '&' : '?';
  return `${webhook}${join}timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
}

function buildBody(c, title, body) {
  // 自定义关键词安全设置要求消息内容里必须包含关键词
  const prefix = c.keyword ? `${c.keyword} ` : '';
  const text = `${prefix}${title}\n\n${body}\n\n— SteamLens（本机统计）`;
  return JSON.stringify({
    msgtype: 'text',
    text: { content: text },
    // markdown 对部分老版本客户端兼容性略差，text 最稳；同时附带 at 空对象避免误 @
    at: { atMobiles: [], isAtAll: false }
  });
}

function parseResponse(r) {
  const txt = String(r?.response || '').trim();
  let j = null;
  try { j = JSON.parse(txt); } catch {}
  if (/^ERR:/i.test(txt)) return { ok: false, reason: txt.slice(4, 180) };
  if (j) {
    if (j.errcode === 0) return { ok: true, reason: '已送达你的钉钉群' };
    return { ok: false, reason: `钉钉返回 errcode=${j.errcode}：${j.errmsg || '未知错误'}` };
  }
  return { ok: false, reason: txt.slice(0, 160) || `HTTP ${r?.status || '?'} 无有效响应（Webhook 可能失效）` };
}

async function send(title, body, opts = {}) {
  const c = cfg();
  const rec = {
    ts: Date.now(), iso: new Date().toISOString(), title, body,
    kind: opts.kind || 'test', ok: false, reason: ''
  };
  const blocker = diagnose(c).find(x => x.level === 'error');
  if (blocker) { rec.reason = blocker.text; rec.blocked = true; history.unshift(rec); trim(); return rec; }
  if (!c.enabled && !opts.force) { rec.reason = '钉钉推送已关闭'; history.unshift(rec); trim(); return rec; }
  if (opts.kind === 'online' && !c.onOnline && !opts.force) { rec.reason = '未开启「好友上线推送」'; return rec; }
  if (opts.kind === 'offline' && !c.onOffline && !opts.force) { rec.reason = '未开启「好友退出 Steam 推送」'; return rec; }
  if (opts.kind === 'wishlist' && !c.onWishlist && !opts.force) { rec.reason = '未开启「愿望单推送」'; return rec; }

  const dk = opts.dedupeKey || `${opts.kind}:${title}`;
  const now = Date.now();
  const gap = opts.force ? MIN_TEST_GAP_MS : Math.max(MIN_TEST_GAP_MS, c.minIntervalSec * 1000);
  const last = recent.get(dk) || 0;
  if (now - last < gap) {
    rec.reason = `刚刚已发过，${Math.ceil((gap - (now - last)) / 1000)} 秒内不重复推送`;
    rec.throttled = true; history.unshift(rec); trim(); return rec;
  }
  recent.set(dk, now);

  try {
    const r = await httpPost(signedUrl(c.webhook, c.secret), 'json', buildBody(c, title, body));
    const parsed = parseResponse(r);
    rec.ok = parsed.ok; rec.reason = parsed.reason;
    rec.httpStatus = r.status || null; rec.response = String(r.response || '').slice(0, 180);
  } catch (e) { rec.reason = e.message; }
  history.unshift(rec); trim();
  console.log(`[SteamLens 钉钉] ${rec.ok ? '已推送' : '失败：' + rec.reason} · ${title}`);
  return rec;
}
function trim() { if (history.length > MAX_HISTORY) history.length = MAX_HISTORY; }

function saveConfig(patch = {}) {
  // 兼容两种字段名：面板自动保存用 dingtalkXxx，登录表单用简称
  const p = {
    webhook: patch.webhook ?? patch.dingtalkWebhook,
    secret: patch.secret ?? patch.dingtalkSecret,
    keyword: patch.keyword ?? patch.dingtalkKeyword,
    enabled: patch.enabled ?? patch.dingtalkEnabled,
    onOnline: patch.onOnline ?? patch.dingtalkOnOnline,
    onOffline: patch.onOffline ?? patch.dingtalkOnOffline,
    onWishlist: patch.onWishlist ?? patch.dingtalkOnWishlist,
    minIntervalSec: patch.minIntervalSec ?? patch.dingtalkMinIntervalSec
  };
  const allowed = {};
  if (p.webhook !== undefined) {
    const v = String(p.webhook).trim();
    if (v && !/••/.test(v)) allowed.dingtalkWebhook = v;
  }
  if (p.secret !== undefined) {
    const v = String(p.secret).trim();
    if (v && !/••/.test(v)) allowed.dingtalkSecret = v;
    else if (!v) allowed.dingtalkSecret = '';
  }
  if (p.keyword !== undefined) allowed.dingtalkKeyword = String(p.keyword).trim().slice(0, 40);
  if (p.enabled !== undefined) allowed.dingtalkEnabled = !!p.enabled;
  if (p.onOnline !== undefined) allowed.dingtalkOnOnline = !!p.onOnline;
  if (p.onOffline !== undefined) allowed.dingtalkOnOffline = !!p.onOffline;
  if (p.onWishlist !== undefined) allowed.dingtalkOnWishlist = !!p.onWishlist;
  if (p.minIntervalSec !== undefined) allowed.dingtalkMinIntervalSec = Math.min(3600, Math.max(0, Number(p.minIntervalSec) || 60));
  if (Object.keys(allowed).length) core.saveConfig(allowed);
  return allowed;
}

async function connect(patch = {}) {
  const applied = saveConfig({ ...patch, enabled: true });
  const diag = diagnose();
  let test = null;
  if (patch.verify !== false && !diag.some(x => x.level === 'error')) {
    test = await send('SteamLens · 钉钉绑定成功',
      '这条消息只推到你自己的钉钉群。之后好友上线、愿望单降价或回涨时，会自动推送到这里。',
      { kind: 'test', force: true });
  }
  return { ok: true, applied, test, blocked: !test, diagnosis: diag, status: status() };
}

function disconnect() {
  core.saveConfig({ dingtalkEnabled: false, dingtalkWebhook: '', dingtalkSecret: '' });
  return { ok: true, status: status() };
}

async function test() {
  return send('SteamLens · 测试推送', '这是一条测试消息，确认钉钉通道能正常送达。', { kind: 'test', force: true });
}

module.exports = { cfg, status, send, connect, disconnect, test, saveConfig, diagnose, HOME, QR };
