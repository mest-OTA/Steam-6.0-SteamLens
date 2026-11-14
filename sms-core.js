/**
 * SteamLens · 手机号通知（短信）
 *
 * 边界说明（很重要，别假装能做到做不到的事）：
 *  - 本地程序无法"登录手机号"直接发短信。短信必须由运营商 / 短信服务商下发，
 *    所以这里接的是一个「短信网关 Webhook」：POST JSON {phone, text, event, token}。
 *    这个地址可以是腾讯云 / 阿里云短信 API 外面包的一层转发，也可以是你自己的服务。
 *  - 没填手机号或网关时：所有开关照常保存，但一条短信都不会发、不会产生费用。
 *  - 分类开关按事件拦截；一键关闭直接关总开关。发送记录落盘，方便核对短信条数。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const core = require('./steam-core');
const { httpPost } = require('./wechat-core');

const HISTORY_FILE = path.join(__dirname, 'data', 'sms-history.json');

const EVENTS = [
  { id: 'friendOnline', label: '好友上线', group: '好友' },
  { id: 'friendOffline', label: '好友退出 Steam', group: '好友' },
  { id: 'wishlistDrop', label: '愿望单降价（跌破提醒线）', group: '愿望单' },
  { id: 'wishlistRebound', label: '愿望单回涨（涨回提醒线）', group: '愿望单' },
  { id: 'watchlistPrice', label: '监控清单降价 / 达到目标折扣', group: '愿望单' },
  { id: 'watchlistRelease', label: '游戏正式上线 / 测试版上线', group: '愿望单' }
];
const EVENT_IDS = EVENTS.map(e => e.id);

function defaultEvents() {
  const out = {};
  for (const id of EVENT_IDS) out[id] = true;
  return out;
}
function readJson(f, fallback) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } }
function writeJson(f, obj) {
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj, null, 2), 'utf8'); } catch { /* 不阻塞通知 */ }
}
function maskPhone(p) {
  const s = String(p || '').trim();
  if (s.length < 7) return s ? '***' : '';
  return s.slice(0, 3) + '****' + s.slice(-4);
}
function cfg() {
  const c = core.getConfig();
  const saved = (c.smsEvents && typeof c.smsEvents === 'object' && !Array.isArray(c.smsEvents)) ? c.smsEvents : {};
  const events = defaultEvents();
  for (const id of EVENT_IDS) if (typeof saved[id] === 'boolean') events[id] = saved[id];
  return {
    phone: String(c.smsPhone || '').trim(),
    webhook: String(c.smsWebhook || '').trim(),
    token: String(c.smsToken || '').trim(),
    enabled: c.smsEnabled !== false,
    events
  };
}
function history() { const a = readJson(HISTORY_FILE, []); return Array.isArray(a) ? a.slice(0, 50) : []; }
function pushHistory(rec) {
  const a = history();
  a.unshift(rec);
  writeJson(HISTORY_FILE, a.slice(0, 50));
}
function labelOf(id) { return (EVENTS.find(e => e.id === id) || {}).label || id; }

function status() {
  const c = cfg();
  const h = history();
  const on = EVENT_IDS.filter(id => c.events[id]).length;
  return {
    ok: true,
    configured: !!(c.phone && c.webhook),
    phoneMasked: maskPhone(c.phone),
    webhookSet: !!c.webhook,
    enabled: c.enabled,
    events: c.events,
    eventList: EVENTS,
    onCount: on, totalEvents: EVENT_IDS.length,
    history: h.slice(0, 20),
    sentCount: h.filter(x => x.ok).length,
    estimatedSms: h.filter(x => x.ok).reduce((n, x) => n + (Number(x.smsCount) || 1), 0),
    note: '程序不能凭手机号直接发短信：需要填一个短信网关 Webhook（服务商或你自己的转发地址）。未配置时不发送、不扣费。'
  };
}

function saveConfig(patch = {}) {
  const p = {};
  if (patch.phone !== undefined) {
    const raw = String(patch.phone || '').trim().replace(/[\s-]/g, '');
    if (raw && !/^\+?\d{5,20}$/.test(raw)) return { ok: false, error: '手机号格式不对（只填数字，可带 +86）' };
    p.smsPhone = raw;
  }
  if (patch.webhook !== undefined) {
    const raw = String(patch.webhook || '').trim();
    if (raw && !/^https?:\/\//i.test(raw)) return { ok: false, error: '短信网关地址要以 http:// 或 https:// 开头' };
    p.smsWebhook = raw;
  }
  if (patch.token !== undefined) p.smsToken = String(patch.token || '').trim();
  if (patch.enabled !== undefined) p.smsEnabled = !!patch.enabled;
  core.saveConfig(p);
  return { ok: true, status: status() };
}

function setEvent(id, enabled) {
  if (!EVENT_IDS.includes(id)) return { ok: false, error: '没有这个通知类别' };
  const c = cfg();
  const events = { ...c.events, [id]: !!enabled };
  core.saveConfig({ smsEvents: events });
  return { ok: true, id, enabled: !!enabled, status: status() };
}

/** 一键关闭 / 一键开启：总开关 + 全部类别一起切换 */
function setAll(enabled) {
  const on = !!enabled;
  const events = defaultEvents();
  if (!on) for (const id of EVENT_IDS) events[id] = false;
  core.saveConfig({ smsEnabled: on, smsEvents: events });
  return { ok: true, enabled: on, status: status() };
}

/** 每条通知都会先过这里：关掉的类别 / 未配置网关一律不发，也不计入费用 */
async function send(event, text, opts = {}) {
  const c = cfg();
  const body = String(text || '').trim().slice(0, 500);
  const skip = reason => ({ ok: false, skipped: true, reason, event, label: labelOf(event) });
  if (!c.enabled) return skip('短信总开关已关闭');
  if (!c.events[event]) return skip(`「${labelOf(event)}」短信已关闭`);
  if (!c.phone || !c.webhook) return skip('未配置手机号或短信网关');
  if (!body) return skip('通知内容为空');

  const payload = JSON.stringify({
    phone: c.phone, text: body, event, label: labelOf(event),
    token: c.token, ts: Date.now(), source: opts.source || 'SteamLens'
  });
  let r;
  try { r = await httpPost(c.webhook, 'json', payload); }
  catch (e) { r = { ok: false, reason: e.message }; }
  const ok = !!r.ok;
  const rec = {
    ts: Date.now(), iso: new Date().toISOString(),
    event, label: labelOf(event), text: body.slice(0, 120),
    phoneMasked: maskPhone(c.phone), ok,
    reason: ok ? '' : String(r.reason || r.response || '网关返回失败').slice(0, 160),
    chars: body.length, smsCount: Math.max(1, Math.ceil(body.length / 70))
  };
  pushHistory(rec);
  return rec;
}

async function test() {
  const c = cfg();
  if (!c.phone || !c.webhook) return { ok: false, reason: '先填手机号与短信网关地址并保存' };
  if (!c.enabled) return { ok: false, reason: '短信总开关已关闭，先一键开启' };
  const r = await send('friendOnline', 'SteamLens 测试短信：手机号通知已接通。', { source: 'test' });
  return { ...r, status: status() };
}

module.exports = { EVENTS, cfg, status, statusView: status, saveConfig, setEvent, setAll, send, test, history };
